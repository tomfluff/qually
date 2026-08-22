// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The offline similarity pass: it must find the splinters a researcher would
// find by eye, and it must not claim relatives it cannot actually see.
import { test, expect } from "vitest";
import { findSimilar, scoreSimilar, tokens } from "./similar";

const BOOK = [
  { name: "difficult to see", def: "participant cannot make out the marks on a chart" },
  { name: "hard to see", def: "" },
  { name: "chart complexity", def: "the chart carries too much at once" },
  { name: "chart", def: "" },
  { name: "reading the chart", def: "" },
  { name: "needs zoom", def: "participant enlarges the view to continue" },
  { name: "belonging", def: "feeling part of the group" },
  { name: "care work", def: "" },
];

test("tokens drop stop words and fold word endings together", () => {
  expect(tokens("Reading the charts")).toEqual(["read", "chart"]);
  expect(tokens("difficult to see")).toEqual(["difficult", "see"]);
});

test("the same idea typed twice ranks first", () => {
  const out = findSimilar("difficult to see", BOOK);
  expect(out[0].name).toBe("hard to see");
  expect(out[0].why).toContain("see");
});

test("a name contained in another is a splinter signal", () => {
  const out = findSimilar("chart", BOOK).map((m) => m.name);
  expect(out).toContain("chart complexity");
  expect(out).toContain("reading the chart");
});

test("unrelated codes stay out of the list", () => {
  const out = findSimilar("difficult to see", BOOK).map((m) => m.name);
  expect(out).not.toContain("belonging");
  expect(out).not.toContain("care work");
});

test("it is honest about what it cannot see — a semantic relative sharing no words", () => {
  // "needs zoom" IS a relative of "difficult to see", but nothing in the
  // wording says so; this is exactly the gap the AI pass exists to close
  const out = findSimilar("difficult to see", BOOK).map((m) => m.name);
  expect(out).not.toContain("needs zoom");
});

test("definitions carry weight when the names share nothing", () => {
  const a = scoreSimilar(
    { name: "squinting", def: "participant cannot make out the marks on a chart" },
    { name: "difficult to see", def: "participant cannot make out the marks on a chart" },
  );
  const b = scoreSimilar({ name: "squinting", def: "" }, { name: "difficult to see", def: "" });
  expect(a.score).toBeGreaterThan(b.score);
});

test("the source never matches itself, and an unknown source returns nothing", () => {
  expect(findSimilar("difficult to see", BOOK).map((m) => m.name)).not.toContain("difficult to see");
  expect(findSimilar("ghost code", BOOK)).toEqual([]);
});

test("results are ranked, capped and deterministic", () => {
  const out = findSimilar("chart", BOOK, { cap: 2 });
  expect(out).toHaveLength(2);
  expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
  expect(findSimilar("chart", BOOK, { cap: 2 })).toEqual(out);
});
