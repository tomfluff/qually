// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Several projects in one browser, through the real store and the real
// IndexedDB adapter over an in-memory IndexedDB: the upgrade from a single
// saved project, and every move between projects landing each project's
// writes under its own key.
import { afterEach, expect, it, vi } from "vitest";

const FIRST = "coding-app-state";

interface Faults {
  broken?: Set<string>;       // reads of these keys fail
  failing?: Set<string>;      // writes (put/delete) of these keys fail, and their transaction with them
  full?: boolean;             // a full disk: every put fails, deletes still work
  slow?: Map<string, number>; // reads AND writes of these keys answer after this many ms
}

// One Map behind a minimal IndexedDB: values are cloned in and out like the
// real thing, and requests answer in creation order, one microtask each. A
// failed write fails its whole transaction and lands nothing.
function fakeIdb(data: Map<string, unknown>, f: Faults = {}) {
  const db = {
    onclose: null,
    transaction: () => {
      const tx: Record<string, unknown> & { oncomplete?: () => void; onerror?: () => void } = { error: null };
      let open = 0, failed = false;
      const staged: (() => void)[] = [];
      const req = (fn: () => unknown, ms = 0) => {
        open++;
        const r: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        const answer = () => {
          try { r.result = fn(); r.onsuccess?.(); } catch (e) { failed = true; r.error = e; r.onerror?.(); }
          if (--open === 0) queueMicrotask(() => {
            if (failed) { tx.error = new DOMException("write failed", "QuotaExceededError"); tx.onerror?.(); return; }
            staged.forEach((w) => w());
            tx.oncomplete?.();
          });
        };
        if (ms) setTimeout(answer, ms); else queueMicrotask(answer);
        return r;
      };
      const write = (k: string, w: () => void, put = true) => req(() => {
        if (f.failing?.has(k) || (put && f.full)) throw new DOMException("write failed", "QuotaExceededError");
        staged.push(w);
      }, f.slow?.get(k));
      const store = {
        get: (k: string) => req(() => {
          if (f.broken?.has(k)) throw new DOMException("unreadable", "UnknownError");
          return structuredClone(data.get(k));
        }, f.slow?.get(k)),
        getAllKeys: () => req(() => [...data.keys()]),
        put: (v: unknown, k: string) => { const c = structuredClone(v); return write(k, () => data.set(k, c)); },
        delete: (k: string) => write(k, () => data.delete(k), false),
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    open: () => {
      const r: { result?: unknown; onsuccess?: () => void } = {};
      queueMicrotask(() => { r.result = db; r.onsuccess?.(); });
      return r;
    },
  } as unknown as IDBFactory;
}

const envelope = (name: string, speaker: string) => ({
  version: 0,
  state: {
    transcripts: { P01: { lines: [{ id: 1, ts: "", speaker, text: `${name} talking` }] } },
    segments: [], codebook: {}, extSegRows: [], tabs: ["P01"], active: "P01",
    hotbar: { mode: "auto", pinned: [] }, video: {},
    ui: { fontSize: 18, speakerColors: { [speaker]: "#aa0000" } },
    ai: { model: "gpt-5", redactTerms: [name], lenses: ["transcription"] },
    projectName: name,
  },
});
const nameAt = (data: Map<string, unknown>, key: string) =>
  (data.get(key) as { state: { projectName: string } } | undefined)?.state.projectName;

// a fresh page load over `data` (fake timers on): new modules, the store hydrated
async function boot(data: Map<string, unknown>, faults?: Faults, ls = new Map<string, string>()) {
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIdb(data, faults));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => { ls.set(k, v); },
    removeItem: (k: string) => { ls.delete(k); },
  });
  const { useStore } = await import("./state/store");
  const persistence = await import("./state/persistence");
  const projects = await import("./state/projects");
  const scroll = await import("./scrollMemory");
  while (!useStore.persist.hasHydrated()) await vi.advanceTimersByTimeAsync(100);
  return { useStore, ...persistence, ...projects, ...scroll, s: () => useStore.getState() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("upgrading keeps the one saved project, untouched, as the first in the list", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const before = structuredClone(data.get(FIRST));
  const app = await boot(data);
  expect(app.s().projectName).toBe("Study A");
  expect(app.activeKey()).toBe(FIRST);
  expect((await app.listProjects()).map((p) => p.key)).toEqual([FIRST]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.get(FIRST)).toEqual(before); // booting wrote nothing over it

  // leaving it for a new project saves it under its own key, named in the list
  await app.createProject();
  const list = await app.listProjects();
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ key: FIRST, name: "Study A", transcripts: 1 });
  expect(nameAt(data, FIRST)).toBe("Study A");
  expect(Object.keys(app.s().transcripts)).toEqual([]);
});

