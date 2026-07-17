// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Smoke test: drive the REAL store through import -> code -> export -> re-import,
// verifying the data pipeline that writes coded-segments.csv. Node env; a tiny
// localStorage shim lets zustand's persist middleware load.
import { beforeAll, test, expect } from "vitest";
import { parseCSV } from "./contract/csv";

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
});

const TRANSCRIPT = `line_id,timestamp,speaker,text,codes
1,00:00:03,R,So how do you read a chart,
2,00:00:09,P,I zoom in really close,magnification
3,00:00:15,P,and pan across to follow it,magnification
4,00:00:22,P,but then I lose the axis labels,lost context
5,00:00:29,R,that sounds exhausting,
`;

test("import transcript -> inline codes collapse into segments", async () => {
  const s = useStore.getState();
  await s.importFiles([new File([TRANSCRIPT], "P01.csv")]);
  const st = useStore.getState();
  expect(Object.keys(st.transcripts)).toContain("P01");
  expect(st.active).toBe("P01");
  const refs = st.segments.map((x) => `${x.pid}:${x.start}${x.end !== x.start ? "-" + x.end : ""}:${x.code}`).sort();
  // magnification collapses 2-3; lost context on 4
  expect(refs).toContain("P01:2-3:magnification");
  expect(refs).toContain("P01:4:lost context");
});

test("apply a code to a drag-style selection", () => {
  const s = useStore.getState();
  s.selectLine(2);
  s.selectLine(3, { extend: true });     // select 2-3
  s.applyCode("member check");
  const segs = useStore.getState().segments;
  expect(segs.some((x) => x.pid === "P01" && x.start === 2 && x.end === 3 && x.code === "member check")).toBe(true);
});

test("export produces a valid coded-segments.csv with computed excerpts", () => {
  const csv = useStore.getState().exportCSV();
  const rows = parseCSV(csv);
  expect(Object.keys(rows[0])).toEqual(["segment_ref", "pid", "excerpt", "code", "proposed_by", "status", "notes"]);
  const mag = rows.find((r) => r.segment_ref === "P01:2-3" && r.code === "magnification");
  expect(mag).toBeTruthy();
  // dominant-speaker excerpt = the P lines joined, no [R:] prefix
  expect(mag!.excerpt).toBe("I zoom in really close and pan across to follow it");
});

test("a wrong-format file rejects with a message naming it, instead of vanishing", async () => {
  const s = useStore.getState();
  const tabsBefore = s.tabs.length;
  await expect(s.importFiles([new File(["just some prose\nnot a csv at all"], "notes.txt")]))
    .rejects.toThrow(/notes\.txt doesn't match any QuAlly format/);
  await expect(s.importFiles([new File([""], "empty.csv")]))
    .rejects.toThrow(/empty\.csv is empty/);
  expect(useStore.getState().tabs.length).toBe(tabsBefore); // nothing imported
});

test("re-importing the exported CSV is idempotent (no dupes, identical re-export)", async () => {
  const csv1 = useStore.getState().exportCSV();
  const before = useStore.getState().segments.length;
  await useStore.getState().importFiles([new File([csv1], "coded-segments.csv")]);
  expect(useStore.getState().segments.length).toBe(before); // dedup held
  expect(useStore.getState().exportCSV()).toBe(csv1);        // round-trips exactly
});

// dedup is per coder: a second coder's identical span+code is agreement data, kept —
// while re-importing your OWN export stays idempotent (the test above).
test("a second coder's identical segment imports alongside, not deduped away", async () => {
  const before = useStore.getState().segments.length;
  const row = 'segment_ref,pid,excerpt,code,proposed_by,status,notes\nP01:2-3,P01,,magnification,claude,candidate,\n';
  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]);
  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]); // their re-import dedups too
  const segs = useStore.getState().segments;
  expect(segs.length).toBe(before + 1);
  expect(segs.some((x) => x.pid === "P01" && x.start === 2 && x.end === 3
    && x.code === "magnification" && x.proposedBy === "claude" && x.status === "candidate")).toBe(true);
});

