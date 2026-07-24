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

test("valid quotes pass; hallucinated and empty ones drop; every item gets a record", () => {
  const recs = sanitizeGroundReply(items, [
    { sid: 1, quotes: ["zoomed in", "not in the excerpt at all", "  "] },
    { sid: 99, quotes: ["zoomed in"] }, // invented id
  ], red);
  expect(recs[1].quotes).toEqual(["zoomed in"]);
  expect(recs[2]).toBeDefined();          // sent but unanswered -> empty record
  expect(recs[2].quotes).toEqual([]);     // so it won't be re-sent next run
  expect(recs[99]).toBeUndefined();
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