it("a switch mid-debounce lands each project's edits under its own key", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  let app = await boot(data);
  await app.createProject();
  const b = app.activeKey();
  app.s().setProjectName("Study B");
  app.s().setUi({ fontSize: 22 });          // personal: follows the person
  app.rememberScroll("P01", { index: 7, delta: 0 });
  // no timers advanced: B's write is still pending when we leave
  await app.switchProject(FIRST);
  expect(nameAt(data, b)).toBe("Study B");  // flushed under B's key, not A's
  expect(nameAt(data, FIRST)).toBe("Study A");
  expect(app.s().projectName).toBe("Study A");
  expect(Object.keys(app.s().transcripts)).toEqual(["P01"]);
  expect(app.s().ui.speakerColors).toEqual({ Ann: "#aa0000" }); // the study's own speaker map
  expect(app.s().ui.fontSize).toBe(22);
  expect(app.s().ai.redactTerms).toEqual(["Study A"]);
  expect(app.savedScroll.P01).toBeUndefined(); // B's reading position stays B's

  await vi.advanceTimersByTimeAsync(1000);
  expect(nameAt(data, FIRST)).toBe("Study A");
  expect(nameAt(data, b)).toBe("Study B");

  await app.switchProject(b);
  expect(app.s().projectName).toBe("Study B");
  expect(app.s().transcripts).toEqual({});  // nothing of A leaked in
  expect(app.s().ui.speakerColors).toEqual({});
  expect(app.savedScroll.P01).toEqual({ index: 7, delta: 0 });

  // a reload opens the project you were last in
  await vi.advanceTimersByTimeAsync(1000);
  app = await boot(data);
  expect(app.activeKey()).toBe(b);
  expect(app.s().projectName).toBe("Study B");
});

it("rapid switches run in order and end on the last one", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data);
  await app.createProject();
  const b = app.activeKey();
  app.s().setProjectName("Study B");
  await app.createProject();
  const c = app.activeKey();
  app.s().setProjectName("Study C");
  await Promise.all([app.switchProject(FIRST), app.switchProject(b), app.switchProject(c), app.switchProject(b)]);
  expect(app.activeKey()).toBe(b);
  expect(app.s().projectName).toBe("Study B");
  await vi.advanceTimersByTimeAsync(1000);
  expect([nameAt(data, FIRST), nameAt(data, b), nameAt(data, c)]).toEqual(["Study A", "Study B", "Study C"]);
});

it("deleting: another project keeps its pending edit; the open one moves on; the last leaves a fresh one", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data);
  await app.createProject();
  const b = app.activeKey();
  app.s().setProjectName("Study B");
  await vi.advanceTimersByTimeAsync(1000);
  await app.createProject();
  const c = app.activeKey();
  app.s().setProjectName("Study C");
  await vi.advanceTimersByTimeAsync(1000);
  await app.switchProject(b);
  await vi.advanceTimersByTimeAsync(10);   // B is now the most recently used

  app.s().setProjectNotes("pending in B"); // still in the debounce when C goes
  await app.deleteProject(c);
  expect(data.has(c)).toBe(false);
  expect((await app.listProjects()).map((p) => p.key)).toEqual([FIRST, b]);
  await vi.advanceTimersByTimeAsync(1000);
  expect((data.get(b) as { state: { projectNotes: string } }).state.projectNotes).toBe("pending in B");
  expect(data.has(c)).toBe(false);          // and nothing resurrected it

  await app.deleteProject(b);               // the open one: lands on A
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A");
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.has(b)).toBe(false);

  await app.deleteProject(FIRST);           // the only one: a fresh, empty project
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.has(FIRST)).toBe(false);
  const left = await app.listProjects();
  expect(left).toHaveLength(1);
  expect(left[0].key).not.toBe(FIRST);
  expect(app.s().projectName).toBe("");
  expect(app.s().transcripts).toEqual({});
});

it("an older envelope missing fields opens without the last project's in their place", async () => {
  vi.useFakeTimers();
  const old = envelope("Study X", "Xan") as { state: Record<string, unknown> };
  delete old.state.projectName;
  old.state.ui = { fontSize: 18 }; // written before the speaker map existed
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, old]]);
  const app = await boot(data);
  app.s().setProjectNotes("A's notes");
  await app.switchProject(`${FIRST}:x`);
  expect(app.s().projectName).toBe("");
  expect(app.s().projectNotes).toBe("");
  expect(app.s().ui.speakerColors).toEqual({});
  expect(app.s().transcripts.P01.lines[0].text).toBe("Study X talking");
});