test("re-importing a row whose status/notes changed asks first; consent applies it", async () => {
  const row = 'segment_ref,pid,excerpt,code,proposed_by,status,notes\nP01:2-3,P01,,magnification,claude,rejected,too broad\n';
  const claude = () => useStore.getState().segments.find((x) => x.proposedBy === "claude")!;

  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]);
  expect(claude().status).toBe("candidate");                     // parked, not applied
  expect(useStore.getState().pendingSegUpdates).toHaveLength(1);

  useStore.getState().resolveSegUpdates(false);                  // keep mine
  expect(claude().status).toBe("candidate");
  expect(useStore.getState().pendingSegUpdates).toHaveLength(0);

  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]);
  useStore.getState().resolveSegUpdates(true);                   // overwrite with the file
  expect(claude().status).toBe("rejected");
  expect(claude().notes).toBe("too broad");
  expect(useStore.getState().pendingSegUpdates).toHaveLength(0);
});

test("segments parked for an unloaded transcript dedup, then become real on transcript import", async () => {
  const row = 'segment_ref,pid,excerpt,code,proposed_by,status,notes\nLATER:1-2,LATER,,magnification,claude,accepted,\n';
  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]);
  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]); // twice
  expect(useStore.getState().extSegRows.length).toBe(1); // deduped
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,P,aa,\n2,00:00:02,P,bb,\n",
  ], "LATER.csv")]);
  expect(useStore.getState().extSegRows.length).toBe(0); // reconciled
  expect(useStore.getState().segments.some((x) => x.pid === "LATER" && x.start === 1 && x.end === 2)).toBe(true);
});

test("a corrupt huge segment_ref range is refused (it would hang remap)", async () => {
  const before = useStore.getState().segments.length;
  const row = 'segment_ref,pid,excerpt,code,proposed_by,status,notes\nP01:1-999999999,P01,,magnification,claude,accepted,\n';
  await useStore.getState().importFiles([new File([row], "coded-segments.csv")]);
  expect(useStore.getState().segments.length).toBe(before);
  expect(useStore.getState().extSegRows.some((x) => x.segment_ref === "P01:1-999999999")).toBe(false);
});

test("editing notes after an undo invalidates redo instead of resurrecting undone coding", () => {
  const s = useStore.getState();
  s.clearSelection();
  s.pushSelUndo(); s.selectLine(2); s.endSelGesture();
  useStore.getState().applyCode("redo probe");
  useStore.getState().undo();                                   // "redo probe" gone, redoable
  expect(useStore.getState().redoStack.length).toBeGreaterThan(0);
  const any = useStore.getState().segments[0];
  useStore.getState().setNotes(any.sid, "edited");              // mutate snapshotted state
  useStore.getState().redo();                                   // must be a no-op now
  expect(useStore.getState().segments.some((x) => x.code === "redo probe")).toBe(false);
  expect(useStore.getState().segments.find((x) => x.sid === any.sid)!.notes).toBe("edited");
});

test("accepting a candidate keeps its proposer and exports as accepted", () => {
  const cand = useStore.getState().segments.find((x) => x.proposedBy === "claude")!;
  useStore.getState().setStatus(cand.sid, "accepted");
  const csv = useStore.getState().exportCSV();
  const row = parseCSV(csv).find((r) => r.proposed_by === "claude")!;
  expect(row.status).toBe("accepted");
});

