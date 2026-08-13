// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Code definitions: undoable writes, and provenance (AI-drafted vs. human) that
// survives a codebook.csv round-trip.
import { beforeAll, beforeEach, test, expect } from "vitest";

let useStore: typeof import("./state/store").useStore;
// the public route a codebook.csv takes back in — the importer picks the
// handler off the columns, so this exercises the real dispatch too
const importCsv = (text: string) =>
  useStore.getState().importFiles([new File([text], "codebook.csv")]);

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));
});

beforeEach(() => {
  useStore.setState({
    codebook: { anger: { color: "#aa3377", def: "", status: "accepted" } },
    segments: [], undoStack: [], redoStack: [],
  } as never);
});

test("a definition write is undoable — an AI draft can't silently eat researcher text", () => {
  const st = useStore.getState();
  st.setDef("anger", "Written by hand.");
  st.setDef("anger", "Drafted by the model.", true);
  expect(useStore.getState().codebook.anger).toMatchObject({ def: "Drafted by the model.", defAi: true });
  useStore.getState().undo();
  expect(useStore.getState().codebook.anger).toMatchObject({ def: "Written by hand.", defAi: false });
});

test("a no-op save pushes no undo entry", () => {
  const st = useStore.getState();
  st.setDef("anger", "Same text.");
  const depth = useStore.getState().undoStack.length;
  useStore.getState().setDef("anger", "Same text.");
  expect(useStore.getState().undoStack).toHaveLength(depth);
});

test("provenance: verbatim AI is flagged, any human text is not", () => {
  const st = useStore.getState();
  st.setDef("anger", "Model words.", true);
  expect(useStore.getState().codebook.anger.defAi).toBe(true);
  useStore.getState().setDef("anger", "Model words, edited.", false);
  expect(useStore.getState().codebook.anger.defAi).toBe(false);
  // an empty definition has no provenance to claim
  useStore.getState().setDef("anger", "", true);
  expect(useStore.getState().codebook.anger.defAi).toBe(false);
});

test("codebook.csv round-trips provenance into a FRESH codebook", async () => {
  useStore.setState({
    codebook: {
      ai_code: { color: "#4477aa", def: "Drafted by the model.", status: "accepted", defAi: true },
      my_code: { color: "#228833", def: "Written by hand.", status: "accepted" },
    },
  } as never);
  const csv = useStore.getState().exportCodebook();
  expect(csv).toContain("def_source");

  // fresh workspace: without the column these would both come back as "human"
  useStore.setState({ codebook: {}, segments: [] } as never);
  await importCsv(csv);
  const cb = useStore.getState().codebook;
  expect(cb.ai_code).toMatchObject({ def: "Drafted by the model.", defAi: true });
  expect(cb.my_code).toMatchObject({ def: "Written by hand.", defAi: false });
});

test("a file with no def_source column (hand-made, or older export) reads as human", async () => {
  useStore.setState({ codebook: {}, segments: [] } as never);
  await importCsv("code,color,short_def,status\nx,#123456,Someone's definition.,accepted\n");
  expect(useStore.getState().codebook.x).toMatchObject({ def: "Someone's definition.", defAi: false });
});

test("merging carries the definition when the surviving code has none", () => {
  useStore.setState({
    codebook: {
      "lost context": { color: "#aa3377", def: "Marks losing the thread.", status: "accepted", defAi: true },
      "context loss": { color: "#228833", def: "", status: "accepted" },
    },
    segments: [],
  } as never);
  // neither merge surface shows definitions, so the only one of the pair could
  // be dropped by picking the wrong survivor
  useStore.getState().mergeCode("lost context", "context loss");
  expect(useStore.getState().codebook["context loss"]).toMatchObject({
    def: "Marks losing the thread.", defAi: true,
  });
});

test("merging does NOT overwrite a definition the survivor already has", () => {
  useStore.setState({
    codebook: {
      a: { color: "#aa3377", def: "From A.", status: "accepted" },
      b: { color: "#228833", def: "From B.", status: "accepted" },
    },
    segments: [],
  } as never);
  useStore.getState().mergeCode("a", "b");
  expect(useStore.getState().codebook.b.def).toBe("From B.");
});

test("a blank short_def column CLEARS the definition; a missing column leaves it", async () => {
  useStore.setState({
    codebook: { anger: { color: "#aa3377", def: "Old text.", status: "accepted", defAi: true } },
    segments: [],
  } as never);
  await importCsv("code,color,short_def,status\nanger,#aa3377,,accepted\n");
  expect(useStore.getState().codebook.anger).toMatchObject({ def: "", defAi: false });

  useStore.setState({
    codebook: { anger: { color: "#aa3377", def: "Old text.", status: "accepted", defAi: true } },
  } as never);
  await importCsv("code,color,status\nanger,#aa3377,accepted\n");
  expect(useStore.getState().codebook.anger).toMatchObject({ def: "Old text.", defAi: true });
});

test("a whole AI run's definitions are ONE undo step, and an echo of your own text stays yours", () => {
  useStore.setState({
    codebook: {
      a: { color: "#aa3377", def: "", status: "accepted" },
      b: { color: "#228833", def: "", status: "accepted" },
      mine: { color: "#4477aa", def: "Written by hand.", status: "accepted", defAi: false },
    },
    segments: [], undoStack: [], redoStack: [],
  } as never);
  const n = useStore.getState().applyDrafts([
    { code: "a", def: "Marks A." },
    { code: "b", def: "Marks B." },
    // the model is fed the current definition and told to refine it, so echoing
    // it back is routine — that must not relabel a person's words as AI output
    { code: "mine", def: "Written by hand." },
    { code: "ghost", def: "code no longer exists" },
  ]);
  // the codes actually WRITTEN — the echo of "mine" changed nothing
  expect(n).toEqual(["a", "b"]);
  const cb = useStore.getState().codebook;
  expect(cb.a).toMatchObject({ def: "Marks A.", defAi: true });
  expect(cb.mine).toMatchObject({ def: "Written by hand.", defAi: false });
  expect(cb.ghost).toBeUndefined();

  useStore.getState().undo();
  expect(useStore.getState().codebook.a.def).toBe("");
  expect(useStore.getState().codebook.b.def).toBe("");
});
