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

test("keeps proposals between known codes, drops invented names and self-merges", () => {
  const out = sanitizeMergeReply(codes, [
    { from: "annoyance", into: "frustration", rationale: "same feeling" },
    { from: "annoyance", into: "nope", rationale: "unknown target" },
    { from: "magnification", into: "magnification", rationale: "self" },
  ]);
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "same feeling" }]);
});

test("dedupes unordered pairs — a→b and b→a queue once, first wins", () => {
  const out = sanitizeMergeReply(codes, [
    { from: "annoyance", into: "frustration", rationale: "first" },
    { from: "frustration", into: "annoyance", rationale: "reverse" },
  ]);
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "first" }]);
});

test("malformed proposals: missing name, blank name, and undefined rationale", () => {
  const out = sanitizeMergeReply(codes, [
    { into: "frustration" } as unknown as { from: string; into: string; rationale: string }, // no from -> drop
    { from: " ", into: "frustration" } as unknown as { from: string; into: string; rationale: string }, // blank -> drop
    { from: "annoyance", into: "frustration" } as unknown as { from: string; into: string; rationale: string }, // no rationale -> ""
  ]);
  expect(out).toEqual([{ from: "annoyance", into: "frustration", rationale: "" }]);
});
