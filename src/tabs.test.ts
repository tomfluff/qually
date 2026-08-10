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
