// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, expect, it } from "vitest";
import { BASE_COLORS, PALETTE, conflictGraph, pickNewColor, recolorPlan, colorDistance,
  type SegSpan } from "./codeColors";

const seg = (pid: string, start: number, end: number, code: string, status = "accepted"): SegSpan =>
  ({ pid, start, end, code, status });

describe("the palette", () => {
  it("keeps the twelve hand-picked hues first, then widens", () => {
    expect(PALETTE.slice(0, 12)).toEqual(BASE_COLORS);
    expect(PALETTE.length).toBe(36);
  });

  it("holds no duplicates — a repeat would be an invisible collision", () => {
    expect(new Set(PALETTE.map((c) => c.toLowerCase())).size).toBe(PALETTE.length);
  });

  it("is all valid hex", () => {
    for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("pickNewColor", () => {
  it("takes the first unused colour, so a fresh codebook walks the hues in order", () => {
    expect(pickNewColor([])).toBe(PALETTE[0]);
    expect(pickNewColor([PALETTE[0]])).toBe(PALETTE[1]);
    expect(pickNewColor(PALETTE.slice(0, 5))).toBe(PALETTE[5]);
  });

  it("does not repeat after a delete — the bug a size counter had", () => {
    // three codes created, the middle one deleted: the counter would hand out
    // PALETTE[2], which the third code already holds
    const remaining = [PALETTE[0], PALETTE[2]];
    expect(pickNewColor(remaining)).toBe(PALETTE[1]);
  });

  it("falls back to the least used once every colour is taken", () => {
    const used = [...PALETTE, ...PALETTE.slice(1)]; // PALETTE[0] used once, rest twice
    expect(pickNewColor(used)).toBe(PALETTE[0]);
  });
});

describe("conflictGraph", () => {
  it("links codes whose ranges overlap on one transcript", () => {
    const g = conflictGraph([seg("P01", 1, 5, "a"), seg("P01", 4, 8, "b")]);
    expect(g.get("a")).toEqual(new Set(["b"]));
    expect(g.get("b")).toEqual(new Set(["a"]));
  });

  it("leaves codes that never share a line unlinked", () => {
    const g = conflictGraph([seg("P01", 1, 3, "a"), seg("P01", 7, 9, "b")]);
    expect(g.get("a")).toBeUndefined();
  });

  it("does not link across transcripts — they are never on screen together", () => {
    const g = conflictGraph([seg("P01", 1, 5, "a"), seg("P02", 1, 5, "b")]);
    expect(g.size).toBe(0);
  });

  it("ignores rejected segments, which are not drawn as coding", () => {
    const g = conflictGraph([seg("P01", 1, 5, "a"), seg("P01", 1, 5, "b", "rejected")]);
    expect(g.size).toBe(0);
  });

  it("treats a shared single line as a conflict", () => {
    const g = conflictGraph([seg("P01", 4, 4, "a"), seg("P01", 4, 4, "b")]);
    expect(g.get("a")).toEqual(new Set(["b"]));
  });
});

describe("recolorPlan", () => {
  it("never gives two codes on the same line the same colour", () => {
    const segs = [seg("P01", 1, 5, "a"), seg("P01", 1, 5, "b"), seg("P01", 3, 6, "c")];
    const plan = recolorPlan(["a", "b", "c"], conflictGraph(segs));
    expect(plan.a).not.toBe(plan.b);
    expect(plan.b).not.toBe(plan.c);
    expect(plan.a).not.toBe(plan.c);
  });

  it("holds even when far more codes co-occur than there are base hues", () => {
    const codes = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const segs = codes.map((c) => seg("P01", 1, 2, c)); // all twenty on one line
    const plan = recolorPlan(codes, conflictGraph(segs));
    expect(new Set(Object.values(plan)).size).toBe(20); // twenty distinct colours
  });

  it("still spreads codes that never meet — a shared colour is only ever a fallback", () => {
    // co-occurrence is the HARD constraint; being distinct anyway is the soft
    // preference, because the codebook list shows every code together even when
    // the transcripts never are
    const plan = recolorPlan(["a", "b"], conflictGraph([seg("P01", 1, 2, "a"), seg("P02", 8, 9, "b")]));
    expect(plan.a).not.toBe(plan.b);
  });

  it("only reuses a colour once there are more codes than the palette holds", () => {
    const codes = Array.from({ length: PALETTE.length + 4 }, (_, i) => `c${i}`);
    const plan = recolorPlan(codes, new Map()); // no conflicts at all
    expect(new Set(Object.values(plan)).size).toBe(PALETTE.length); // every colour used once before any repeat
  });

  it("keeps pinned colours and colours the rest around them", () => {
    const segs = [seg("P01", 1, 5, "a"), seg("P01", 1, 5, "b")];
    const plan = recolorPlan(["a", "b"], conflictGraph(segs), { a: "#123456" });
    expect(plan.a).toBe("#123456");
    expect(plan.b).not.toBe("#123456");
  });

  it("puts visibly different colours on neighbours, not merely unequal ones", () => {
    const segs = [seg("P01", 1, 5, "a"), seg("P01", 1, 5, "b")];
    const plan = recolorPlan(["a", "b"], conflictGraph(segs));
    expect(colorDistance(plan.a, plan.b)).toBeGreaterThan(40);
  });

  it("is deterministic — the same codebook recolours the same way twice", () => {
    const segs = [seg("P01", 1, 5, "x"), seg("P01", 4, 9, "y"), seg("P01", 8, 12, "z")];
    const g = conflictGraph(segs);
    expect(recolorPlan(["x", "y", "z"], g)).toEqual(recolorPlan(["z", "y", "x"], g));
  });

  it("colours a codebook with no coding at all", () => {
    const plan = recolorPlan(["a", "b"], new Map());
    expect(Object.keys(plan)).toEqual(["a", "b"]);
  });
});
