// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Spread toggle's promise: clear the overlaps, keep the arrangement, and
// move as little as possible.
import { test, expect } from "vitest";
import { relaxBoxes, type RBox } from "./mapRelax";

const overlaps = (bs: RBox[], gap = 0) => {
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (Math.min(a.x + a.w + gap, b.x + b.w + gap) > Math.max(a.x, b.x)
      && Math.min(a.y + a.h + gap, b.y + b.h + gap) > Math.max(a.y, b.y)) n++;
  }
  return n;
};

test("separates overlapping boxes completely", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 300, h: 60 },
    { id: "b", x: 120, y: 10, w: 300, h: 60 },   // overlaps a
    { id: "c", x: 260, y: 20, w: 300, h: 60 },   // overlaps b (and a)
    { id: "d", x: 900, y: 400, w: 100, h: 40 },  // alone
  ];
  expect(overlaps(boxes)).toBeGreaterThan(0);
  expect(overlaps(relaxBoxes(boxes, 8))).toBe(0);
});

test("keeps the arrangement: left stays left, above stays above", () => {
  const boxes: RBox[] = [
    { id: "l", x: 0, y: 0, w: 400, h: 50 },
    { id: "r", x: 200, y: 0, w: 400, h: 50 },
    { id: "top", x: 0, y: 0, w: 50, h: 400 },
    { id: "bot", x: 0, y: 200, w: 50, h: 400 },
  ];
  const out = relaxBoxes(boxes, 8);
  const at = (id: string) => out.find((b) => b.id === id)!;
  expect(at("l").x).toBeLessThan(at("r").x);
  expect(at("top").y).toBeLessThan(at("bot").y);
});

test("leaves a settled layout untouched — no drift when nothing overlaps", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 100, h: 40 },
    { id: "b", x: 400, y: 0, w: 100, h: 40 },
    { id: "c", x: 0, y: 300, w: 100, h: 40 },
  ];
  expect(relaxBoxes(boxes, 8)).toEqual(boxes);
});

test("holds the centre: the map grows outward, it does not walk off", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 200, h: 60 },
    { id: "b", x: 50, y: 0, w: 200, h: 60 },
    { id: "c", x: 100, y: 0, w: 200, h: 60 },
  ];
  const mid = (bs: RBox[]) =>
    (Math.min(...bs.map((b) => b.x)) + Math.max(...bs.map((b) => b.x + b.w))) / 2;
  expect(mid(relaxBoxes(boxes, 8))).toBeCloseTo(mid(boxes), 6);
});
