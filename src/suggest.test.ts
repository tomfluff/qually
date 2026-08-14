// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F3 suggest: the trust boundary (sanitizeSuggestReply) and overlap memory.
import { test, expect } from "vitest";
import { renderSuggestChunk, sanitizeSuggestReply, overlapsExisting, type SuggestCode, type SuggestProposal } from "./ai/suggest";
import { redactor } from "./ai/redact";
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

test("non-integer or missing endpoints are dropped; empty reply is empty", () => {
  expect(sanitizeSuggestReply(codes, lines, [])).toEqual([]);
  const out = sanitizeSuggestReply(codes, lines, [
    { line_start: 1.5, line_end: 2, code: "magnification" },                        // non-integer -> drop
    { line_start: 1, line_end: undefined as unknown as number, code: "magnification" }, // missing -> drop
    { line_start: 1, line_end: 2, code: "magnification" },                          // valid
  ]);
  expect(out).toEqual([{ startLine: 1, endLine: 2, code: "magnification" }]);
});

test("overlapsExisting skips a range already carrying that code (any status)", () => {
  const segs = [{ pid: "P01", start: 2, end: 4, code: "magnification", status: "rejected" }];
  const p: SuggestProposal = { startLine: 3, endLine: 5, code: "magnification" };
  expect(overlapsExisting(segs, "P01", p)).toBe(true);
  expect(overlapsExisting(segs, "P01", { startLine: 6, endLine: 7, code: "magnification" })).toBe(false);
  expect(overlapsExisting(segs, "P01", { startLine: 3, endLine: 5, code: "frustration" })).toBe(false);
});

// ── context speakers (researcher lines ride along, never coded) ─────────────
const R = (id: number, text: string): Line => ({ id, ts: "", speaker: "R", text });
const mixed: Line[] = [R(1, "How do you read this?"), L(2, "I zoom in."), R(3, "Say more?"), L(4, "Then I pan.")];

test("a proposal covering only context lines is dropped; crossing one survives", () => {
  const ctx = new Set(["R"]);
  const out = sanitizeSuggestReply(codes, mixed, [
    { line_start: 1, line_end: 1, code: "magnification" },   // R only -> drop
    { line_start: 3, line_end: 3, code: "magnification" },   // R only -> drop
    { line_start: 2, line_end: 4, code: "magnification" },   // spans R line 3, has P lines -> keep
  ], ctx);
  expect(out).toEqual([{ startLine: 2, endLine: 4, code: "magnification" }]);
  // without a context set the same reply passes untouched (back-compat)
  expect(sanitizeSuggestReply(codes, mixed, [{ line_start: 1, line_end: 1, code: "magnification" }]))
    .toHaveLength(1);
});

test("the rendered window tags context speakers and only them", () => {
  const out = renderSuggestChunk(mixed, codes, redactor([]), new Set(["R"]));
  const rows = out.split("TRANSCRIPT:\n")[1].split("\n");
  expect(rows[0]).toBe("1\t[context] R\tHow do you read this?");
  expect(rows[1]).toBe("2\tPat\tI zoom in.");
});

test("bulk delete clears one status, leaves the others, and is one undo step", async () => {
  const { useStore } = await import("./state/store");
  useStore.setState({
    transcripts: {
      P01: { lines: [{ id: 1, ts: "", speaker: "P", text: "a" }, { id: 2, ts: "", speaker: "P", text: "b" }] },
      P02: { lines: [{ id: 1, ts: "", speaker: "P", text: "c" }] },
    },
    codebook: { c: { color: "#123456", def: "", status: "accepted" } },
    segments: [
      { sid: 1, pid: "P01", start: 1, end: 1, code: "c", proposedBy: "ai", status: "candidate", notes: "" },
      { sid: 2, pid: "P01", start: 2, end: 2, code: "c", proposedBy: "ai", status: "rejected", notes: "" },
      { sid: 3, pid: "P02", start: 1, end: 1, code: "c", proposedBy: "ai", status: "rejected", notes: "" },
      { sid: 4, pid: "P01", start: 1, end: 2, code: "c", proposedBy: "me", status: "accepted", notes: "" },
    ],
    aiGrounds: { 2: { quotes: ["x"] } },
    tabs: ["P01", "P02"], active: "P01", undoStack: [], redoStack: [],
  } as never);

  // one transcript only
  expect(useStore.getState().deleteSegmentsBy({ pid: "P01", status: "rejected" })).toBe(1);
  expect(useStore.getState().segments.map((x) => x.sid)).toEqual([1, 3, 4]);
  // the grounding of a deleted row goes with it
  expect(useStore.getState().aiGrounds[2]).toBeUndefined();

  // …and everywhere
  expect(useStore.getState().deleteSegmentsBy({ status: "rejected" })).toBe(1);
  expect(useStore.getState().segments.map((x) => x.sid)).toEqual([1, 4]);

  // accepted coding is never caught by a candidate/rejected sweep
  expect(useStore.getState().deleteSegmentsBy({ status: "candidate" })).toBe(1);
  expect(useStore.getState().segments.map((x) => x.sid)).toEqual([4]);
  expect(useStore.getState().deleteSegmentsBy({ status: "candidate" })).toBe(0); // nothing left to do

  // each sweep was one step
  useStore.getState().undo();
  expect(useStore.getState().segments.map((x) => x.sid)).toEqual([1, 4]);
});
