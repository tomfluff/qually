// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// moveTab: drag-reorder with the pin invariant — pinned tabs own the front, a
// drag can rearrange within a group but never carry a tab across the boundary.
import { beforeAll, beforeEach, test, expect } from "vitest";

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

beforeEach(() => {
  useStore.setState({ tabs: ["A", "B", "C", "D"], pinnedTabs: [] });
});

test("reorders within the unpinned group", () => {
  useStore.getState().moveTab("D", 1);
  expect(useStore.getState().tabs).toEqual(["A", "D", "B", "C"]);
  useStore.getState().moveTab("A", 3);
  expect(useStore.getState().tabs).toEqual(["D", "B", "C", "A"]);
});

test("unknown pid and same-index moves are no-ops", () => {
  useStore.getState().moveTab("Z", 0);
  useStore.getState().moveTab("B", 1);
  expect(useStore.getState().tabs).toEqual(["A", "B", "C", "D"]);
});

test("an unpinned tab can't cross into the pinned front", () => {
  useStore.setState({ tabs: ["A", "B", "C", "D"], pinnedTabs: ["A", "B"] });
  useStore.getState().moveTab("D", 0);
  expect(useStore.getState().tabs).toEqual(["A", "B", "D", "C"]); // clamped to the boundary
});

test("a pinned tab reorders within the front, and pin order follows", () => {
  useStore.setState({ tabs: ["A", "B", "C", "D"], pinnedTabs: ["A", "B"] });
  useStore.getState().moveTab("B", 0);
  expect(useStore.getState().tabs).toEqual(["B", "A", "C", "D"]);
  expect(useStore.getState().pinnedTabs).toEqual(["B", "A"]);
  useStore.getState().moveTab("B", 3); // dragged past the boundary: stops at it
  expect(useStore.getState().tabs).toEqual(["A", "B", "C", "D"]);
});

test("closing a tab only hides it — openTab puts it back", () => {
  useStore.setState({
    tabs: ["A", "B"], pinnedTabs: [],
    transcripts: { A: { lines: [] }, B: { lines: [] } } as never,
    active: "A", savedSelections: {},
  });
  useStore.getState().closeTab("A");
  expect(useStore.getState().tabs).toEqual(["B"]);
  expect(useStore.getState().transcripts.A).toBeDefined(); // the data never left
  useStore.getState().openTab("A");
  expect(useStore.getState().tabs).toEqual(["B", "A"]);
  expect(useStore.getState().active).toBe("A");
});

test("openTab ignores unknown transcripts and reserved view names", () => {
  useStore.setState({ tabs: ["B"], transcripts: { B: { lines: [] } } as never, active: "B" });
  useStore.getState().openTab("nope");
  useStore.getState().openTab("browse");
  expect(useStore.getState().tabs).toEqual(["B"]);
});

test("reopening a pinned transcript puts it back in the pinned group", () => {
  const s = () => useStore.getState();
  useStore.setState({
    transcripts: { A: { lines: [] }, B: { lines: [] }, C: { lines: [] } },
    tabs: ["A", "B", "C"], pinnedTabs: [], active: "A", segments: [],
  } as never);
  s().togglePinTab("C");
  expect(s().tabs).toEqual(["C", "A", "B"]);
  // closing keeps the pin — so reopening must not land it after the unpinned tabs
  s().closeTab("C");
  expect(s().tabs).toEqual(["A", "B"]);
  expect(s().pinnedTabs).toEqual(["C"]);
  s().openTab("C");
  expect(s().tabs).toEqual(["C", "A", "B"]);
});

test("jumping into a closed pinned transcript also lands it in the pinned group", () => {
  const s = () => useStore.getState();
  useStore.setState({
    transcripts: { A: { lines: [{ id: 1, ts: "", speaker: "P", text: "x" }] }, B: { lines: [] } },
    tabs: ["B"], pinnedTabs: ["A"], active: "B", segments: [],
  } as never);
  s().jumpTo("A", 1);
  expect(s().tabs).toEqual(["A", "B"]);
});