it("a project that can't be read is never entered", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")],
    [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { broken: new Set([`${FIRST}:x`]) });
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow();
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A");
  app.s().setProjectName("Study A2");
  await vi.advanceTimersByTimeAsync(1000);
  expect(nameAt(data, FIRST)).toBe("Study A2");
  expect(nameAt(data, `${FIRST}:x`)).toBe("Study X");
});

it("a project that reads but won't load is never entered either", async () => {
  vi.useFakeTimers();
  const bad = envelope("Study X", "Xan") as { state: Record<string, unknown> };
  bad.state.segments = null; // migrateState throws on it
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, bad]]);
  const before = structuredClone(bad);
  const app = await boot(data);
  app.positioned.add("P01"); // the open transcript has placed itself
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow();
  expect(app.activeKey()).toBe(FIRST);
  expect(app.positioned.has("P01")).toBe(true); // so its scrolling keeps being saved
  app.s().setProjectName("Study A2"); // must land on A, not over X
  await vi.advanceTimersByTimeAsync(1000);
  expect(nameAt(data, FIRST)).toBe("Study A2");
  expect(data.get(`${FIRST}:x`)).toEqual(before);
});

it("a project whose save fails is not left, and nothing of it is lost", async () => {
  vi.useFakeTimers();
  const failing = new Set<string>();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { failing });
  failing.add(FIRST);
  app.s().setProjectName("Study A2");
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow(/couldn't be saved/);
  await expect(app.createProject()).rejects.toThrow(/couldn't be saved/);
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A2"); // still in memory, still yours
  expect(app.s().saveFailed).toBe(true);
  failing.clear();
  await app.switchProject(`${FIRST}:x`);
  expect(nameAt(data, FIRST)).toBe("Study A2");
  expect(app.s().projectName).toBe("Study X");
});

it("a delete that fails says so, and the project stays", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { failing: new Set([`${FIRST}:x`]) });
  await expect(app.deleteProject(`${FIRST}:x`)).rejects.toThrow();
  expect((await app.listProjects()).map((p) => p.key)).toEqual([FIRST, `${FIRST}:x`]);
  expect(nameAt(data, `${FIRST}:x`)).toBe("Study X");
});

it("a boot read that times out never reopens saving under another project's key", async () => {
  vi.useFakeTimers();
  // the index names a project with no envelope; the legacy copy holds A
  const data = new Map<string, unknown>([["qually-projects", { active: `${FIRST}:b`, meta: {} }]]);
  const ls = new Map([[FIRST, JSON.stringify(envelope("Study A", "Ann"))]]);
  const app = await boot(data, { slow: new Map([["qually-projects", 4000]]) }, ls);
  expect(app.s().projectName).toBe("Study A"); // the legacy copy keeps the workspace usable
  await vi.advanceTimersByTimeAsync(10_000);  // ...and the late answers arrive
  app.s().setProjectName("Study A2");
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.has(`${FIRST}:b`)).toBe(false);
  expect(data.has(FIRST)).toBe(false);        // nor over a newer copy it could not see
  expect(app.projectsAvailable()).toBe(false);
});

it("a file still being read when the project changes is not imported into the next one", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data);
  const csv = "line_id,speaker,text\n1,Ann,late words\n";
  const file = { name: "P09.csv", text: () => new Promise<string>((r) => setTimeout(() => r(csv), 200)) } as File;
  const imp = app.s().importFiles([file]);
  imp.catch(() => { /* asserted below */ });
  await app.switchProject(`${FIRST}:x`);
  await vi.advanceTimersByTimeAsync(300);
  await expect(imp).rejects.toThrow(/project changed/);
  expect(Object.keys(app.s().transcripts)).toEqual(["P01"]);
  await vi.advanceTimersByTimeAsync(1000);
  const tr = (k: string) => Object.keys((data.get(k) as { state: { transcripts: object } }).state.transcripts);
  expect([tr(FIRST), tr(`${FIRST}:x`)]).toEqual([["P01"], ["P01"]]);
});

it("an AI request still out holds the project where it is", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data);
  vi.stubGlobal("fetch", () => new Promise(() => { /* never answers */ }));
  const { callJson } = await import("./ai/openai");
  void callJson({ key: "k", model: "m", system: "", user: "", schemaName: "s", schema: {} });
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow(/AI request/);
  expect(app.activeKey()).toBe(FIRST);
});

