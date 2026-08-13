// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Describe codes: the trust boundary (sanitizeDescribeReply).
import { test, expect } from "vitest";
import { sanitizeDescribeReply, type DescCodeInput, type DescDraft } from "./ai/describe";

const codes: DescCodeInput[] = [
  { name: "frustration", def: "", excerpts: [] },
  { name: "magnification", def: "old def", excerpts: [] },
];

test("keeps drafts for known codes, drops invented names and empty definitions", () => {
  const out = sanitizeDescribeReply(codes, [
    { code: "frustration", definition: "Marks moments of visible irritation." },
    { code: "nope", definition: "invented code" },
    { code: "magnification", definition: "   " },
  ]);
  expect(out).toEqual([{ code: "frustration", definition: "Marks moments of visible irritation." }]);
});

test("one draft per code — first wins", () => {
  const out = sanitizeDescribeReply(codes, [
    { code: "frustration", definition: "first" },
    { code: "frustration", definition: "second" },
  ]);
  expect(out).toEqual([{ code: "frustration", definition: "first" }]);
});

test("malformed drafts: missing fields drop instead of throwing", () => {
  const out = sanitizeDescribeReply(codes, [
    { definition: "no code" } as unknown as DescDraft,
    { code: "magnification" } as unknown as DescDraft,
    { code: "magnification", definition: " trimmed " },
  ]);
  expect(out).toEqual([{ code: "magnification", definition: "trimmed" }]);
});
