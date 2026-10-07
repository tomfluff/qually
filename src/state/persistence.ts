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
//
// Several projects live side by side, one envelope each. The project an older
// build saved KEEPS its key (FIRST_KEY), so upgrading moves no data at all; the
// rest are FIRST_KEY + ":" + id. Which one is open, and what the list says about
// each, is one small INDEX record. The list itself is derived from the envelope
// keys actually present, not from the index, so a lost or stale index can never
// hide a project.
import type { PersistStorage, StorageValue } from "zustand/middleware";

const DB = "qually";
const OBJ = "kv";
export const FIRST_KEY = "coding-app-state";
const INDEX = "qually-projects";
const isProjectKey = (k: unknown): k is string =>
  typeof k === "string" && (k === FIRST_KEY || k.startsWith(FIRST_KEY + ":"));

/** what the project list shows for a project it is not currently holding */
interface Meta { name: string; transcripts: number; used: number }
let index: { active: string; meta: Record<string, Meta> } = { active: FIRST_KEY, meta: {} };
/** the envelope key every autosave goes to — the open project's */
export const activeKey = () => index.active;
// The one place this module reads the project's shape: the list's name and count.
const metaOf = (value: unknown): Meta => {
  const st = (value as { state?: { projectName?: unknown; transcripts?: object } } | null)?.state;
  return { name: typeof st?.projectName === "string" ? st.projectName : "",
    transcripts: Object.keys(st?.transcripts ?? {}).length, used: Date.now() };
};

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

/** puts and deletes in ONE transaction: an envelope and its index entry land
    (or fail) together. Blind puts only, issued synchronously — a get-then-put
    needs a callback after the get, and a pagehide flush can't count on one
    running. The index is cloned when put() runs, so a later put always carries
    the later index. */
const idbWrite = (puts: [string, unknown][], dels: string[] = []): Promise<void> =>
  openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(OBJ, "readwrite");
    for (const [k, v] of puts) tx.objectStore(OBJ).put(v, k);
    for (const k of dels) tx.objectStore(OBJ).delete(k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error); // a quota failure aborts at commit with no error event
  }));

const idbKeys = (): Promise<IDBValidKey[]> =>
  openDb().then((db) => new Promise((res, rej) => {
    const rq = db.transaction(OBJ).objectStore(OBJ).getAllKeys();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));

/** boot's read: the index's pointer first, then the envelope it names */
let adopt = true; // cleared when boot's read times out — see below
const readActive = async (): Promise<unknown> => {
  const ix = (await idbGet(INDEX)) as { active?: unknown; meta?: unknown } | undefined;
  const key = ix && isProjectKey(ix.active) ? ix.active : index.active;
  if (adopt)
    index = { active: key, meta: ix?.meta && typeof ix.meta === "object" ? ix.meta as Record<string, Meta> : {} };
  // A LATE answer (boot already timed out and hydrated) must not change which
  // project is open under the store that booted — and one naming another
  // project can't prove ours empty, so it keeps the write gate shut.
  else if (key !== index.active) return null;
  return idbGet(index.active);
};

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

let lastSave: Promise<void> = Promise.resolve(); // the newest envelope write
const flush = () => {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending) return;
  const { key, value } = pending;
  pending = null;
  index.meta[key] = metaOf(value);
  lastSave = idbWrite([[key, value], [INDEX, index]]);
  lastSave.then(() => onSaveResult(true), () => onSaveResult(false));
};
/** Write the open project now and see it land. An envelope is a whole
    snapshot, so the newest write succeeding means everything is on disk;
    rejects when it failed. Edits made while it was landing go round again —
    queued, or already sent by the debounce timer — so it resolves only once
    the newest write has landed and nothing is pending; the caller's
    continuation then runs before any further event can queue more. */
export const saveNow = async () => {
  for (;;) {
    flush();
    const p = lastSave;
    await p;
    if (!pending && p === lastSave) return;
  }
};

/** CrashScreen's reset: nothing more is written this session. A write landing
    after the drop (a save-health flag flip, the pagehide flush) would bring the
    project straight back. */
export const stopSaving = () => { hydrated = false; };

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

/** drop one project's persisted state entirely, both homes (CrashScreen's
    reset; deleting a project from the list) */
