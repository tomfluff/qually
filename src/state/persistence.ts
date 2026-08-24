// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The project's autosave home: IndexedDB, written through a short debounce.
//
// It used to be localStorage via createJSONStorage, and that had two cliffs at
// real study sizes (20 transcripts × 1000 lines ≈ a 5 MB project):
//   1. zustand's persist runs its storage on EVERY set() — so every click,
//      keystroke and drag-move paid a full JSON.stringify of the whole project
//      (~20 ms) plus a synchronous quota-checked setItem (~15 ms), several
//      times per gesture. That WAS the app feeling slow.
//   2. localStorage caps at 5–10 MB depending on the browser; a 20-transcript
//      project sits at or past the cap, and past it autosave just fails.
// IndexedDB stores the envelope by structured clone (no stringify at all), off
// the main thread, with a quota measured in gigabytes. The debounce means at
// most one write per 500 ms burst; pagehide/hidden flush covers the tab going
// away mid-burst.
//
// This module deliberately imports nothing from the store (the store imports
// it), so hydration state is pushed in via markHydrated() from the store's
// onRehydrateStorage hook, and save-health is pushed out via the onSaveResult
// callback the store registers.
import type { PersistStorage, StorageValue } from "zustand/middleware";

const DB = "qually";
const OBJ = "kv";

// ONE connection, opened at hydration and kept. Two reasons, both load-bearing:
//   1. pagehide durability — a put() ISSUED before teardown survives it, but an
//      indexedDB.open still waiting on its onsuccess does not. With the
//      connection already open, flush() reaches put() in a microtask inside the
//      pagehide task itself.
//   2. write ordering — every transaction is created in call order on one
//      connection, so the legacy-migration write can never land AFTER a newer
//      debounced state write and resurrect old state.
let dbp: Promise<IDBDatabase> | null = null;
const openDb = (): Promise<IDBDatabase> =>
  (dbp ??= new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(OBJ);
    rq.onsuccess = () => {
      const db = rq.result;
      db.onclose = () => { dbp = null; }; // browser evicted it — reopen on next use
      res(db);
    };
    rq.onerror = () => { dbp = null; rej(rq.error); };
  }));

const idbGet = (key: string): Promise<unknown> =>
  openDb().then((db) => new Promise((res, rej) => {
    const rq = db.transaction(OBJ).objectStore(OBJ).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));

const idbSet = (key: string, value: unknown): Promise<void> =>
  openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(OBJ, "readwrite");
    tx.objectStore(OBJ).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));

const idbDel = (key: string): Promise<void> =>
  openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(OBJ, "readwrite");
    tx.objectStore(OBJ).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));

/** the store tells us when hydration finished; until then, writes are dropped —
    a boot-time set() must never overwrite the saved project with fresh state */
let hydrated = false;
/** the read didn't just come back EMPTY, it came back BROKEN (threw, or never
    answered). The two must never be confused: an empty read is a first run and
    the workspace should save normally, but a broken read means a project we
    could not see is still sitting in there — and letting an empty store write
    over it would destroy the researcher's work to no purpose. So the write gate
    stays shut for the session, and the banner says saving is not happening. */
let readFailed = false;
let hydrateAnnounced = false; // markHydrated already ran (a late all-clear must finish its job)
export const markHydrated = () => {
  hydrateAnnounced = true;
  if (readFailed) { onSaveResult(false); return; }
  hydrated = true;
};
/** A read that TIMED OUT may still answer. If the answer is "empty", nothing
    was hidden after all — this was a slow first run, not a broken one, and
    keeping the gate shut would leave a brand-new user unable to save for the
    whole session. A late VALUE keeps the gate shut: a project we failed to
    show IS in there. */
const recoverIfEmpty = (v: unknown) => {
  if (v !== undefined || !readFailed) return;
  readFailed = false;
  if (hydrateAnnounced) { hydrated = true; onSaveResult(true); }
};

/** the store's ear on save health (drives the App's autosave-failing banner) */
let onSaveResult: (ok: boolean) => void = () => {};
export const setOnSaveResult = (fn: (ok: boolean) => void) => { onSaveResult = fn; };

// Throttle-with-trailing-edge, not a pure debounce: the timer starts at the
// FIRST write of a burst, so a long drag still lands a write every 500 ms
// instead of postponing forever.
let pending: { key: string; value: unknown } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 500;

const flush = () => {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending) return;
  const { key, value } = pending;
  pending = null;
  idbSet(key, value).then(() => onSaveResult(true), () => onSaveResult(false));
};

// The tab can go away mid-burst; both fire before the page is actually gone.
// (An in-flight IndexedDB transaction survives page teardown once issued.)
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}

/** read the raw persisted envelope (CrashScreen's last-resort export) */
export const readRawState = async (key: string): Promise<unknown> => {
  try {
    const v = await idbGet(key);
    if (v !== undefined) return v;
  } catch { /* fall through to the legacy copy */ }
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
};

/** drop the persisted state entirely (CrashScreen's reset) — both homes */
export const dropRawState = async (key: string): Promise<void> => {
  pending = null;
  if (timer) { clearTimeout(timer); timer = null; } // a queued flush must not resurrect what we just dropped
  try { localStorage.removeItem(key); } catch { /* nothing to drop */ }
  try { await idbDel(key); } catch { /* ditto */ }
};

const idbStorage: PersistStorage<unknown> = {
  // getItem must NEVER reject: on a rejected hydration zustand's persist never
  // sets hasHydrated and never fires the finish-hydration listeners, so the
  // Hydrated gate in main.tsx would hold the app at a blank screen forever —
  // on every launch. An unreadable store boots empty (and the saveFailed
  // banner surfaces any write trouble) rather than never booting at all.
  getItem: async (key) => {
    try {
      // the race guards boot against an IndexedDB that never answers (a hung
      // or blocked open) — same blank-forever failure as a rejection
      const v = await Promise.race([idbGet(key),
        new Promise((_, rej) => setTimeout(() => rej(new Error("IndexedDB read timed out")), 3000))]);
      if (v !== undefined) return v as StorageValue<unknown>;
    } catch {
      readFailed = true;
      idbGet(key).then(recoverIfEmpty, () => { /* still broken — gate stays shut */ });
      /* fall through to the legacy copy */
    }
    try {
      // one-time migration: a project saved by a localStorage build moves over,
      // and the legacy key is removed only after the IndexedDB copy has landed
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StorageValue<unknown>;
      readFailed = false; // the legacy copy answered — nothing is hidden from us
      idbSet(key, parsed).then(() => localStorage.removeItem(key)).catch(() => { /* keep the legacy copy */ });
      return parsed;
    } catch { readFailed = true; return null; }
  },
  setItem: (key, value) => {
    if (!hydrated) return;
    pending = { key, value };
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  },
  removeItem: (key) => { void dropRawState(key); },
};

// vitest/jsdom has no indexedDB — keep the old synchronous localStorage path
// there so tests hydrate synchronously and exercise the same store code.
const jsonStorage: PersistStorage<unknown> = {
  getItem: (key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StorageValue<unknown>) : null;
  },
  setItem: (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); onSaveResult(true); }
    catch { onSaveResult(false); }
  },
  removeItem: (key) => localStorage.removeItem(key),
};

export const projectStorage: PersistStorage<unknown> =
  typeof indexedDB === "undefined" ? jsonStorage : idbStorage;
