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
const hit = (a: number, b: number, why = "gives up") => ({ line_start: a, line_end: b, why });

describe("what a question search will accept back", () => {
  it("keeps a hit inside the window and normalises its direction", () => {
    expect(sanitizeFindReply(lines, [hit(2, 1)])).toEqual([{ startLine: 1, endLine: 2, why: "gives up" }]);
  });

  // The model cannot point at lines it was never shown: a corpus-wide run sends
  // many windows, and an id from a different one would silently mark the wrong
  // passage of the wrong transcript.
  it("drops a range naming a line that was not in this window", () => {
    expect(sanitizeFindReply(lines, [hit(1, 99), hit(0, 2)])).toEqual([]);
  });

  it("drops a non-integer range rather than coercing it", () => {
    expect(sanitizeFindReply(lines, [{ line_start: 1.5, line_end: 2, why: "x" }])).toEqual([]);
  });

  it("dedupes identical ranges", () => {
    expect(sanitizeFindReply(lines, [hit(1, 2), hit(1, 2)])).toHaveLength(1);
  });

  // Background speech is sent so the model can follow the exchange, never so it
  // can be the substance of an answer.
  it("drops a hit made only of background speech, and keeps one that merely crosses it", () => {
    expect(sanitizeFindReply(lines, [hit(3, 3)], red, new Set(["R"]))).toEqual([]);
    expect(sanitizeFindReply(lines, [hit(1, 3)], red, new Set(["R"]))).toHaveLength(1);
  });

  // A `why` still carrying a placeholder would show the researcher
  // [REDACTED_1] where their own participant's name belongs.
  it("restores the redaction in the reason it hands back", () => {
    const r = redactor(["Dana"]);
    const sent = r.redact("Dana gave up");           // populates the map
    expect(sent).not.toContain("Dana");
    expect(sanitizeFindReply(lines, [hit(1, 2, sent)], r)[0].why).toBe("Dana gave up");
  });

  it("survives a reply with no reason at all", () => {
    expect(sanitizeFindReply(lines, [{ line_start: 1, line_end: 2 } as never])[0].why).toBe("");
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
