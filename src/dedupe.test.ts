// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F2 merge: the trust boundary (sanitizeMergeReply).
import { test, expect } from "vitest";
import { sanitizeMergeReply, type MergeCodeInput } from "./ai/dedupe";

const codes: MergeCodeInput[] = [
  { name: "frustration", def: "", excerpts: [] },
  { name: "annoyance", def: "", excerpts: [] },
  { name: "magnification", def: "", excerpts: [] },
];

type Raw = { from: string; into: string; rationale: string; tier: "duplicate" | "overlap" };

test("keeps proposals between known codes, drops invented names and self-merges", () => {
  const out = sanitizeMergeReply(codes, [
    { from: "annoyance", into: "frustration", rationale: "same feeling", tier: "duplicate" },
    { from: "annoyance", into: "nope", rationale: "unknown target", tier: "duplicate" },
    { from: "magnification", into: "magnification", rationale: "self", tier: "duplicate" },
  ]);
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "same feeling", tier: "duplicate" }]);
});

test("dedupes unordered pairs — a→b and b→a queue once, first wins", () => {
  const out = sanitizeMergeReply(codes, [
    { from: "annoyance", into: "frustration", rationale: "first", tier: "duplicate" },
    { from: "frustration", into: "annoyance", rationale: "reverse", tier: "duplicate" },
  ]);
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "first", tier: "duplicate" }]);
});

test("malformed proposals: missing name, blank name, and undefined rationale", () => {
  const out = sanitizeMergeReply(codes, [
    { into: "frustration" } as unknown as Raw, // no from -> drop
    { from: " ", into: "frustration" } as unknown as Raw, // blank -> drop
    { from: "annoyance", into: "frustration" } as unknown as Raw, // no rationale -> ""
  ]);
  // a missing/invented tier lands in the SOFT tier — never upgraded to confident
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "", tier: "overlap" }]);
});

test("duplicates sort ahead of overlaps", () => {
  const out = sanitizeMergeReply(codes, [
    { from: "annoyance", into: "frustration", rationale: "soft", tier: "overlap" },
    { from: "magnification", into: "frustration", rationale: "hard", tier: "duplicate" },
  ]);
  expect(out.map((p) => p.tier)).toEqual(["duplicate", "overlap"]);
});
