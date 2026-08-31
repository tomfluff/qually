// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// How a run is split into requests. The old rule counted items, which is a
// proxy for size that a real transcript breaks in both directions; these pin
// the four rules that replaced it, and the coverage property underneath them.
import { describe, expect, it } from "vitest";
import { packChunks, packRun, lineSize, WINDOW_PACK, ITEM_PACK } from "./pack";
import { redactor } from "./redact";

const one = () => 1;
const nums = (n: number) => Array.from({ length: n }, (_, i) => i);
const OPTS = (o: Partial<typeof WINDOW_PACK>) => ({ ...WINDOW_PACK, ...o });

describe("packing a run into requests", () => {
  // The property everything else rests on: splitting is not allowed to lose or
  // reorder work. A dropped item would be uncoded text that the run reports as
  // read — coverage the consent gate cannot describe.
  it("keeps every item, exactly once, in order", () => {
    const items = nums(500);
    const out = packChunks(items, (n) => (n % 7) + 1, OPTS({ budget: 20, minItems: 3, maxItems: 9 }));
    expect(out.flat()).toEqual(items);
  });

  it("closes a chunk once the token budget is spent", () => {
    const out = packChunks(nums(30), () => 100, OPTS({ budget: 250, minItems: 1, maxItems: 99 }));
    expect(out[0]).toHaveLength(2);           // 2 x 100 fits under 250; a third would not
  });

  it("never lets a chunk grow past the ceiling, however small the items", () => {
    const out = packChunks(nums(50), one, OPTS({ budget: 1e6, minItems: 1, maxItems: 8, hardCap: 1e6 }));
    expect(out).toHaveLength(7);
    expect(out[0]).toHaveLength(8);
  });

  // The floor beats the budget on purpose: for a windowed read the chunk is the
  // context the model judges from, and pure size-packing would hand a dense
  // transcript three-line windows — cheaper requests, worse answers.
  it("holds the floor even when that overshoots the budget", () => {
    const out = packChunks(nums(20), () => 1000, OPTS({ budget: 100, minItems: 5, hardCap: 1e6 }));
    expect(out[0]).toHaveLength(5);
  });

  // ...but the floor is not worth a request the model cannot read. Codex found
  // the first version of this packer would grow a chunk to minItems whatever
  // the size, so fifteen huge items became one impossible request.
  it("breaks the floor rather than exceed the hard cap", () => {
    const out = packChunks(nums(20), () => 10_000, OPTS({ budget: 2500, minItems: 15, hardCap: 24_000 }));
    expect(out.every((c) => c.length <= 2)).toBe(true);   // 3 x 10k would pass the cap
    expect(out.flat()).toHaveLength(20);
  });

  // The claim the first version made and did not keep: it only held when
  // minItems was 1, which is exactly what the old test used.
  it("isolates an item bigger than the cap, under a real floor, and names it", () => {
    const { chunks, oversize } = packRun([1, 99_999, 1, 1], (n) => n,
      OPTS({ budget: 2500, minItems: 15, hardCap: 24_000 }));
    expect(chunks.flat()).toEqual([1, 99_999, 1, 1]);      // never dropped
    expect(chunks).toContainEqual([99_999]);               // and it went alone
    expect(oversize).toEqual([99_999]);                    // and the caller can say so
  });

  it("returns nothing for nothing, rather than one empty request", () => {
    expect(packChunks([], one, WINDOW_PACK)).toEqual([]);
  });

  // A size function that cannot answer must not silently disable the budget:
  // NaN poisons every comparison, so every chunk would grow to maxItems.
  it("treats an unmeasurable item as weightless rather than trusting NaN", () => {
    const out = packChunks(nums(40), () => NaN, OPTS({ budget: 100, minItems: 1, maxItems: 10 }));
    expect(out.flat()).toHaveLength(40);
    expect(out.every((c) => c.length <= 10)).toBe(true);
  });

  it("refuses options that cannot mean anything", () => {
    expect(() => packChunks(nums(3), one, OPTS({ budget: 0 }))).toThrow();
    expect(() => packChunks(nums(3), one, OPTS({ minItems: 9, maxItems: 4 }))).toThrow();
    expect(() => packChunks(nums(3), one, OPTS({ minItems: 0 }))).toThrow();
  });
});

