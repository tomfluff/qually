// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, expect, it } from "vitest";
import { gatherCodeEvidence } from "./codeEvidence";
import type { Line, Segment } from "./state/store";

const segment = (sid: number, pid: string, code: string, status = "accepted", start = sid): Segment => ({
  sid, pid, start, end: start, code, status, notes: "", proposedBy: "you",
});
const lines = (...rows: [number, string][]): Line[] =>
  rows.map(([id, text]) => ({ id, text, speaker: "P", ts: "" }));

describe("AI code evidence gathering", () => {
  it("keeps only accepted, available, non-parked evidence and caps excerpts in segment order", () => {
    const transcripts = {
      present: { lines: lines([1, "first"], [2, "second"], [3, "third"], [4, ""]) },
    };
    const codebook = {
      live: { def: "kept definition" },
      parked: { def: "private", parked: true },
      empty: { def: "no usable excerpt" },
    };
    const segments = [
      segment(1, "present", "live"),
      segment(2, "present", "live"),
      segment(3, "present", "live"),
      segment(4, "present", "empty"),
      segment(5, "present", "parked", "accepted", 1),
      segment(6, "present", "live", "rejected", 1),
      segment(7, "missing", "live"),
    ];

    expect(gatherCodeEvidence(segments, transcripts, codebook, 2)).toEqual([
      { name: "live", def: "kept definition", excerpts: ["first", "second"] },
    ]);
  });

  it("honours scope and can retain live definition-only codes in scope order", () => {
    const transcripts = { present: { lines: lines([1, "alpha evidence"], [2, "outside evidence"]) } };
    const codebook = {
      alpha: { def: "A" },
      empty: { def: "E" },
      parked: { def: "P", parked: true },
      outside: { def: "O" },
    };
    const segments = [
      segment(1, "present", "alpha"),
      segment(2, "present", "outside"),
    ];
    const scope = new Set(["empty", "parked", "unknown", "alpha"]);

    expect(gatherCodeEvidence(segments, transcripts, codebook, 8, scope, true)).toEqual([
      { name: "empty", def: "E", excerpts: [] },
      { name: "alpha", def: "A", excerpts: ["alpha evidence"] },
    ]);
  });
});
