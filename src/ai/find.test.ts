// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The trust boundary for a corpus-wide question search. It never becomes a
// coding, and it can never point at a line it was not shown.
import { describe, expect, it } from "vitest";
import { sanitizeFindReply, renderQuestion, renderFindWindow, renderFindChunk } from "./find";
import { redactor } from "./redact";
import type { Line } from "../state/store";

const L = (id: number, text: string, speaker = "P"): Line => ({ id, ts: "", speaker, text });
const lines = [L(1, "I zoom right in"), L(2, "then I give up", "P"), L(3, "mm", "R")];
const red = redactor([]);
const hit = (a: number, b: number) => ({ line_start: a, line_end: b });

describe("what a question search will accept back", () => {
  it("keeps a hit inside the window and normalises its direction", () => {
    expect(sanitizeFindReply(lines, [hit(2, 1)])).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  // The model cannot point at lines it was never shown: a corpus-wide run sends
  // many windows, and an id from a different one would silently mark the wrong
  // passage of the wrong transcript.
  it("drops a range naming a line that was not in this window", () => {
    expect(sanitizeFindReply(lines, [hit(1, 99), hit(0, 2)])).toEqual([]);
  });

  it("drops a non-integer range rather than coercing it", () => {
    expect(sanitizeFindReply(lines, [{ line_start: 1.5, line_end: 2 }])).toEqual([]);
  });

  it("dedupes identical ranges", () => {
    expect(sanitizeFindReply(lines, [hit(1, 2), hit(1, 2)])).toHaveLength(1);
  });

  // Background speech is sent so the model can follow the exchange, never so it
  // can be the substance of an answer.
  it("drops a hit made only of background speech, and keeps one that merely crosses it", () => {
    expect(sanitizeFindReply(lines, [hit(3, 3)], new Set(["R"]))).toEqual([]);
    expect(sanitizeFindReply(lines, [hit(1, 3)], new Set(["R"]))).toHaveLength(1);
  });

  // The model is asked for ranges and nothing else — no reason, no label, no
  // name. There is no field in the schema for an interpretation, so it cannot
  // offer one before the researcher has read the passage.
  it("hands back a range and nothing else", () => {
    expect(Object.keys(sanitizeFindReply(lines, [hit(1, 2)])[0]).sort())
      .toEqual(["endLine", "startLine"]);
  });
});

describe("what a question search sends", () => {
  it("splits into a stable half and a changing half that rejoin exactly", () => {
    expect(`${renderQuestion("where do they give up?", red)}\n\n${renderFindWindow(lines, red)}`)
      .toBe(renderFindChunk(lines, "where do they give up?", red));
  });

  it("redacts the question itself, which is the researcher's own prose", () => {
    const r = redactor(["Dana"]);
    expect(renderQuestion("where does Dana give up?", r)).not.toContain("Dana");
  });
});

// Withholding a speaker leaves gaps in what is sent. A range spanning a gap
// would code speech the researcher deliberately kept off the wire. Enforcing
// that by breaking the window at every gap was correct and ruinous — an
// interleaved speaker turned 150 lines into 150 one-line requests — so the rule
// lives here, where it costs nothing.
describe("a range must not span speech that was withheld", () => {
  const sent = [L(10, "I zoom in"), L(12, "then I give up")];   // 11 withheld
  const omitted = new Set([11]);

  it("drops a hit that bridges a withheld line", () => {
    expect(sanitizeFindReply(sent, [hit(10, 12)], undefined, omitted)).toEqual([]);
  });

  it("keeps the same hit when nothing was withheld", () => {
    expect(sanitizeFindReply(sent, [hit(10, 12)])).toHaveLength(1);
  });

  it("keeps single-line hits either side of the gap", () => {
    expect(sanitizeFindReply(sent, [hit(10, 10), hit(12, 12)], undefined, omitted)).toHaveLength(2);
  });

  // the withheld id at an ENDPOINT cannot arrive — it was never in the window —
  // but the endpoint check must still be what rejects it
  it("drops a hit that starts on a withheld line", () => {
    expect(sanitizeFindReply(sent, [hit(11, 12)], undefined, omitted)).toEqual([]);
  });
});
