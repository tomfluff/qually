// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// "By speaker" on the Code map: a code belongs to whoever owns two thirds of
// the lines it was coded on, and to the exchange when nobody does. The rule is
// a judgement about the data, so the boundary and the fallbacks are pinned.
import { test, expect } from "vitest";
import { speakerBuckets, MIXED, NONE } from "./speakerBuckets";
import type { Segment, Line } from "./state/store";

const seg = (sid: number, pid: string, code: string, start: number, end: number,
  status = "accepted"): Segment =>
  ({ sid, pid, start, end, code, status, notes: "", proposedBy: "(default)" });

const line = (id: number, speaker: string): Line =>
  ({ id, ts: "00:00:01", speaker, text: "…" });

// P01: two Ana lines, one Ben line, then one line nobody speaks for
const tr = { P01: { lines: [line(1, "Ana"), line(2, "Ana"), line(3, "Ben")] } };
const pileOf = (piles: ReturnType<typeof speakerBuckets>, key: string) =>
  piles.find((p) => p.key === key);

test("exactly two thirds owns the code; anything under it is the exchange", () => {
  // Ana holds 2 of 3 lines — exactly the boundary, and the boundary is inclusive
  const owned = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 3)], tr);
  expect(pileOf(owned, "spk:Ana")?.codes).toEqual(["c"]);

  // one line each: nobody owns it, so it belongs to the back-and-forth
  const split = speakerBuckets(["d"], [seg(2, "P01", "d", 2, 3)], tr);
  expect(pileOf(split, MIXED)?.codes).toEqual(["d"]);
  expect(pileOf(split, MIXED)?.label).toBe("Mixed");
});

test("only accepted codings count, and an unloaded transcript tallies nothing", () => {
  const piles = speakerBuckets(["c"],
    [seg(1, "P01", "c", 1, 2, "candidate"), seg(2, "GONE", "c", 1, 2)], tr);
  expect(pileOf(piles, NONE)?.codes).toEqual(["c"]);
  expect(pileOf(piles, NONE)?.label).toBe("No excerpts");
  expect(pileOf(piles, "spk:Ana")).toBeUndefined();
});

test("a line the segment spans but the transcript does not have is skipped", () => {
  // lines 1-2 are Ana's; 7-9 do not exist and must not become a phantom voice
  const piles = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 9)], tr);
  expect(pileOf(piles, "spk:Ana")?.codes).toEqual(["c"]);
});

// A PARTICIPANT MAY BE NAMED "Mixed". Keying piles by the drawn label merged
// that speaker's codes into the fallback pile — and the map stores hand
// positions against the same key, so the two would have shared a place too.
test("a speaker named Mixed keeps their own pile", () => {
  const odd = { P01: { lines: [line(1, "Mixed"), line(2, "Mixed"), line(3, "Ben")] } };
  const piles = speakerBuckets(["c", "d"],
    [seg(1, "P01", "c", 1, 2), seg(2, "P01", "d", 2, 3)], odd);
  expect(pileOf(piles, "spk:Mixed")?.codes).toEqual(["c"]); // the speaker
  expect(pileOf(piles, MIXED)?.codes).toEqual(["d"]);   // the exchange
  expect(pileOf(piles, "spk:Mixed")!.key).not.toBe(MIXED);
});

test("speakers sort by name; the derived piles close the row", () => {
  const piles = speakerBuckets(["a", "b", "c"], [
    seg(1, "P01", "a", 3, 3),        // Ben
    seg(2, "P01", "b", 1, 2),        // Ana
    seg(3, "P01", "c", 2, 3),        // one each — the exchange
  ], tr);
  expect(piles.map((p) => p.label)).toEqual(["Ana", "Ben", "Mixed"]);
});

test("a tie between two speakers is resolved the same way every time", () => {
  // 2 lines each: neither reaches two thirds, so the tiebreak must not decide
  // ownership — it only has to be stable
  const even = { P01: { lines: [line(1, "Zoe"), line(2, "Zoe"), line(3, "Ana"), line(4, "Ana")] } };
  const once = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 4)], even);
  const again = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 4)], even);
  expect(once[0].key).toBe(MIXED);
  expect(again[0].key).toBe(once[0].key);
});

// Line ids are checked only for being safe integers on import, and a
// hand-edited project file is not checked at all. Walking start..end would
// turn one sparse id into billions of misses and freeze the tab.
test("a sparse line id does not walk the gap", () => {
  const sparse = { P01: { lines: [line(1, "Ana"), line(2_000_000_000, "Ben")] } };
  const t0 = Date.now();
  const piles = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 2_000_000_000)], sparse);
  expect(Date.now() - t0).toBeLessThan(200);
  expect(piles[0].key).toBe(MIXED); // one line each, so nobody owns it
});

test("speaker names are trimmed, and a blank speaker is not a voice", () => {
  const messy = { P01: { lines: [line(1, "Ana"), line(2, "Ana "), line(3, "   ")] } };
  const piles = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 3)], messy);
  // "Ana " must not become a second person, and the blank line must not tally
  expect(piles).toHaveLength(1);
  expect(piles[0].key).toBe("spk:Ana");
  expect(piles[0].label).toBe("Ana");
});

test("lines out of id order in the file still tally by range", () => {
  const jumbled = { P01: { lines: [line(3, "Ben"), line(1, "Ana"), line(2, "Ana")] } };
  const piles = speakerBuckets(["c"], [seg(1, "P01", "c", 1, 2)], jumbled);
  expect(piles[0].key).toBe("spk:Ana");
});
