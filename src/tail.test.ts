// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The thin tail queue: what it puts in front of you, and what it stops asking.
import { describe, it, expect } from "vitest";
import { tailQueue, tailSequence, triaged, lastVerdicts } from "./components/TailQueue";
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
    for (const kind of ["keep", "promote", "park", "remove"] as const) {
      expect(tailQueue(book, counts, [d(kind, ["stray"])], 1)).toEqual([]);
    }
    // …but a merge marks nobody: the survivor now holds excerpts nobody read
    expect(tailQueue(book, counts, [d("merge", ["stray", "gone"])], 1)).toEqual(["stray"]);
  });

  it("asks about a name recoded after a delete — a name is not an identity", () => {
    // the ledger row is about a code that no longer exists; a live code with
    // the same name is a NEW code that has not been read. A WITHDRAWN code is
    // different: it is still in the book, and it was just decided about.
    expect(tailQueue(book, counts, [d("delete", ["stray"])], 1)).toEqual(["stray"]);
    expect(tailQueue(book, counts, [d("remove", ["stray"])], 1)).toEqual([]);
    // same for a name that was folded away and later typed again
    expect(tailQueue(book, counts, [d("merge", ["solid", "stray"])], 1)).toEqual(["stray"]);
  });

  it("asks again if the decision was undone", () => {
    expect(tailQueue(book, counts, [d("keep", ["stray"], { undone: true })], 1)).toEqual(["stray"]);
  });

  it("treats a merge as read by nobody", () => {
    // the folded-away name is out of the book; the survivor holds evidence
    // that has just changed under it and gets asked about if it is still thin
    expect(triaged([d("merge", ["solid", "stray"])])).toEqual(new Set());
  });

  it("does not treat a turned-down proposal as a verdict on its codes", () => {
    // dismissing a merge says nothing about whether those codes are thin
    expect(tailQueue(book, counts, [d("dismiss", ["stray", "thin"])], 1)).toEqual(["stray"]);
  });
});

describe("walking back through verdicts", () => {
  const book = cb("stray", "thin");
  const counts = stats({ stray: 1, thin: 1 });

  it("bringing a code back opens its card again", () => {
    const after = [d("park", ["stray"]), d("unpark", ["stray"])];
    expect(triaged(after).has("stray")).toBe(false);
    expect(tailQueue(book, counts, after, 1)).toEqual(["stray", "thin"]);
  });

  it("reports the verdict a card currently carries, and only the last one", () => {
    const v = lastVerdicts([d("keep", ["stray"]), d("promote", ["stray"])]);
    expect(v.get("stray")?.kind).toBe("promote");
    expect(v.get("stray")?.at).toBe(1);
  });

  it("forgets a verdict that was taken back", () => {
    expect(lastVerdicts([d("keep", ["stray"], { undone: true })]).has("stray")).toBe(false);
  });

  it("keeps every thin code in the sequence, decided or not, so you can walk back", () => {
    expect(tailSequence(book, counts, 1)).toEqual(["stray", "thin"]);
    // …including one set aside: changing your mind about it has to be reachable
    expect(tailSequence({ ...book, stray: { def: "", parked: true } }, counts, 1))
      .toEqual(["stray", "thin"]);
  });
});
