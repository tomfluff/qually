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
  st.editLine("P01", 2, "so I zoomed in");            // line entry
  st.clearSelection();
  st.pushSelUndo(); st.selectLine(1); st.endSelGesture();
  useStore.getState().applyCode("magnification");     // snapshot entries
  useStore.getState().editLine("P01", 1, "I lost the ticket marks"); // line entry

  useStore.getState().undo(); // text edit on line 1
  expect(useStore.getState().transcripts.P01.lines[0].text).toBe("I kept losing the ticket marks");
  expect(useStore.getState().segments.some((x) => x.code === "magnification")).toBe(true);
  useStore.getState().undo(); // the coding edit
  expect(useStore.getState().segments.some((x) => x.code === "magnification")).toBe(false);
  useStore.getState().undo(); // selection entry (may coalesce), then the line-2 edit
  if (useStore.getState().transcripts.P01.lines[1].text !== "so I zoomed in further")
    useStore.getState().undo();
  expect(useStore.getState().transcripts.P01.lines[1].text).toBe("so I zoomed in further");
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