// The measured case: 2400 short utterances used to be 60 requests of which 97%
// was codebook and system prompt. What fixes that is sending fewer, fuller ones.
describe("the transcript shapes that motivated this", () => {
  const line = (id: number, text: string, speaker = "P") => ({ id, speaker, text });

  it("packs a transcript of short utterances into far fewer requests", () => {
    const short = Array.from({ length: 2400 }, (_, i) => line(i + 1, "Mm."));
    const out = packChunks(short, (l) => lineSize(l), WINDOW_PACK);
    expect(out.length).toBeLessThan(2400 / 40);        // fewer than the old fixed rule
    expect(out.every((c) => c.length <= WINDOW_PACK.maxItems)).toBe(true);
  });

  // With lines this long the floor, not the budget, decides the window: fifteen
  // of them is already several times the soft target. That is the trade minItems
  // exists to make, and hardCap is the bound that actually protects the request.
  it("keeps a window of long lines under the hard cap, floor or no floor", () => {
    const long = Array.from({ length: 200 }, (_, i) =>
      line(i + 1, "I zoom right in on the chart and trace along each bar. ".repeat(40)));
    const out = packChunks(long, (l) => lineSize(l), WINDOW_PACK);
    expect(out.flat()).toHaveLength(200);
    for (const c of out) {
      const tok = c.reduce((n, l) => n + lineSize(l), 0);
      expect(tok).toBeLessThanOrEqual(WINDOW_PACK.hardCap);
      // over the soft budget only where the floor (or a folded tail) forced it
      if (tok > WINDOW_PACK.budget) expect(c.length).toBeGreaterThanOrEqual(WINDOW_PACK.minItems);
    }
  });

  it("evens out requests when item sizes vary wildly", () => {
    const items = Array.from({ length: 120 }, (_, i) => (i % 2 ? 40 : 900));
    const out = packChunks(items, (n) => n, ITEM_PACK);
    const sizes = out.map((c) => c.reduce((a, b) => a + b, 0));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(3);
  });
});

// Packing what is not sent is how a chunk lands at several times its measured
// size: a one-character term becomes a twelve-character placeholder.
describe("sizing what will actually be sent", () => {
  it("counts the redaction, not the text it replaces", () => {
    const l = { id: 1, speaker: "P", text: "田田田田田田田田" };
    const red = redactor(["田"]);
    expect(lineSize(l, red)).toBeGreaterThan(lineSize(l));
  });

  it("counts the [context] prefix that the window will carry", () => {
    const l = { id: 1, speaker: "R", text: "so you prefer magnification" };
    expect(lineSize(l, undefined, new Set(["R"]))).toBeGreaterThan(lineSize(l));
  });
});

// The leftover at the end is the one chunk nothing else bounds, and no test
// used to look at it: every assertion above reads out[0].
describe("the last chunk", () => {
  it("does not leave a context-free tail carrying a whole codebook", () => {
    const out = packChunks(nums(2401), () => 3, WINDOW_PACK);   // 200/window by count
    expect(out[out.length - 1].length).toBeGreaterThanOrEqual(WINDOW_PACK.minItems);
    expect(out.flat()).toHaveLength(2401);
  });

  it("still ships a short run that never had a full chunk to fold into", () => {
    const out = packChunks(nums(3), () => 3, WINDOW_PACK);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(3);
  });

  // folding must not push the previous chunk past its own ceiling
  it("keeps the fold inside maxItems", () => {
    const out = packChunks(nums(205), () => 3, WINDOW_PACK);
    expect(out.every((c) => c.length <= WINDOW_PACK.maxItems)).toBe(true);
    expect(out.flat()).toHaveLength(205);
  });
});
