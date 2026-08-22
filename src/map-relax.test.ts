// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// "Adjust to zoom" promises four things: clear every real overlap, move
// nothing that was already fine, prefer sideways room, and keep the
// arrangement recognisable.
import { test, expect } from "vitest";
import { relaxBoxes, type RBox } from "./mapRelax";

const overlaps = (bs: RBox[]) => {
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x)
      && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)) n++;
  }
  return n;
};

test("clears every real overlap", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 300, h: 60 },
    { id: "b", x: 120, y: 10, w: 300, h: 60 },
    { id: "c", x: 260, y: 20, w: 300, h: 60 },
    { id: "d", x: 900, y: 400, w: 100, h: 40 },
  ];
  expect(overlaps(boxes)).toBeGreaterThan(0);
  expect(overlaps(relaxBoxes(boxes))).toBe(0);
});

// the bug that made this unusable: a zoom-scaled margin was added to every box
// before testing for overlap, so comfortable neighbours were "colliding"
test("leaves things that merely sit near each other completely alone", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 100, h: 30 },
    { id: "b", x: 140, y: 0, w: 100, h: 30 },     // 40px clear
    { id: "c", x: 0, y: 90, w: 100, h: 30 },      // 60px clear
    { id: "d", x: 300, y: 300, w: 100, h: 30 },
  ];
  expect(relaxBoxes(boxes)).toEqual(boxes);
});

test("a crowd of untouched codes stays put while one collision is fixed", () => {
  const field: RBox[] = Array.from({ length: 20 }, (_, i) => ({
    id: `code${i}`, x: (i % 5) * 200, y: Math.floor(i / 5) * 80, w: 150, h: 30,
  }));
  const clash: RBox[] = [
    { id: "big", x: 1200, y: 0, w: 300, h: 60 },
    { id: "onTop", x: 1250, y: 20, w: 300, h: 60 },
  ];
  const out = relaxBoxes([...field, ...clash]);
  const moved = out.filter((b) => {
    const was = [...field, ...clash].find((x) => x.id === b.id)!;
    return Math.abs(b.x - was.x) > 0.5 || Math.abs(b.y - was.y) > 0.5;
  });
  expect(moved.map((m) => m.id).sort()).toEqual(["big", "onTop"]);
  expect(overlaps(out)).toBe(0);
});

// codebook maps are wide and shallow, so "cheapest axis" meant "always down",
// which stacked the map into a column
test("separates sideways, not downward, for wide shallow boxes", () => {
  const boxes: RBox[] = [
    { id: "l", x: 0, y: 0, w: 400, h: 40 },
    { id: "r", x: 380, y: 8, w: 400, h: 40 },   // slim horizontal overlap
  ];
  const out = relaxBoxes(boxes);
  const l = out.find((b) => b.id === "l")!, r = out.find((b) => b.id === "r")!;
  expect(Math.abs(l.y - 0)).toBeLessThan(1);     // nothing moved vertically
  expect(Math.abs(r.y - 8)).toBeLessThan(1);
  expect(r.x - l.x).toBeGreaterThan(380);        // pushed apart sideways
});

test("falls back to a vertical push when sideways would cost far more", () => {
  // near-total horizontal overlap, barely any vertical: pushing sideways would
  // travel the whole width, so down is the honest answer
  const boxes: RBox[] = [
    { id: "top", x: 0, y: 0, w: 400, h: 60 },
    { id: "under", x: 2, y: 54, w: 400, h: 60 },
  ];
  const out = relaxBoxes(boxes);
  const t = out.find((b) => b.id === "top")!, u = out.find((b) => b.id === "under")!;
  expect(u.y - t.y).toBeGreaterThan(60);
  expect(Math.abs((u.x - t.x) - 2)).toBeLessThan(1); // and it did NOT slide sideways
});

test("keeps the arrangement: left stays left, above stays above", () => {
  const boxes: RBox[] = [
    { id: "l", x: 0, y: 0, w: 400, h: 50 },
    { id: "r", x: 200, y: 0, w: 400, h: 50 },
    { id: "top", x: 0, y: 0, w: 50, h: 400 },
    { id: "bot", x: 0, y: 200, w: 50, h: 400 },
  ];
  const out = relaxBoxes(boxes);
  const at = (id: string) => out.find((b) => b.id === id)!;
  expect(at("l").x).toBeLessThan(at("r").x);
  expect(at("top").y).toBeLessThan(at("bot").y);
});

test("grows around the crowding instead of translating the whole map", () => {
  const boxes: RBox[] = [
    { id: "a", x: 0, y: 0, w: 200, h: 60 },
    { id: "b", x: 50, y: 0, w: 200, h: 60 },
    { id: "c", x: 100, y: 0, w: 200, h: 60 },
    { id: "far", x: 3000, y: 3000, w: 100, h: 40 },   // nowhere near the crowd
  ];
  const out = relaxBoxes(boxes);
  const far = out.find((b) => b.id === "far")!;
  expect({ x: far.x, y: far.y }).toEqual({ x: 3000, y: 3000 }); // never nudged
  const mid = (bs: RBox[]) => {
    const three = bs.filter((b) => b.id !== "far");
    return (Math.min(...three.map((b) => b.x)) + Math.max(...three.map((b) => b.x + b.w))) / 2;
  };
  // a couple of px of drift from pairwise ordering is fine; a translation
  // would be tens of px
  expect(Math.abs(mid(out) - mid(boxes))).toBeLessThan(3);
});