it("an AI request started while the project is being saved still holds it", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { slow: new Map([[FIRST, 100]]) });
  const sw = app.switchProject(`${FIRST}:x`);
  sw.catch(() => { /* asserted below */ });
  await vi.advanceTimersByTimeAsync(50);    // the outgoing save is still landing
  vi.stubGlobal("fetch", () => new Promise(() => { /* never answers */ }));
  const { callJson } = await import("./ai/openai");
  void callJson({ key: "k", model: "m", system: "", user: "", schemaName: "s", schema: {} });
  await vi.advanceTimersByTimeAsync(200);
  await expect(sw).rejects.toThrow(/AI request/);
  expect(app.activeKey()).toBe(FIRST);
});

it("edits made while the outgoing save lands are saved too before leaving — or the move stops", async () => {
  vi.useFakeTimers();
  const failing = new Set<string>();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { failing, slow: new Map([[FIRST, 100]]) });
  const sw = app.switchProject(`${FIRST}:x`);
  sw.catch(() => { /* asserted below */ });
  await vi.advanceTimersByTimeAsync(50);
  app.s().setProjectName("Study A2");       // lands after the snapshot being saved
  await vi.advanceTimersByTimeAsync(75);    // that save is done; the next is on its way
  failing.add(FIRST);                       // ...and fails
  await vi.advanceTimersByTimeAsync(200);
  await expect(sw).rejects.toThrow(/couldn't be saved/);
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A2");
});

it("an edit the debounce sends while the outgoing save lands must land too before leaving", async () => {
  vi.useFakeTimers();
  const failing = new Set<string>();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, { failing, slow: new Map([[FIRST, 600]]) });
  const sw = app.switchProject(`${FIRST}:x`);
  sw.catch(() => { /* asserted below */ });
  await vi.advanceTimersByTimeAsync(50);
  app.s().setProjectName("Study A2");       // its debounce fires at ~550, mid-save
  await vi.advanceTimersByTimeAsync(650);   // first save landed at ~600; the timer's is out
  failing.add(FIRST);                       // ...and that one fails
  await vi.advanceTimersByTimeAsync(1000);
  await expect(sw).rejects.toThrow(/couldn't be saved/);
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A2");
});

it("an import whose last read fails after the project changed leaves the next project alone", async () => {
  vi.useFakeTimers();
  const x = envelope("Study X", "Xan") as { state: Record<string, unknown> };
  x.state.segments = [{ sid: 1, pid: "P01", start: 1, end: 1, code: "c", proposedBy: "(default)", status: "accepted", notes: "" }];
  x.state.codebook = { c: { color: "#336699", def: "", status: "candidate" } };
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, x]]);
  const app = await boot(data);
  const file = { name: "P09.csv",
    text: () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("unreadable")), 200)) } as File;
  const imp = app.s().importFiles([file]);
  imp.catch(() => { /* asserted below */ });
  await app.switchProject(`${FIRST}:x`);
  await vi.advanceTimersByTimeAsync(300);
  await expect(imp).rejects.toThrow(/project changed/);
  expect(app.s().pendingImportSign).toBeNull();
});

it("on a full disk the open project can still be deleted — the last one, or with others", async () => {
  vi.useFakeTimers();
  const faults: Faults = {};
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, envelope("Study X", "Xan")]]);
  const app = await boot(data, faults);
  faults.full = true;
  app.s().setProjectName("Study A2");       // unsaveable now
  await app.deleteProject(FIRST);           // with another to go to
  expect(data.has(FIRST)).toBe(false);
  expect(app.s().projectName).toBe("Study X");
  await app.deleteProject(`${FIRST}:x`);    // and the last one
  expect(data.has(`${FIRST}:x`)).toBe(false);
  expect(app.s().transcripts).toEqual({});
});

it("a record whose state isn't a project object is refused, and left as it was", async () => {
  vi.useFakeTimers();
  const odd = { version: 0, state: [{ transcripts: {} }] };
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, odd]]);
  const app = await boot(data);
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow(/shape/);
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.get(`${FIRST}:x`)).toEqual(odd);
});

it("a record that isn't a saved project is never loaded, so never written over", async () => {
  vi.useFakeTimers();
  const odd = { transcripts: { P01: {} } }; // data, but not an envelope
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, odd]]);
  const app = await boot(data);
  await expect(app.switchProject(`${FIRST}:x`)).rejects.toThrow(/shape/);
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.get(`${FIRST}:x`)).toEqual(odd);
  expect(app.activeKey()).toBe(FIRST);
});

