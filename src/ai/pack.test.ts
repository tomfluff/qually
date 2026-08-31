// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// How a run is split into requests. The old rule counted items, which is a
// proxy for size that a real transcript breaks in both directions; these pin
// the three rules that replaced it, and the coverage property underneath them.
import { describe, expect, it } from "vitest";
import { packChunks, lineSize, WINDOW_PACK, ITEM_PACK } from "./pack";

const one = () => 1;
const nums = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("packing a run into requests", () => {
  // The property everything else rests on: splitting is not allowed to lose or
  // reorder work. A dropped item would be uncoded text that the run reports as
  // read — coverage the consent gate cannot describe.
  it("keeps every item, exactly once, in order", () => {
    const items = nums(500);
    const out = packChunks(items, (n) => (n % 7) + 1, { budget: 20, minItems: 3, maxItems: 9 });
    expect(out.flat()).toEqual(items);
  });

  it("closes a chunk once the token budget is spent", () => {
    const out = packChunks(nums(30), () => 100, { budget: 250, minItems: 1, maxItems: 99 });
    expect(out[0]).toHaveLength(2);           // 2 x 100 fits under 250; a third would not
  });

  it("never lets a chunk grow past the ceiling, however small the items", () => {
    const out = packChunks(nums(50), one, { budget: 1e6, minItems: 1, maxItems: 8 });
    expect(out).toHaveLength(7);
    expect(out[0]).toHaveLength(8);
  });

  // The floor beats the budget on purpose: for a windowed read the chunk is the
  // context the model judges from, and pure size-packing would hand a dense
  // transcript three-line windows — cheaper requests, worse answers.
  it("holds the floor even when that overshoots the budget", () => {
    const out = packChunks(nums(20), () => 1000, { budget: 100, minItems: 5, maxItems: 99 });
    expect(out[0]).toHaveLength(5);
  });

  // Silently discarding it would lose coverage while still rendering as coverage.
  it("sends an item bigger than the whole budget rather than dropping it", () => {
    const out = packChunks([1, 999, 1], (n) => n, { budget: 10, minItems: 1, maxItems: 99 });
    expect(out.flat()).toEqual([1, 999, 1]);
    expect(out.some((c) => c.length === 1 && c[0] === 999)).toBe(true);
  });

  it("returns nothing for nothing, rather than one empty request", () => {
    expect(packChunks([], one, WINDOW_PACK)).toEqual([]);
  });
});

// The measured case: 2400 short utterances used to be 60 requests of which 97%
// was codebook and system prompt. What fixes that is sending fewer, fuller ones.
describe("the transcript shapes that motivated this", () => {
  const line = (id: number, text: string) => ({ id, speaker: "P", text });

  it("packs a transcript of short utterances into far fewer requests", () => {
    const short = Array.from({ length: 2400 }, (_, i) => line(i + 1, "Mm."));
    const out = packChunks(short, lineSize, WINDOW_PACK);
    expect(out.length).toBeLessThan(2400 / 40);        // fewer than the old fixed rule
    expect(out.every((c) => c.length <= WINDOW_PACK.maxItems)).toBe(true);
  });

  it("keeps a window of long lines within budget instead of counting to forty", () => {
    const long = Array.from({ length: 200 }, (_, i) =>
      line(i + 1, "I zoom right in on the chart and trace along each bar. ".repeat(40)));
    const out = packChunks(long, lineSize, WINDOW_PACK);
    for (const c of out) {
      const tok = c.reduce((n, l) => n + lineSize(l), 0);
      // the floor is what may exceed the budget; nothing else may
      expect(tok <= WINDOW_PACK.budget || c.length <= WINDOW_PACK.minItems).toBe(true);
    }
  });

  // Excerpts are judged on their own, so they take no floor — which is what
  // stops twelve long ones becoming a request five times the size of twelve
  // short ones (measured 759 against 4218 tokens under the old rule).
  it("evens out requests when item sizes vary wildly", () => {
    const items = Array.from({ length: 120 }, (_, i) => (i % 2 ? 40 : 900));
    const out = packChunks(items, (n) => n, ITEM_PACK);
    const sizes = out.map((c) => c.reduce((a, b) => a + b, 0));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(3);
  });
});
