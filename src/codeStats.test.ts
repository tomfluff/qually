// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Code evidence counts and the orders the Definitions surfaces offer.
import { test, expect } from "vitest";
import { codeStats, sortCodes } from "./codeStats";
import type { Segment } from "./state/store";

const seg = (sid: number, pid: string, code: string, status = "accepted"): Segment =>
  ({ sid, pid, start: 1, end: 1, code, status, proposedBy: "(default)" } as Segment);
const loaded = { P01: {}, P02: {} };

test("counts accepted segments and the transcripts they span", () => {
  const s = codeStats([
    seg(1, "P01", "wide"), seg(2, "P02", "wide"),
    seg(3, "P01", "deep"), seg(4, "P01", "deep"), seg(5, "P01", "deep"),
  ], loaded);
  expect(s.wide).toEqual({ segs: 2, pids: 2 });
  expect(s.deep).toEqual({ segs: 3, pids: 1 });
});

test("candidate/rejected codings and unloaded transcripts are not evidence", () => {
  const s = codeStats([
    seg(1, "P01", "a", "candidate"), seg(2, "P01", "a", "rejected"),
    seg(3, "GONE", "a"), seg(4, "P01", "a"),
  ], loaded);
  expect(s.a).toEqual({ segs: 1, pids: 1 });
});

test("each sort orders by its own measure, ties falling back to the name", () => {
  const stats = { deep: { segs: 3, pids: 1 }, wide: { segs: 2, pids: 2 }, thin: { segs: 2, pids: 1 } };
  const names = ["wide", "deep", "thin"];
  expect(sortCodes(names, stats, "name")).toEqual(["deep", "thin", "wide"]);
  expect(sortCodes(names, stats, "excerpts")).toEqual(["deep", "thin", "wide"]); // 3, then 2·2 by name
  expect(sortCodes(names, stats, "transcripts")).toEqual(["wide", "deep", "thin"]);
});

test("a code with no stats sorts as zero rather than throwing", () => {
  expect(sortCodes(["b", "a"], {}, "excerpts")).toEqual(["a", "b"]);
});