test.each(["assist", "browse"])("jumping from %s selects the target line instead of its saved selection", (active) => {
  useStore.setState({
    transcripts: { A: { lines: [
      { id: 1, ts: "", speaker: "P", text: "first" },
      { id: 2, ts: "", speaker: "P", text: "target" },
    ] } },
    tabs: ["A"], active,
    selection: { pid: null, anchor: null, head: null, lines: new Set() },
    savedSelections: { A: { pid: "A", anchor: 1, head: 1, lines: new Set([1]) } },
    ui: { ...useStore.getState().ui, mergeLines: false },
  } as never);
  useStore.getState().jumpTo("A", 2);
  expect(useStore.getState().active).toBe("A");
  expect(useStore.getState().selection).toEqual({ pid: "A", anchor: 2, head: 2, lines: new Set([2]) });
  expect(useStore.getState().jump).toEqual({ pid: "A", line: 2 });
});

// a stale target (a Notes stamp whose line a re-import dropped) falls inside a
// merged group's numeric span; it must not select that group
test("jumping from another view to a line that no longer exists selects nothing new", () => {
  const saved = { pid: "A", anchor: 30, head: 30, lines: new Set([30]) };
  useStore.setState({
    transcripts: { A: { lines: [
      { id: 10, ts: "", speaker: "P", text: "so when I" },
      { id: 20, ts: "", speaker: "P", text: "zoomed in it broke." },
      { id: 30, ts: "", speaker: "R", text: "okay." },
    ] } },
    tabs: ["A"], active: "notes",
    selection: { pid: null, anchor: null, head: null, lines: new Set() },
    savedSelections: { A: saved },
    ui: { ...useStore.getState().ui, mergeLines: true },
  } as never);
  useStore.getState().jumpTo("A", 15);
  expect(useStore.getState().active).toBe("A");
  expect(useStore.getState().selection).toBe(saved);
});

// an import can name a transcript after a reserved view; "notes" still renders
// the Notes page, so a jump there must not select lines it does not show
test("jumping to a transcript named like a reserved view selects nothing", () => {
  const saved = { pid: "notes", anchor: 2, head: 2, lines: new Set([2]) };
  useStore.setState({
    transcripts: { notes: { lines: [
      { id: 1, ts: "", speaker: "P", text: "first." },
      { id: 2, ts: "", speaker: "P", text: "second." },
    ] } },
    tabs: ["notes"], active: "browse",
    selection: { pid: null, anchor: null, head: null, lines: new Set() },
    savedSelections: { notes: saved },
    ui: { ...useStore.getState().ui, mergeLines: false },
  } as never);
  useStore.getState().jumpTo("notes", 1);
  expect(useStore.getState().selection).toBe(saved);
});

test("jumping between transcript tabs restores the target's saved selection", () => {
  const saved = { pid: "A", anchor: 1, head: 1, lines: new Set([1]) };
  const outgoing = { pid: "B", anchor: 1, head: 1, lines: new Set([1]) };
  useStore.setState({
    transcripts: { A: { lines: [
      { id: 1, ts: "", speaker: "P", text: "first" },
      { id: 2, ts: "", speaker: "P", text: "target" },
    ] }, B: { lines: [{ id: 1, ts: "", speaker: "P", text: "other" }] } },
    tabs: ["A", "B"], active: "B", selection: outgoing, savedSelections: { A: saved },
  } as never);
  useStore.getState().jumpTo("A", 2);
  expect(useStore.getState().active).toBe("A");
  expect(useStore.getState().selection).toBe(saved);
  expect(useStore.getState().savedSelections.B).toBe(outgoing);
  expect(useStore.getState().jump).toEqual({ pid: "A", line: 2 });
});

