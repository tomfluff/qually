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
