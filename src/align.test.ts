import { describe, expect, it } from "vitest";
import { alignLines, remapSegment, previewImport } from "./align";
import type { Line, Segment } from "./state/store";

const L = (id: number, speaker: string, text: string): Line => ({ id, ts: "", speaker, text });
const S = (sid: number, start: number, end: number): Segment =>
  ({ sid, pid: "p1", start, end, code: "c", notes: "", proposedBy: "tom", status: "accepted" });

const BASE = [
  L(1, "R", "How do you read a chart?"),
  L(2, "P", "I zoom in really close."),
  L(3, "P", "Then I pan across to follow the line."),
  L(4, "R", "And then?"),
  L(5, "P", "Then I lose the axis labels."),
];

describe("alignLines", () => {
  it("maps an identical re-import 1:1", () => {
    const { map, overlap } = alignLines(BASE, BASE.map((l) => ({ ...l })));
    expect(overlap).toBe(1);
    expect([...map]).toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  });

  it("follows a shift when a line is inserted", () => {
    const next = [
      L(1, "R", "How do you read a chart?"),
      L(2, "R", "Take your time."),          // inserted
      L(3, "P", "I zoom in really close."),
      L(4, "P", "Then I pan across to follow the line."),
      L(5, "R", "And then?"),
      L(6, "P", "Then I lose the axis labels."),
    ];
    const { map } = alignLines(BASE, next);
    expect(map.get(2)).toBe(3); // old line 2 is now line 3
    expect(map.get(5)).toBe(6);
  });

  it("recovers a line edited in place (typo fix) from its neighbours", () => {
    const next = BASE.map((l) => ({ ...l }));
    next[2] = L(3, "P", "Then I pan across to follow the trend line."); // reworded
    const { map } = alignLines(BASE, next);
    expect(map.get(3)).toBe(3); // still mapped, despite no exact text match
    expect(map.size).toBe(5);
  });

  it("drops lines deleted from the new file", () => {
    const next = [BASE[0], BASE[1], BASE[3], BASE[4]].map((l, i) => ({ ...l, id: i + 1 }));
    const { map } = alignLines(BASE, next);
    expect(map.has(3)).toBe(false); // "Then I pan across..." is gone
    expect(map.get(4)).toBe(3);
  });

  it("reports near-zero overlap for an unrelated transcript", () => {
    const other = [L(1, "P", "Completely different words."), L(2, "R", "Nothing in common here.")];
    expect(alignLines(BASE, other).overlap).toBeLessThan(0.25);
  });
});

describe("remapSegment", () => {
  it("moves a segment onto its new line ids", () => {
    const map = new Map([[2, 3], [3, 4]]);
    expect(remapSegment(S(1, 2, 3), map)).toEqual({ start: 3, end: 4 });
  });

  it("shrinks to the surviving lines when an edge line is deleted", () => {
    const map = new Map([[3, 3]]); // lines 2 and 4 gone
    expect(remapSegment(S(1, 2, 4), map)).toEqual({ start: 3, end: 3 });
  });

  it("returns null when every line in the range is gone", () => {
    expect(remapSegment(S(1, 2, 3), new Map([[9, 9]]))).toBeNull();
  });
});

describe("previewImport", () => {
  it("counts survivors and casualties", () => {
    const next = [BASE[0], BASE[1], BASE[3]].map((l, i) => ({ ...l, id: i + 1 })); // drop lines 3 and 5
    const segs = [S(1, 1, 2), S(2, 3, 3), S(3, 5, 5)];
    const p = previewImport(segs, BASE, next);
    expect(p.total).toBe(3);
    expect(p.remapped).toBe(1); // only the 1-2 segment survives intact
    expect(p.dropped).toBe(2);
    expect(p.different).toBe(false);
  });

  it("flags an unrelated file as a different transcript", () => {
    const other = [L(1, "P", "Nothing alike."), L(2, "R", "Truly nothing.")];
    expect(previewImport([S(1, 1, 2)], BASE, other).different).toBe(true);
  });
});
