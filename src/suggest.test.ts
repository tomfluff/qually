// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F3 suggest: the trust boundary (sanitizeSuggestReply) and overlap memory.
import { test, expect } from "vitest";
import { sanitizeSuggestReply, overlapsExisting, type SuggestCode, type SuggestProposal } from "./ai/suggest";
import type { Line } from "./state/store";

const L = (id: number, text: string): Line => ({ id, ts: "", speaker: "Pat", text });
const lines: Line[] = [L(1, "a"), L(2, "b"), L(3, "c")];
const codes: SuggestCode[] = [{ name: "magnification", def: "", excerpts: [] }];

test("keeps in-window proposals with known codes, normalises range, drops the rest", () => {
  const out = sanitizeSuggestReply(codes, lines, [
    { line_start: 3, line_end: 2, code: "magnification" },   // reversed -> 2..3
    { line_start: 1, line_end: 9, code: "magnification" },   // 9 not in window -> drop
    { line_start: 1, line_end: 1, code: "invented" },        // unknown code -> drop
  ]);
  expect(out).toEqual([{ startLine: 2, endLine: 3, code: "magnification" }]);
});

test("identical proposals dedupe", () => {
  const out = sanitizeSuggestReply(codes, lines, [
    { line_start: 1, line_end: 2, code: "magnification" },
    { line_start: 2, line_end: 1, code: "magnification" },
  ]);
  expect(out).toHaveLength(1);
});

test("overlapsExisting skips a range already carrying that code (any status)", () => {
  const segs = [{ pid: "P01", start: 2, end: 4, code: "magnification", status: "rejected" }];
  const p: SuggestProposal = { startLine: 3, endLine: 5, code: "magnification" };
  expect(overlapsExisting(segs, "P01", p)).toBe(true);
  expect(overlapsExisting(segs, "P01", { startLine: 6, endLine: 7, code: "magnification" })).toBe(false);
  expect(overlapsExisting(segs, "P01", { startLine: 3, endLine: 5, code: "frustration" })).toBe(false);
});
