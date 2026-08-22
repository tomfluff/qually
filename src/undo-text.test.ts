// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Text-edit undo: editLine/applyFix push targeted line entries onto the same
// stack as the coding snapshots, so Ctrl+Z steps back wording AND the AI mark
// an applied fix consumed — without snapshotting whole transcripts.
import { beforeAll, test, expect } from "vitest";
import { hashLine } from "./ai/flag";

let useStore: typeof import("./state/store").useStore;

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
  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text,codes
1,00:00:03,P,I kept losing the ticket marks,
2,00:00:09,P,so I zoomed in further,
`,
  ], "P01.csv")]);
});

test("a manual line edit is undoable and redoable", () => {
  const st = useStore.getState();
  st.editLine("P01", 1, "I kept losing the tick marks");
  useStore.getState().undo();
  let l = useStore.getState().transcripts.P01.lines[0];
  expect(l.text).toBe("I kept losing the ticket marks");
  expect(l.orig).toBeUndefined(); // provenance rolled back too, not a phantom edit
  useStore.getState().redo();
  l = useStore.getState().transcripts.P01.lines[0];
  expect(l.text).toBe("I kept losing the tick marks");
  expect(l.orig).toBe("I kept losing the ticket marks");
  useStore.getState().undo(); // back to pristine for the next test
});

test("undoing an applyFix restores the text AND the consumed mark", () => {
  const st = useStore.getState();
  st.addFlags("P01", { 1: [
    { quote: "ticket marks", reason: "misheard", lens: "transcription", fix: "tick marks" },
  ] }, st.transcripts.P01.lines, ["transcription"]);
  st.applyFix("P01", 1, "ticket marks", "tick marks");
  expect(useStore.getState().aiFlags["P01:1"].spans).toEqual([]); // span consumed

  useStore.getState().undo();
  const l = useStore.getState().transcripts.P01.lines[0];
  expect(l.text).toBe("I kept losing the ticket marks");
  expect(l.orig).toBeUndefined();
  const f = useStore.getState().aiFlags["P01:1"];
  expect(f.spans.map((s) => s.quote)).toEqual(["ticket marks"]); // mark is back
  expect(f.hash).toBe(hashLine(l.text));                          // and still valid

  useStore.getState().redo();
  expect(useStore.getState().transcripts.P01.lines[0].text).toBe("I kept losing the tick marks");
  expect(useStore.getState().aiFlags["P01:1"].spans).toEqual([]);
  useStore.getState().undo();
});

test("line entries and coding snapshots interleave on one stack", () => {
  const st = useStore.getState();
  const base = st.undoStack.length; // earlier tests/import leave entries below us
  st.editLine("P01", 2, "so I zoomed in");            // line entry
  st.clearSelection();
  st.pushSelUndo(); st.selectLine(1); st.endSelGesture();
  useStore.getState().applyCode("magnification");     // snapshot entries
  useStore.getState().editLine("P01", 1, "I lost the ticket marks"); // line entry

  // this test added exactly: [line-2 entry, selection snap, applyCode snap, line-1 entry]
  expect(useStore.getState().undoStack).toHaveLength(base + 4);
  useStore.getState().undo(); // text edit on line 1
  expect(useStore.getState().transcripts.P01.lines[0].text).toBe("I kept losing the ticket marks");
  expect(useStore.getState().segments.some((x) => x.code === "magnification")).toBe(true);
  useStore.getState().undo(); // the coding edit
  expect(useStore.getState().segments.some((x) => x.code === "magnification")).toBe(false);
  useStore.getState().undo(); // the selection snap (no visible text change)
  useStore.getState().undo(); // the line-2 edit
  expect(useStore.getState().transcripts.P01.lines[1].text).toBe("so I zoomed in further");
});

test("a flag mutation after undo invalidates the redo branch (no resurrected marks)", () => {
  const st = useStore.getState();
  st.addFlags("P01", { 1: [
    { quote: "ticket marks", reason: "misheard", lens: "transcription", fix: "tick marks" },
  ] }, st.transcripts.P01.lines, ["transcription"]);
  useStore.getState().editLine("P01", 1, "redo-probe wording");
  useStore.getState().undo();
  expect(useStore.getState().redoStack.length).toBeGreaterThan(0);
  // dismissing a mark mutates aiFlags — a stale line-entry redo would bring it back
  useStore.getState().dismissNotice("P01", 1, "transcription", "ticket marks");
  expect(useStore.getState().redoStack).toHaveLength(0);
  useStore.getState().redo(); // no-op
  expect(useStore.getState().aiFlags["P01:1"].spans).toEqual([]);
  useStore.getState().clearFlags("P01");
});

test("a fresh edit after undo invalidates the redo branch", () => {
  const st = useStore.getState();
  st.editLine("P01", 1, "version A");
  useStore.getState().undo();
  expect(useStore.getState().redoStack.length).toBeGreaterThan(0);
  useStore.getState().editLine("P01", 1, "version B"); // new action, stale redo must die
  expect(useStore.getState().redoStack).toHaveLength(0);
  useStore.getState().redo(); // no-op
  expect(useStore.getState().transcripts.P01.lines[0].text).toBe("version B");
});

// The edge of the history is an ANSWER, not a no-op: undo with an empty stack
// used to return in silence, which for a screen-reader user is
// indistinguishable from "the undo worked and changed nothing".
test("undo and redo at the edge of the history change nothing and do not throw", () => {
  // read the stack FRESH each turn — a captured state object keeps the length
  // it had when captured, and the loop never ends
  for (let i = 0; useStore.getState().undoStack.length && i < 200; i++) useStore.getState().undo();
  expect(useStore.getState().undoStack).toHaveLength(0);
  const before = JSON.stringify(useStore.getState().transcripts);
  useStore.getState().undo(); // the guarded path
  expect(JSON.stringify(useStore.getState().transcripts)).toBe(before);
  expect(useStore.getState().undoStack).toHaveLength(0);

  for (let i = 0; useStore.getState().redoStack.length && i < 200; i++) useStore.getState().redo();
  const after = JSON.stringify(useStore.getState().transcripts);
  useStore.getState().redo();
  expect(JSON.stringify(useStore.getState().transcripts)).toBe(after);
  expect(useStore.getState().redoStack).toHaveLength(0);
});

// Coding a selection that is ALREADY coded that way writes nothing. The
// rollback for that has to put the WHOLE history back, not just the segments:
// pushUndo clears the redo stack, so popping one undo entry leaves the redo
// you were holding gone for good.
test("a coding that dedups to nothing does not eat a pending redo", () => {
  useStore.getState().selectLine(1);
  useStore.getState().applyCode("alpha");
  useStore.getState().selectLine(2);
  useStore.getState().applyCode("beta");
  const both = useStore.getState().segments.length;

  useStore.getState().undo();                      // beta is now pending in redo
  expect(useStore.getState().redoStack).toHaveLength(1);
  const afterUndo = useStore.getState().segments.length;

  // line 1 is still coded alpha, so this writes nothing at all
  useStore.getState().selectLine(1);
  useStore.getState().applyCode("alpha");
  expect(useStore.getState().segments).toHaveLength(afterUndo);   // nothing written
  expect(useStore.getState().redoStack).toHaveLength(1);          // and beta survives

  useStore.getState().redo();
  expect(useStore.getState().segments).toHaveLength(both);
});