test("a same-tab jump leaves the current selection unchanged", () => {
  const selection = { pid: "A", anchor: 1, head: 1, lines: new Set([1]) };
  const saved = { pid: "A", anchor: 2, head: 2, lines: new Set([2]) };
  useStore.setState({
    transcripts: { A: { lines: [
      { id: 1, ts: "", speaker: "P", text: "first" },
      { id: 2, ts: "", speaker: "P", text: "target" },
    ] } },
    tabs: ["A"], active: "A", selection, savedSelections: { A: saved },
  } as never);
  useStore.getState().jumpTo("A", 2);
  expect(useStore.getState().active).toBe("A");
  expect(useStore.getState().selection).toBe(selection);
  expect(useStore.getState().savedSelections.A).toBe(saved);
  expect(useStore.getState().jump).toEqual({ pid: "A", line: 2 });
});

test("deleting a transcript takes everything keyed to it, and leaves no undo", () => {
  const s = () => useStore.getState();
  useStore.setState({
    transcripts: { A: { lines: [{ id: 1, ts: "", speaker: "P", text: "x" }] }, B: { lines: [] } },
    tabs: ["A", "B"], pinnedTabs: ["A"], active: "A",
    segments: [{ sid: 5, pid: "A", start: 1, end: 1, code: "c", proposedBy: "me", status: "accepted", notes: "" }],
    markers: [{ mid: 1, pid: "A", t: 0, event: "marker", code: "", label: "e", detail: "", raw: {} }],
    aiGrounds: { 5: { quotes: ["q"] } }, aiFlags: { "A:1": { hash: "h", spans: [] } },
    summaries: { A: "written" }, undoStack: [], redoStack: [],
  } as never);
  s().deleteTranscript("A");
  const st = s();
  expect(st.transcripts.A).toBeUndefined();
  expect(st.segments).toEqual([]);
  expect(st.markers).toEqual([]);
  expect(st.aiGrounds[5]).toBeUndefined();
  expect(st.aiFlags["A:1"]).toBeUndefined();
  expect(st.summaries.A).toBeUndefined();
  expect(st.tabs).toEqual(["B"]);
  expect(st.pinnedTabs).toEqual([]);
  expect(st.active).toBe("B");
  // snapshots don't carry transcripts, so an undo here would restore coding
  // pointing at a transcript that no longer exists
  expect(st.undoStack).toEqual([]);
});

test("clearing a transcript's events is one undoable step and spares the others", () => {
  const s = () => useStore.getState();
  useStore.setState({
    transcripts: { A: { lines: [] }, B: { lines: [] } }, tabs: ["A", "B"], active: "A", segments: [],
    markers: [
      { mid: 1, pid: "A", t: 0, event: "marker", code: "", label: "a1", detail: "", raw: {} },
      { mid: 2, pid: "A", t: 1, event: "marker", code: "", label: "a2", detail: "", raw: {} },
      { mid: 3, pid: "B", t: 0, event: "marker", code: "", label: "b1", detail: "", raw: {} },
    ],
    undoStack: [], redoStack: [],
  } as never);
  expect(s().clearMarkers("A")).toBe(2);
  expect(s().markers.map((m) => m.mid)).toEqual([3]);
  s().undo();
  expect(s().markers.map((m) => m.mid)).toEqual([1, 2, 3]);
});

test("unpinning moves the tab out of the pinned block, not just off the pin list", () => {
  const s = () => useStore.getState();
  useStore.setState({
    transcripts: { A: { lines: [] }, B: { lines: [] }, C: { lines: [] }, D: { lines: [] } },
    tabs: ["A", "B", "C", "D"], pinnedTabs: [], active: "A", segments: [],
  } as never);
  s().togglePinTab("C");
  s().togglePinTab("D");
  expect(s().tabs).toEqual(["C", "D", "A", "B"]);
  // C unpins: it lands at the head of the unpinned group, behind the pin that stays
  s().togglePinTab("C");
  expect(s().pinnedTabs).toEqual(["D"]);
  expect(s().tabs).toEqual(["D", "C", "A", "B"]);
  // and the last pin leaving keeps the order it left behind
  s().togglePinTab("D");
  expect(s().pinnedTabs).toEqual([]);
  expect(s().tabs).toEqual(["D", "C", "A", "B"]);
});