test("selection is undoable, and a whole drag is ONE step", () => {
  const s = useStore.getState();
  s.clearSelection();

  s.pushSelUndo(); s.selectLine(2); s.endSelGesture();      // click line 2
  expect([...useStore.getState().selection.lines]).toEqual([2]);

  // a drag: one gesture, many selectLine calls (the fixture is 5 lines long)
  s.pushSelUndo();
  useStore.getState().selectLine(3);
  useStore.getState().selectLine(4, { extend: true });
  useStore.getState().selectLine(5, { extend: true });
  useStore.getState().endSelGesture();
  expect([...useStore.getState().selection.lines].sort()).toEqual([3, 4, 5]);

  useStore.getState().undo();                                     // ONE undo, not three
  expect([...useStore.getState().selection.lines]).toEqual([2]);  // back to the click
  useStore.getState().redo();
  expect([...useStore.getState().selection.lines].sort()).toEqual([3, 4, 5]);
});

test("undoing a code also puts back the lines it was applied to", () => {
  const s = useStore.getState();
  s.pushSelUndo(); s.selectLine(2); s.selectLine(3, { extend: true }); s.endSelGesture();
  const before = useStore.getState().segments.length;

  useStore.getState().applyCode("undo probe");
  expect(useStore.getState().segments.length).toBe(before + 1);

  useStore.getState().undo();
  expect(useStore.getState().segments.length).toBe(before);
  // the selection that the code was applied to comes back with it
  expect([...useStore.getState().selection.lines].sort()).toEqual([2, 3]);
});

// restore() decided whether to follow an undone selection by checking transcripts[pid] —
// but closeTab only drops the pid from `tabs`, leaving the transcript in place. So
// undoing after closing a tab made `active` a tab that isn't in the tab bar.
test("undo never activates a closed tab", () => {
  const s = useStore.getState();
  s.pushSelUndo(); s.selectLine(2); s.endSelGesture();  // a selection in P01
  useStore.setState({ tabs: ["P01", "P02"], transcripts: {
    ...useStore.getState().transcripts, P02: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi" }] },
  } });
  useStore.getState().setActive("P02");
  useStore.getState().closeTab("P01");                          // P01 leaves the tab bar
  expect(useStore.getState().tabs).not.toContain("P01");

  useStore.getState().undo();
  expect(useStore.getState().tabs).toContain(useStore.getState().active); // active must exist
});

// The gesture name was `key:${undoStack.length}` to be unique per keypress — but the
// stack is CAPPED at 80, so once full the length stops changing, every arrow press
// produced the same name, and pushSelUndo swallowed them all as "the same gesture".
// Arrow-key selection silently stopped being undoable after 80 edits.
test("a run of arrow presses is ONE undo step, and cannot evict coding history", () => {
  useStore.setState({ active: "P01", tabs: ["P01"] });
  const s = useStore.getState();

  s.pushSelUndo(); s.selectLine(1); s.endSelGesture();
  useStore.getState().applyCode("history");                  // a real edit to protect
  const stackAfterEdit = useStore.getState().undoStack.length;

  // hold ArrowDown: key-repeat. This used to push an entry PER PRESS, evicting the real
  // edits from the 80-entry stack in about a second.
  for (let i = 0; i < 60; i++) useStore.getState().moveSelection(1, false);
  expect(useStore.getState().undoStack.length).toBe(stackAfterEdit + 1); // ONE entry, not 60

  // and one undo steps back over the whole run
  useStore.getState().undo();
  expect([...useStore.getState().selection.lines]).toEqual([1]);
  // the coding edit is still undoable — it was never evicted
  useStore.getState().undo();
  expect(useStore.getState().segments.some((x) => x.code === "history")).toBe(false);
});


