// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Store paths added for the AI features: the reserved-view predicate and the
// grounding-record pruning when a segment is deleted.
import { beforeAll, test, expect } from "vitest";
import { isTranscriptView } from "./state/store";

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

test("isTranscriptView: the two reserved views are not transcripts", () => {
  expect(isTranscriptView("browse")).toBe(false);
  expect(isTranscriptView("assist")).toBe(false);
  expect(isTranscriptView("P01")).toBe(true);
  expect(isTranscriptView("anything-else")).toBe(true);
});

test("deleteSegment prunes only that segment's grounding record", () => {
  const st = useStore.getState();
  st.addSegment("P01", 1, 1, "magnification", "(default)", "accepted");
  st.addSegment("P01", 2, 2, "frustration", "(default)", "accepted");
  const [a, b] = useStore.getState().segments.slice(-2);
  st.addGrounds({ [a.sid]: { hash: "h1", quotes: ["x"] }, [b.sid]: { hash: "h2", quotes: ["y"] } });
  expect(useStore.getState().aiGrounds[a.sid]).toBeDefined();

  st.deleteSegment(a.sid);
  expect(useStore.getState().aiGrounds[a.sid]).toBeUndefined();  // pruned
  expect(useStore.getState().aiGrounds[b.sid]).toBeDefined();    // sibling survives
});
