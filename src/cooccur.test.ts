// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { cooccurrence, pairOf, companionsOf } from "./cooccur";
import type { Segment } from "./state/store";

const seg = (pid: string, code: string, start: number, end: number, status = "accepted"): Segment =>
  ({ sid: Math.random(), pid, code, notes: "", proposedBy: "you", status, start, end });

describe("cooccurrence", () => {
  it("counts two codes sharing lines", () => {
    const m = cooccurrence([seg("P01", "a", 1, 4), seg("P01", "b", 3, 6)]);
    expect(pairOf(m, "a", "b")?.count).toBe(1);
    expect(pairOf(m, "b", "a")?.count).toBe(1); // order-free lookup
  });

  it("ignores segments that never overlap", () => {
    const m = cooccurrence([seg("P01", "a", 1, 2), seg("P01", "b", 3, 4)]);
    expect(pairOf(m, "a", "b")).toBeUndefined();
  });

  it("touching at one line IS overlap — one moment, two codes", () => {
    const m = cooccurrence([seg("P01", "a", 1, 3), seg("P01", "b", 3, 5)]);
    expect(pairOf(m, "a", "b")?.count).toBe(1);
  });

  it("never pairs across transcripts", () => {
    const m = cooccurrence([seg("P01", "a", 1, 4), seg("P02", "b", 1, 4)]);
    expect(pairOf(m, "a", "b")).toBeUndefined();
  });

  it("ignores candidates and rejected — only decisions count", () => {
    const m = cooccurrence([
      seg("P01", "a", 1, 4),
      seg("P01", "b", 2, 5, "candidate"),
      seg("P01", "c", 2, 5, "rejected"),
    ]);
    expect(m.size).toBe(0);
  });

  it("a code never co-occurs with itself, and case is folded", () => {
    const m = cooccurrence([seg("P01", "Reading", 1, 4), seg("P01", "reading", 2, 5)]);
    expect(m.size).toBe(0);
  });

  it("counts every overlapping pair and remembers the transcripts", () => {
    const m = cooccurrence([
      seg("P01", "a", 1, 4), seg("P01", "b", 2, 5),
      seg("P01", "a", 10, 12), seg("P01", "b", 11, 13),
      seg("P02", "a", 1, 2), seg("P02", "b", 2, 3),
    ]);
    const p = pairOf(m, "a", "b")!;
    expect(p.count).toBe(3);
    expect(p.pids.sort()).toEqual(["P01", "P02"]);
  });

  it("counts overlap EVENTS: the same pair overlapping via two segment pairs is 2", () => {
    // deliberate: this is not "do a and b ever co-occur" but "how often" —
    // two b segments inside one a segment are two co-coded moments
    const m = cooccurrence([
      seg("P01", "a", 1, 10), seg("P01", "b", 2, 3), seg("P01", "b", 5, 6),
    ]);
    expect(pairOf(m, "a", "b")?.count).toBe(2);
  });

  it("segments starting on the same line overlap", () => {
    const m = cooccurrence([seg("P01", "a", 3, 5), seg("P01", "b", 3, 4)]);
    expect(pairOf(m, "a", "b")?.count).toBe(1);
  });

  it("an early long segment still pairs with later ones (sweep keeps it open)", () => {
    const m = cooccurrence([
      seg("P01", "a", 1, 100),
      seg("P01", "b", 2, 3),
      seg("P01", "c", 50, 60),
    ]);
    expect(pairOf(m, "a", "b")?.count).toBe(1);
    expect(pairOf(m, "a", "c")?.count).toBe(1);
    expect(pairOf(m, "b", "c")).toBeUndefined();
  });
});

describe("companionsOf", () => {
  const m = cooccurrence([
    seg("P01", "a", 1, 4), seg("P01", "b", 2, 5),
    seg("P01", "a", 10, 12), seg("P01", "b", 11, 13),
    seg("P01", "a", 20, 22), seg("P01", "c", 21, 23),
  ]);

  it("lists companions by how often they share lines", () => {
    expect(companionsOf(m, "a", 1).map((c) => c.name)).toEqual(["b", "c"]);
  });

  it("the floor drops one-off coincidence", () => {
    expect(companionsOf(m, "a").map((c) => c.name)).toEqual(["b"]);
  });

  it("a code with no companions gets an empty list", () => {
    expect(companionsOf(m, "zzz")).toEqual([]);
  });
});
