// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// renameTranscript: the pid is the key everywhere — every slice must follow,
// and invalid names must bounce with a message instead of corrupting keys.
import { beforeAll, test, expect } from "vitest";

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
1,00:00:03,P,I kept losing the tick marks,magnification
2,00:00:09,P,so I zoomed in further,
`,
  ], "P01.csv")]);
});

test("invalid names bounce with a message", () => {
  const st = useStore.getState();
  expect(st.renameTranscript("P01", "")).toMatch(/empty/);
  expect(st.renameTranscript("P01", "browse")).toMatch(/reserved/);
  expect(st.renameTranscript("P01", "assist")).toMatch(/reserved/);
  expect(st.renameTranscript("P01", "a:b")).toMatch(/:/);
  expect(st.renameTranscript("nope", "X")).toMatch(/unknown/);
  expect(st.renameTranscript("P01", "P01")).toBeNull(); // no-op, not an error
  expect(useStore.getState().transcripts.P01).toBeDefined(); // nothing moved
});

test("rename remaps every pid-keyed slice", () => {
  const st = useStore.getState();
  st.addFlags("P01", { 1: [{ quote: "tick marks", reason: "x", lens: "emotion" }] },
    st.transcripts.P01.lines, ["emotion"]);
  useStore.setState((s) => ({
    video: { ...s.video, P01: { offset: 3 } },
    ui: { ...s.ui, speakerFocus: { P01: "P" } },
    pinnedTabs: ["P01"],
  }));
  expect(useStore.getState().renameTranscript("P01", "S01")).toBeNull();
  const s = useStore.getState();
  expect(s.transcripts.S01.lines).toHaveLength(2);
  expect(s.transcripts.P01).toBeUndefined();
  expect(s.segments.every((x) => x.pid === "S01")).toBe(true);
  expect(s.tabs).toContain("S01");
  expect(s.pinnedTabs).toEqual(["S01"]);
  expect(s.active).toBe("S01");
  expect(s.aiFlags["S01:1"]).toBeDefined();
  expect(s.aiFlags["P01:1"]).toBeUndefined();
  expect(s.video.S01?.offset).toBe(3);
  expect(s.ui.speakerFocus).toEqual({ S01: "P" });
  expect(s.undoStack).toHaveLength(0); // stale-pid entries cleared
  // the coded-segments export speaks the new name
  expect(s.exportCSV()).toContain("S01:1");
});

test("renaming onto an existing transcript is refused", async () => {
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text,codes\n1,00:00:01,Q,aa,\n",
  ], "P02.csv")]);
  expect(useStore.getState().renameTranscript("P02", "S01")).toMatch(/exists/);
  expect(useStore.getState().transcripts.P02).toBeDefined();
});

test("pinning moves a tab to the front (in pin order); unpinning leaves it in place", () => {
  const st = useStore.getState();
  expect(st.pinnedTabs).toEqual(["S01"]); // survived the rename, still first
  st.togglePinTab("P02");
  expect(useStore.getState().tabs.slice(0, 2)).toEqual(["S01", "P02"]); // pin order
  useStore.getState().togglePinTab("S01"); // unpin the first
  expect(useStore.getState().tabs[0]).toBe("S01"); // position kept, claim released
  expect(useStore.getState().pinnedTabs).toEqual(["P02"]);
});

// these seed their own transcripts: the renameTranscript tests above have already
// renamed the imported one, so P01 is not theirs to assume
const twoTranscripts = () => useStore.setState({
  transcripts: {
    P01: { lines: [{ id: 1, ts: "00:00:01", speaker: "P", text: "a" }] },
    P02: { lines: [{ id: 1, ts: "00:00:01", speaker: "P", text: "b" }] },
  } as never,
  ui: { ...useStore.getState().ui, speakerColors: {}, speakerWeight: {}, speakerFocus: {} },
  undoStack: [], redoStack: [],
});

test("renameSpeaker rewrites every transcript and follows the speaker map", () => {
  twoTranscripts();
  useStore.setState({
    ui: { ...useStore.getState().ui, speakerColors: { P: "#123456" }, speakerFocus: { P01: "P" } },
  });
  expect(useStore.getState().renameSpeaker("P", "Ana")).toBeNull();
  const s = useStore.getState();
  // EVERY loaded transcript, not just the open one — one speaker map covers all
  expect(s.transcripts.P01.lines[0].speaker).toBe("Ana");
  expect(s.transcripts.P02.lines[0].speaker).toBe("Ana");
  expect(s.ui.speakerColors).toEqual({ Ana: "#123456" });
  expect(s.ui.speakerFocus).toEqual({ P01: "Ana" }); // the name lives in the VALUE here
});

test("renameSpeaker bounces empty names and unknown speakers", () => {
  twoTranscripts();
  expect(useStore.getState().renameSpeaker("P", "  ")).toMatch(/empty/);
  expect(useStore.getState().renameSpeaker("nobody", "X")).toMatch(/no lines/);
  expect(useStore.getState().renameSpeaker("P", "P")).toBeNull(); // no-op
  expect(useStore.getState().transcripts.P01.lines[0].speaker).toBe("P");
});

test("renaming onto an existing speaker merges, and the survivor keeps its styling", () => {
  useStore.setState({
    transcripts: { P01: { lines: [
      { id: 1, ts: "00:00:01", speaker: "R", text: "a" },
      { id: 2, ts: "00:00:02", speaker: "Ana", text: "b" },
    ] } } as never,
    ui: { ...useStore.getState().ui, speakerWeight: { R: "quiet" }, speakerColors: {} },
  });
  expect(useStore.getState().renameSpeaker("R", "Ana")).toBeNull();
  const s = useStore.getState();
  expect(s.transcripts.P01.lines.every((l) => l.speaker === "Ana")).toBe(true);
  // R's "quiet" must NOT ride along onto Ana, who was never dimmed
  expect(s.ui.speakerWeight).toEqual({});
});

test("renameSpeaker rewrites pending undo entries, so an undo can't resurrect the old name", () => {
  useStore.setState({
    transcripts: { P01: { lines: [{ id: 1, ts: "00:00:01", speaker: "Bo", text: "hi" }] } } as never,
    undoStack: [], redoStack: [],
  });
  useStore.getState().editLine("P01", 1, "hi there");     // pushes a line entry holding speaker "Bo"
  useStore.getState().renameSpeaker("Bo", "Bobby");
  useStore.getState().undo();
  expect(useStore.getState().transcripts.P01.lines[0].speaker).toBe("Bobby");
  expect(useStore.getState().transcripts.P01.lines[0].text).toBe("hi");
});

test("renaming a transcript carries its scroll position, it does not forget it", async () => {
  const { rememberScroll, savedScroll } = await import("./scrollMemory");
  useStore.setState({
    transcripts: { P9: { lines: [{ id: 1, ts: "", speaker: "P", text: "hi" }] } },
    tabs: ["P9"], active: "P9", segments: [],
  } as never);
  rememberScroll("P9", { line: 120, offset: 4 } as never);
  expect(useStore.getState().renameTranscript("P9", "P9-final")).toBe(null);
  // same transcript under a new name — forgetting threw the reader back to line 1
  expect(savedScroll["P9-final"]).toMatchObject({ line: 120 });
  expect(savedScroll.P9).toBeUndefined();
});
