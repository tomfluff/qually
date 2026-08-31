// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F1 grounding: the trust boundary (sanitizeGroundReply) and the hash contract.
import { test, expect } from "vitest";
import { sanitizeGroundReply, groundHash, type GroundItem } from "./ai/ground";
import { redactor } from "./ai/redact";

const items: GroundItem[] = [
  { sid: 1, code: "magnification", def: "", excerpt: "I zoomed in and counted the gridlines to cope" },
  { sid: 2, code: "frustration", def: "", excerpt: "honestly it made me want to give up" },
];
const red = redactor([]);

test("valid quotes pass; hallucinated and empty ones drop; an invented id grounds nothing", () => {
  const recs = sanitizeGroundReply(items, [
    { sid: 1, quotes: ["zoomed in", "not in the excerpt at all", "  "] },
    { sid: 99, quotes: ["zoomed in"] }, // invented id
  ], red);
  expect(recs[1].quotes).toEqual(["zoomed in"]);
  expect(recs[99]).toBeUndefined();
});

// An item the model did not mention is not an item with no evidence. Recording
// it as grounded-with-nothing retires the question permanently: it carries a
// current hash, so it never becomes eligible again, and the run reports it to
// the researcher as having no evidence for their own coding. Leaving it
// unrecorded costs a second look, which is the cheaper mistake by far.
test("an item the model never answered gets no record, so it stays eligible", () => {
  const recs = sanitizeGroundReply(items, [{ sid: 1, quotes: ["zoomed in"] }], red);
  expect(recs[1]).toBeDefined();
  expect(recs[2]).toBeUndefined();
});

// ...and an item the model DID answer with nothing is a real answer: it says
// no single span carries the code, and it should not be paid for twice.
test("an explicit empty answer is recorded, and is not the same as silence", () => {
  const recs = sanitizeGroundReply(items, [
    { sid: 1, quotes: ["zoomed in"] }, { sid: 2, quotes: [] },
  ], red);
  expect(recs[2]).toBeDefined();
  expect(recs[2].quotes).toEqual([]);
});

test("an item with no quotes field gets an empty record, not a crash", () => {
  const recs = sanitizeGroundReply([items[0]], [
    { sid: 1 } as unknown as { sid: number; quotes: string[] },
  ], red);
  expect(recs[1].quotes).toEqual([]);
});

test("quotes cap at 3 and dedupe", () => {
  const recs = sanitizeGroundReply([items[0]], [
    { sid: 1, quotes: ["zoomed", "zoomed", "counted", "gridlines", "cope"] },
  ], red);
  expect(recs[1].quotes).toEqual(["zoomed", "counted", "gridlines"]);
});

test("quotes carrying a redaction placeholder are dropped", () => {
  const r = redactor(["Ann Lee"]);
  const it: GroundItem = { sid: 3, code: "c", def: "", excerpt: "Ann Lee said the map was tiny" };
  const recs = sanitizeGroundReply([it], [
    { sid: 3, quotes: ["[REDACTED_1] said", "the map was tiny"] },
  ], r);
  expect(recs[3].quotes).toEqual(["the map was tiny"]);
});

test("the hash binds code AND excerpt — either change invalidates", () => {
  const h = groundHash("magnification", "some excerpt");
  expect(groundHash("magnification", "some excerpt")).toBe(h);
  expect(groundHash("zooming", "some excerpt")).not.toBe(h);
  expect(groundHash("magnification", "some excerpt edited")).not.toBe(h);
});
