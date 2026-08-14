// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The wheel scaling that now governs every scrolling surface in the app. The
// listener itself is four lines of DOM glue; these are the decisions it makes.
import { test, expect } from "vitest";
import { SCROLL_BASE, wheelPixels, hasRoom, nextTop } from "./scrollSpeed";

// what one wheel notch actually moves, at a given setting
const step = (deltaY: number, speed: number) => wheelPixels(deltaY, 0, 20, 500) * SCROLL_BASE * speed;

test("the shipped 100% moves half as far as the device asked for", () => {
  expect(step(120, 1)).toBe(60);
});

test("200% is the device's own speed", () => {
  expect(step(120, 2)).toBe(120);
});

test("line-mode devices step by the container's line height, page-mode by its viewport", () => {
  expect(wheelPixels(3, 1, 40, 500)).toBe(120); // three lines of a 40px-line list
  expect(wheelPixels(1, 2, 40, 500)).toBe(500); // one page is one viewport
  expect(wheelPixels(120, 0, 40, 500)).toBe(120); // pixels pass through
});

test("a container at its end has no room, so the scroll can chain past it", () => {
  expect(hasRoom(100, 200, 100, true)).toBe(false); // scrolled to the bottom
  expect(hasRoom(0, 200, 100, true)).toBe(true);
  expect(hasRoom(0, 200, 100, false)).toBe(false);  // already at the top
  expect(hasRoom(50, 200, 100, false)).toBe(true);
});

test("a list shorter than its viewport is never a target", () => {
  expect(hasRoom(0, 80, 100, true)).toBe(false);
  expect(hasRoom(0, 80, 100, false)).toBe(false);
});

test("scrolling never runs past either end", () => {
  expect(nextTop(0, 10000, 300, 100)).toBe(200);
  expect(nextTop(200, -10000, 300, 100)).toBe(0);
  expect(nextTop(0, 60, 1000, 100)).toBe(60);
  expect(nextTop(0, 50, 80, 100)).toBe(0); // content shorter than the box
});
