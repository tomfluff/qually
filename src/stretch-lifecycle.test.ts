// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Stretches live on line ids of a named transcript, so every operation that
// renames, deletes, or re-imports a transcript must carry them along — an
// orphaned or unremapped stretch silently re-labels the wrong text, which is
// exactly the comparison axis the feature exists to keep honest.
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

const csv = (lines: [number, string][]) =>
  "line_id,timestamp,speaker,text,codes\n" +
  lines.map(([id, text]) => `${id},00:00:0${id},P,${text},`).join("\n") + "\n";

beforeEach(async () => {
  useStore.getState().newProject();
  await useStore.getState().importFiles([new File([csv(
    [[1, "one"], [2, "two"], [3, "three"], [4, "four"]],
  )], "P01.csv")]);
});

test("rename carries stretches to the new pid", () => {
  const st = useStore.getState();
  st.markStretch({ pid: "P01", start: 1, end: 3, dim: "condition", value: "baseline" });
  expect(st.renameTranscript("P01", "S01")).toBeNull();
  expect(useStore.getState().stretches).toEqual(
    [{ pid: "S01", start: 1, end: 3, dim: "condition", value: "baseline" }]);
});

test("delete prunes the transcript's stretches", () => {
  const st = useStore.getState();
  st.markStretch({ pid: "P01", start: 1, end: 3, dim: "condition", value: "baseline" });
  st.deleteTranscript("P01");
  expect(useStore.getState().stretches).toEqual([]);
});

test("re-import Update remaps stretch endpoints like segments", async () => {
  useStore.getState().markStretch({ pid: "P01", start: 2, end: 3, dim: "condition", value: "baseline" });
  // a line inserted before the stretch shifts every id below it by one
  await useStore.getState().importFiles([new File([csv(
    [[1, "one"], [2, "inserted"], [3, "two"], [4, "three"], [5, "four"]],
  )], "P01.csv")]);
  expect(useStore.getState().pendingImports).toHaveLength(1);
  useStore.getState().resolveImport("update");
  expect(useStore.getState().stretches).toEqual(
    [{ pid: "P01", start: 3, end: 4, dim: "condition", value: "baseline" }]);
});

test("re-import Replace drops the old stretches instead of reattaching them", async () => {
  useStore.getState().markStretch({ pid: "P01", start: 1, end: 4, dim: "condition", value: "baseline" });
  await useStore.getState().importFiles([new File([csv(
    [[1, "different"], [2, "text"]],
  )], "P01.csv")]);
  useStore.getState().resolveImport("replace");
  expect(useStore.getState().stretches).toEqual([]);
});