it("an import overtaken by another project leaves that project's history and signatures alone", async () => {
  vi.useFakeTimers();
  const x = envelope("Study X", "Xan") as { state: Record<string, unknown> };
  x.state.segments = [{ sid: 1, pid: "P01", start: 1, end: 1, code: "c", proposedBy: "(default)", status: "accepted", notes: "" }];
  x.state.codebook = { c: { color: "#336699", def: "", status: "candidate" } };
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")], [`${FIRST}:x`, x]]);
  const app = await boot(data);
  const file = { name: "P09.csv", text: () => new Promise<string>((r) => setTimeout(() => r("line_id,text\n1,hi\n"), 200)) } as File;
  const imp = app.s().importFiles([file]);
  imp.catch(() => { /* asserted below */ });
  await app.switchProject(`${FIRST}:x`);
  app.s().setProjectName("Study X2");
  app.s().pushUndo();
  await vi.advanceTimersByTimeAsync(300);
  await expect(imp).rejects.toThrow(/project changed/);
  expect(app.s().pendingImportSign).toBeNull();
  expect(app.s().undoStack).toHaveLength(1);
});

it("an import overtaken by a project file opened in place is refused too", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data);
  const { parseProject } = await import("./project");
  const p = parseProject(JSON.stringify({ format: "qually-project", version: 1, savedAt: "", projectName: "F",
    transcripts: { F02: { lines: [{ id: 1, ts: "", speaker: "C", text: "x" }] } }, segments: [], codebook: {} }));
  const file = { name: "P09.csv", text: () => new Promise<string>((r) => setTimeout(() => r("line_id,text\n1,hi\n"), 200)) } as File;
  const imp = app.s().importFiles([file]);
  imp.catch(() => { /* asserted below */ });
  app.s().openProject(p); // same key: only the swap count can tell
  await vi.advanceTimersByTimeAsync(300);
  await expect(imp).rejects.toThrow(/project changed/);
  expect(Object.keys(app.s().transcripts)).toEqual(["F02"]);
});

it("a project file opened beside another starts in its own reading language and camera", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data);
  app.s().setUi({ lang: "en", mapViewport: { x: 5, y: 5, zoom: 2 } });
  const { parseProject } = await import("./project");
  const p = parseProject(JSON.stringify({ format: "qually-project", version: 1, savedAt: "",
    transcripts: { F02: { lines: [{ id: 1, ts: "", speaker: "C", text: "x" }] } }, segments: [], codebook: {} }));
  app.s().setPendingProject(p);
  expect(await app.openAsNewProject(p)).toBe(true);
  expect(app.s().ui.lang).toBe("source");
  expect(app.s().ui.mapViewport).toBeNull();
  await app.switchProject(FIRST);
  expect(app.s().ui.lang).toBe("en"); // A's own, back with A
});

it("a project file cancelled while the current project saved is not opened", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data, { slow: new Map([[FIRST, 100]]) });
  const { parseProject } = await import("./project");
  const p = parseProject(JSON.stringify({ format: "qually-project", version: 1, savedAt: "",
    transcripts: {}, segments: [], codebook: {} }));
  app.s().setPendingProject(p);
  const opened = app.openAsNewProject(p);
  await vi.advanceTimersByTimeAsync(50);
  app.s().setPendingProject(null); // Cancel
  await vi.advanceTimersByTimeAsync(200);
  expect(await opened).toBe(false);
  expect(app.activeKey()).toBe(FIRST);
  expect(app.s().projectName).toBe("Study A");
});

it("after CrashScreen's reset nothing writes the project back", async () => {
  vi.useFakeTimers();
  const data = new Map<string, unknown>([[FIRST, envelope("Study A", "Ann")]]);
  const app = await boot(data);
  app.stopSaving();
  await app.dropRawState(FIRST);
  app.s().setProjectName("late"); // e.g. the save-health flag flipping
  await vi.advanceTimersByTimeAsync(1000);
  expect(data.has(FIRST)).toBe(false);
});

it("anything left in a project counts as work — a lone decision ledger included", async () => {
  vi.useFakeTimers();
  const app = await boot(new Map());
  const { hasProjectWork } = await import("./state/store");
  expect(hasProjectWork(app.s())).toBe(false);  // a brand-new workspace
  app.useStore.setState({ ledger: [{ at: "t", kind: "rename", codes: ["a"], why: "" } as never] });
  expect(hasProjectWork(app.s())).toBe(true);
  app.s().newProject();
  expect(hasProjectWork(app.s())).toBe(false);
  app.s().setUi({ fontSize: 30 });               // the person's settings are not the project's
  expect(hasProjectWork(app.s())).toBe(false);
});

it("without IndexedDB there is one project, and moves are refused", async () => {
  vi.resetModules();
  const projects = await import("./state/projects");
  expect(projects.projectsAvailable()).toBe(false);
  await expect(projects.createProject()).rejects.toThrow(/saving is off/);
});