// Undo after closing a tab left the SELECTION pointing at the closed pid — only `active`
// was guarded. applyCode codes selection.pid without checking it's open, and the digit
// hotkeys only check selection.lines.size, so pressing "1" wrote segments onto a
// transcript that wasn't even on screen.
test("undo never leaves a live selection on a closed tab", () => {
  useStore.setState({ active: "P01", tabs: ["P01"], selection: { pid: null, anchor: null, head: null, lines: new Set() } });
  const s = useStore.getState();
  s.pushSelUndo(); s.selectLine(2); s.endSelGesture();   // selection in P01
  // a further undoable edit WHILE that selection is live, so the top snapshot carries it
  useStore.getState().applyCode("marker");
  useStore.setState({ tabs: ["P01", "P02"], transcripts: {
    ...useStore.getState().transcripts, P02: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi" }] },
  } });
  useStore.getState().setActive("P02");
  useStore.getState().closeTab("P01");

  useStore.getState().undo();  // restores the snapshot whose selection lives in CLOSED P01
  const after = useStore.getState().segments.length;

  useStore.getState().applyCode("ghost");   // a code applied to a closed tab must not land
  expect(useStore.getState().segments.some((x) => x.code === "ghost")).toBe(false);
  expect(useStore.getState().segments.length).toBe(after);
  // and the selection must not be left pointing at the closed tab
  expect(useStore.getState().selection.pid).not.toBe("P01");
});

// Re-importing over an UNCODED transcript skipped the consent modal (which is what
// normally clears the stacks), so undo could restore a selection pointing at line ids
// the new file no longer has — and coding from it wrote segments onto lines that
// don't exist.
test("re-importing an uncoded transcript clears stale undo/selection state", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,P,one,\n2,00:00:02,P,two,\n3,00:00:03,P,three,\n",
  ], "FRESH.csv")]);
  useStore.setState({ active: "FRESH" });
  const s = useStore.getState();
  s.pushSelUndo(); s.selectLine(3); s.endSelGesture();   // select a line that will vanish
  expect(useStore.getState().undoStack.length).toBeGreaterThan(0);

  // the corrected file is SHORTER — line 3 is gone
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,P,one,\n2,00:00:02,P,two,\n",
  ], "FRESH.csv")]);

  expect(useStore.getState().undoStack).toHaveLength(0);       // stale stack dropped
  expect(useStore.getState().selection.lines.size).toBe(0);    // stale selection dropped
  expect(useStore.getState().transcripts.FRESH.lines).toHaveLength(2);
});

// snapshot() recorded the selection but NOT the active tab, and tab identity was inferred
// from selection.pid — which is null for an EMPTY selection. So restore() could follow a
// selection INTO a tab but never restore "no selection" BACK to one: the undo entry got
// consumed, nothing changed on screen, and savedSelections still held the selection it
// was meant to remove. Revisiting the tab resurrected it, with an empty undo stack.
test("undo can un-select in a tab you have since left", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,P,a,\n2,00:00:02,P,b,\n",
  ], "TA.csv")]);
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,P,c,\n2,00:00:02,P,d,\n",
  ], "TB.csv")]);

  useStore.getState().setActive("TA");
  const s = useStore.getState();
  s.pushSelUndo(); s.selectLine(2); s.endSelGesture();     // select line 2 in TA
  useStore.getState().setActive("TB");                     // park it
  expect(useStore.getState().savedSelections.TA?.lines.has(2)).toBe(true);

  useStore.getState().undo();                              // undo the selection made in TA
  useStore.getState().setActive("TA");                     // go back and look
  expect([...useStore.getState().selection.lines]).toEqual([]); // it must be GONE
});

// LAST on purpose: it wipes the workspace every earlier test builds on
test("newProject wipes the workspace but keeps ui/ai preferences", () => {
  useStore.getState().setUi({ coderName: "keepme" });
  expect(useStore.getState().segments.length).toBeGreaterThan(0);
  useStore.getState().newProject();
  const s = useStore.getState();
  expect(s.segments).toHaveLength(0);
  expect(s.transcripts).toEqual({});
  expect(s.tabs).toHaveLength(0);
  expect(s.extSegRows).toHaveLength(0);
  expect(s.undoStack).toHaveLength(0);
  expect(s.active).toBe("browse");
  expect(s.ui.coderName).toBe("keepme"); // the person survives the project
});
