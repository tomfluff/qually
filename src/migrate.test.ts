// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Persisted-state migration: a state written by an OLDER build (fields missing,
// minimap width under the new floor) must rehydrate into today's shape.
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
  // an old persisted state: minimapWidth 44 (old bounds), none of the new ui fields
  mem["coding-app-state"] = JSON.stringify({
    version: 0,
    state: {
      transcripts: {}, segments: [], codebook: {}, extSegRows: [],
      tabs: [], active: "browse",
      hotbar: { mode: "auto", pinned: [] }, video: {},
      ui: {
        fontSize: 16, sidebarFontSize: 13, dark: false, zen: false,
        sidebarWidth: 250, browseLeftWidth: 264, palettePos: "auto", helpSeen: true,
        mergeLines: false, showLineNumbers: false, accent: "violet",
        speakerNames: "full", warnCorner: "right", warnSize: "sm", laneWidth: "md",
        minimapWidth: 44, minimapDetail: "detailed", showNotices: true,
      },
      ai: { model: "gpt-5", redactTerms: [] },
      aiFlags: {}, aiLog: [],
    },
  });
  ({ useStore } = await import("./state/store"));
});

test("old persisted state rehydrates into today's shape", () => {
  const ui = useStore.getState().ui;
  expect(ui.minimapWidth).toBe(64);        // 44 pulled up to the new floor
  expect(ui.hiddenLenses).toEqual([]);     // fields added after that state was written
  expect(ui.scrollSpeed).toBe(1);
  expect(ui.loopEdit).toBe(true);
  expect(ui.loopSpeed).toBe(0.75);
  expect(ui.speakerFocus).toEqual({});  // pre-per-transcript scalar resets to everyone
  expect(ui.focusDim).toBe(true);
  expect(ui.focusCollapse).toBe(false);
  expect(ui.smoothScroll).toBe(false);
  expect(ui.speakerColors).toEqual({});
  expect(useStore.getState().ai.lenses).toEqual(["transcription"]);
});
