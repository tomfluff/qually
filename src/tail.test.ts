// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The thin tail queue: what it puts in front of you, and what it stops asking.
import { describe, it, expect } from "vitest";
import { tailQueue, triaged } from "./components/TailQueue";
import type { Decision } from "./state/store";

const cb = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { def: "" }])) as Record<string, { def: string; parked?: boolean }>;
const stats = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([c, segs]) => [c, { segs, pids: 1 }]));
const d = (kind: Decision["kind"], codes: string[], extra: Partial<Decision> = {}): Decision =>
  ({ at: "", kind, codes, why: "", source: "you", ...extra });

describe("what the tail queue holds", () => {
  const book = cb("stray", "thin", "solid");
  const counts = stats({ stray: 1, thin: 2, solid: 9 });

  it("holds only the codes at or under the size you asked for", () => {
    expect(tailQueue(book, counts, [], 1)).toEqual(["stray"]);
    expect(tailQueue(book, counts, [], 2)).toEqual(["stray", "thin"]);
  });

  it("puts the thinnest first", () => {
    expect(tailQueue(cb("a", "b"), stats({ a: 2, b: 1 }), [], 2)).toEqual(["b", "a"]);
  });

  it("counts a code with no excerpts at all as thin", () => {
    expect(tailQueue(cb("empty"), {}, [], 1)).toEqual(["empty"]);
  });

  it("leaves out codes you have set aside", () => {
    const parked = { ...book, stray: { def: "", parked: true } };
    expect(tailQueue(parked, counts, [], 1)).toEqual([]);
  });

  it("stops asking once you have decided", () => {
    for (const kind of ["keep", "promote", "park", "merge", "delete", "remove"] as const) {
      expect(tailQueue(book, counts, [d(kind, ["stray"])], 1)).toEqual([]);
    }
  });

  it("asks again if the decision was undone", () => {
    expect(tailQueue(book, counts, [d("keep", ["stray"], { undone: true })], 1)).toEqual(["stray"]);
  });

  it("counts a code merged away elsewhere as dealt with", () => {
    // a merge row names survivor first, then what was folded in — both are done
    expect(triaged([d("merge", ["solid", "stray"])])).toEqual(new Set(["solid", "stray"]));
  });

  it("does not treat a turned-down proposal as a verdict on its codes", () => {
    // dismissing a merge says nothing about whether those codes are thin
    expect(tailQueue(book, counts, [d("dismiss", ["stray", "thin"])], 1)).toEqual(["stray"]);
  });
});