export const dropRawState = async (key: string): Promise<void> => {
  // a queued flush must not resurrect what we just dropped — but only THIS
  // project's: dropping another must not cost the open project its edits
  if (pending?.key === key) pending = null;
  try { localStorage.removeItem(key); } catch { /* nothing to drop */ }
  if (typeof indexedDB === "undefined") return;
  const meta = { ...index.meta };
  delete meta[key];
  await idbWrite([[INDEX, { ...index, meta }]], [key]); // a failure is the caller's to report
  delete index.meta[key];
};

// ── several projects ──────────────────────────────────────────────────────
// They need IndexedDB (localStorage's 5–10 MB barely holds one study) and an
// OPEN write gate: shut, it means a project we could not read is still in
// there, and creating or switching would start writing around it.
export const projectsAvailable = () => typeof indexedDB !== "undefined" && hydrated;

export interface ProjectEntry { key: string; name: string; transcripts: number | null; used: number | null }
/** every project in this browser, oldest first (keys sort by creation) */
export const listProjects = async (): Promise<ProjectEntry[]> => {
  const keys = new Set(typeof indexedDB === "undefined" ? [] : (await idbKeys()).filter(isProjectKey));
  keys.add(index.active); // a brand-new project has no envelope until its first write
  return [...keys].sort().map((key) => {
    const m = index.meta[key];
    return { key, name: m?.name ?? "", transcripts: m?.transcripts ?? null, used: m?.used ?? null };
  });
};

/** another project's envelope: undefined = never written; THROWS when unreadable */
export const readProject = (key: string): Promise<StorageValue<unknown> | undefined> =>
  Promise.race([idbGet(key) as Promise<StorageValue<unknown> | undefined>,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("IndexedDB read timed out")), 3000))]);

export const newProjectKey = () =>
  `${FIRST_KEY}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Point autosave at another project. Synchronous on purpose: the project being
    left is flushed under ITS key first, and the caller swaps the store's state
    in the same tick, so no write can pair one project's state with the other's
    key. */
export const enterProject = (key: string) => {
  flush();
  index.active = key;
  // failure only: the pointer landing says nothing about any project's edits
  idbWrite([[INDEX, index]]).catch(() => onSaveResult(false));
};

const idbStorage: PersistStorage<unknown> = {
  // getItem must NEVER reject: on a rejected hydration zustand's persist never
  // sets hasHydrated and never fires the finish-hydration listeners, so the
  // Hydrated gate in main.tsx would hold the app at a blank screen forever —
  // on every launch. An unreadable store boots empty (and the saveFailed
  // banner surfaces any write trouble) rather than never booting at all.
  // persist's name is FIRST_KEY; WHICH project opens is the index's business
  getItem: async () => {
    try {
      // the race guards boot against an IndexedDB that never answers (a hung
      // or blocked open) — same blank-forever failure as a rejection
      const v = await Promise.race([readActive(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("IndexedDB read timed out")), 3000))]);
      readFailed = false;
      if (v !== undefined) return v as StorageValue<unknown>;
    } catch {
      readFailed = true;
      adopt = false; // the store is about to boot: which project that is, is settled
      readActive().then(recoverIfEmpty, () => { /* still broken — gate stays shut */ });
      /* fall through to the legacy copy */
    }
    const key = index.active; // only FIRST_KEY ever had a legacy copy
    try {
      // one-time migration: a project saved by a localStorage build moves over,
      // and the legacy key is removed only after the IndexedDB copy has landed
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StorageValue<unknown>;
      // A legacy copy can keep the workspace usable, but it cannot prove a
      // failed authoritative read was empty or older, so it does not reopen
      // the write gate by itself.
      // Only over a read that came back EMPTY: when it failed, a newer copy may
      // be sitting there unseen, and this would write the older one over it.
      if (!readFailed)
        idbWrite([[key, parsed]]).then(() => localStorage.removeItem(key)).catch(() => { /* keep the legacy copy */ });
      return parsed;
    } catch {
      // localStorage is only an optional migration source. If the authoritative
      // IndexedDB read succeeded empty, a blocked legacy probe must not turn a
      // healthy first run into a session whose write gate never opens. When the
      // IndexedDB read failed, `readFailed` is already true above.
      return null;
    }
  },
  setItem: (_name, value) => {
    if (!hydrated) return;
    // A pending write is never REPLACED by another project's: it goes out
    // under its own key first. (enterProject already flushed; this is the
    // invariant itself, not the hope that every caller remembers.)
    if (pending && pending.key !== index.active) flush();
    pending = { key: index.active, value };
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  },
  removeItem: () => { void dropRawState(index.active); },
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
