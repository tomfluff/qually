// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { test, expect } from "vitest";
import { parseCSV, toCSV } from "../csv";
import { collapseRuns, formatSegRef, type CodedLine } from "../segments";
import { excerptOf, type ExLine } from "../excerpt";

// ── CSV round-trip with hostile content ─────────────────────────────
test("CSV round-trips commas, quotes, newlines", () => {
  const fields = ["segment_ref", "excerpt", "notes"];
  const rows = [
    { segment_ref: "P07:44-47", excerpt: 'he said "yes, absolutely"', notes: "line1\nline2" },
    { segment_ref: "P01:3", excerpt: "plain", notes: "" },
  ];
  const back = parseCSV(toCSV(rows, fields));
  expect(back).toEqual(rows);
});

test("a single-column empty value round-trips; blank lines still drop", () => {
  expect(parseCSV(toCSV([{ a: "" }, { a: "x" }], ["a"]))).toEqual([{ a: "" }, { a: "x" }]);
  expect(parseCSV('a\r\n""\r\n\r\nx\r\n')).toEqual([{ a: "" }, { a: "x" }]); // quoted "" kept, blank skipped
});

test("parseCSV drops fully-empty lines, keeps header trimming", () => {
  const rows = parseCSV(" a , b \r\n1,2\r\n\r\n3,4\r\n");
  expect(rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

// ── run-collapse (the P07 fixture) ──────────────────────────────────
// code A: contiguous 44-47, then non-contiguous again at 50.
// code B: 45-46, overlapping A on those lines (overlaps are legal).
test("collapseRuns: spans, one-line overlap, non-contiguous same code", () => {
  const L = (n: number, ...codes: string[]): CodedLine => ({ n, codes: new Set(codes) });
  const lines = [
    L(44, "A"), L(45, "A", "B"), L(46, "A", "B"), L(47, "A"),
    L(48), L(49), L(50, "A"),
  ];
  const runs = collapseRuns(lines);
  expect(runs.get("A")).toEqual([[44, 47], [50, 50]]);
  expect(runs.get("B")).toEqual([[45, 46]]);
});

test("segment_ref format", () => {
  expect(formatSegRef("P07", 44, 47)).toBe("P07:44-47");
  expect(formatSegRef("P01", 3, 3)).toBe("P01:3");
});

// ── excerpt rule v2: the five W7#18 cases ───────────────────────────
const P = (text: string): ExLine => ({ speaker: "P", text });
const R = (text: string): ExLine => ({ speaker: "R", text });

test("excerpt 1/5: all-P", () => {
  const r = excerptOf([P("charts are hard to read"), P("i zoom a lot")]);
  expect(r.excerpt).toBe("charts are hard to read i zoom a lot");
  expect(r.closeCall).toBe(false);
  expect(r.dropped).toEqual([]);
});

test("excerpt 2/5: all-R gets [R:] prefix", () => {
  const r = excerptOf([R("so you prefer magnification")]);
  expect(r.excerpt).toBe("[R:] so you prefer magnification");
  expect(r.closeCall).toBe(false);
});

test("excerpt 3/5: P-dominant with R backchannels drops R, no warn", () => {
  const r = excerptOf([R("mm"), P("i lean in close to the screen and trace each bar"), R("right")]);
  expect(r.excerpt).toBe("i lean in close to the screen and trace each bar");
  expect(r.closeCall).toBe(false);
  expect(r.dropped).toEqual([{ speaker: "R", lines: 2, chars: 7 }]);
});

test("excerpt reports its dominant speaker (Browse shows it as a field)", () => {
  expect(excerptOf([R("mm"), P("i lean in close and trace each bar")]).speaker).toBe("P");
  expect(excerptOf([R("so you prefer magnification")]).speaker).toBe("R");
  expect(excerptOf([]).speaker).toBe("");
  expect(excerptOf([]).dropped).toEqual([]);
});

test("excerpt 4/5: R-dominant member-check gets [R:], P assent drops", () => {
  const r = excerptOf([
    R("so what i'm hearing is that magnification helps but loses context"),
    P("yeah"),
  ]);
  expect(r.excerpt).toBe("[R:] so what i'm hearing is that magnification helps but loses context");
  expect(r.closeCall).toBe(false);
});

test("excerpt 5/5: near-tie sets closeCall", () => {
  const r = excerptOf([P("aaaaaaaaaaa"), R("bbbbbbbbb")]); // 11 vs 9 -> loser 45%
  expect(r.excerpt).toBe("aaaaaaaaaaa"); // P wins on chars
  expect(r.closeCall).toBe(true);
});

test("excerpt tie -> P wins", () => {
  const r = excerptOf([R("aaaaa"), P("bbbbb")]); // 5 vs 5 -> P
  expect(r.excerpt).toBe("bbbbb");
  expect(r.closeCall).toBe(true); // 50/50 is a close call
});

test("dropped speakers order by characters descending", () => {
  const r = excerptOf([
    { speaker: "B", text: "bbbb" },
    { speaker: "C", text: "cccccc" },
    { speaker: "P", text: "pppppppppp" },
  ]);
  expect(r.dropped).toEqual([
    { speaker: "C", lines: 1, chars: 6 },
    { speaker: "B", lines: 1, chars: 4 },
  ]);
});

test("dropped speaker character ties keep first-appearance order", () => {
  const r = excerptOf([
    { speaker: "Z", text: "zz" },
    { speaker: "A", text: "aa" },
    { speaker: "P", text: "pppppppppp" },
  ]);
  expect(r.dropped.map((d) => d.speaker)).toEqual(["Z", "A"]);
});

// A speaker whose only line is blank still HELD a line inside the range, and the
// Codebook's "n lines hidden" counts lines, not characters — so it has to appear
// here or the count would not add up to what the reader can see was skipped.
test("a losing speaker with an empty line is still reported, at zero characters", () => {
  const r = excerptOf([P("something worth reading"), R("   ")]);
  expect(r.excerpt).toBe("something worth reading");
  expect(r.dropped).toEqual([{ speaker: "R", lines: 1, chars: 0 }]);
});
