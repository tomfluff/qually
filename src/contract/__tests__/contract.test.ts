import { test, expect } from "vitest";
import { parseCSV, toCSV } from "../csv";
import {
  norm, collapseRuns, parseSegRef, formatSegRef, dedupKey, resolveAliases,
  type CodedLine,
} from "../segments";
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

// ── segment_ref parse/format ────────────────────────────────────────
test("segment_ref parse + format", () => {
  expect(parseSegRef("P07:44-47")).toEqual({ pid: "P07", start: 44, end: 47 });
  expect(parseSegRef("P01:3")).toEqual({ pid: "P01", start: 3, end: 3 });
  expect(parseSegRef("garbage")).toBeNull();
  expect(formatSegRef("P07", 44, 47)).toBe("P07:44-47");
  expect(formatSegRef("P01", 3, 3)).toBe("P01:3");
});

// ── alias-resolved dedup ────────────────────────────────────────────
test("resolveAliases follows merged-into chains; dedup key uses canonical", () => {
  const aliases = resolveAliases([
    { code: "Visual strain", status: "candidate" },
    { code: "eye fatigue", status: "merged-into: Visual strain" },
    { code: "tired eyes", status: "merged-into: eye fatigue" },
  ]);
  expect(aliases.get(norm("tired eyes"))).toBe("Visual strain");
  expect(aliases.get(norm("eye fatigue"))).toBe("Visual strain");
  // two refs that resolve to the same canonical code collide on dedup key
  expect(dedupKey("P07:44-47", "eye fatigue")).toBe(dedupKey("P07:44-47", "Eye  Fatigue"));
});

// ── excerpt rule v2: the five W7#18 cases ───────────────────────────
const P = (text: string): ExLine => ({ speaker: "P", text });
const R = (text: string): ExLine => ({ speaker: "R", text });

test("excerpt 1/5: all-P", () => {
  const r = excerptOf([P("charts are hard to read"), P("i zoom a lot")]);
  expect(r.excerpt).toBe("charts are hard to read i zoom a lot");
  expect(r.closeCall).toBe(false);
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
