// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The contextualize sanitizer is the trust boundary: what the model says
// becomes a mark only if the line was sent and may be rewritten, the quote is
// in it exactly once, and the replacement holds a bracketed term.
import { describe, expect, it } from "vitest";
import { redactor } from "./redact";
import { sanitizeSubs, renderContext, redactProse, proseRedactions } from "./contextualize";
import { SUBST_LENS } from "./flag";
import type { Line } from "../state/store";

const L = (id: number, text: string, speaker = "P"): Line => ({ id, ts: "", speaker, text });
const lines = [
  L(1, "And with the second system?", "R"),
  L(2, "it was fine but it was slow, and Ann said the first one was worse."),
  L(3, "the first one again"),
];
const context = new Set(["R"]);
const red = redactor(["Ann"]);
const terms = ["[Beacon]", "[Harbor]"];
const run = (reply: Parameters<typeof sanitizeSubs>[3]) => sanitizeSubs(lines, context, red, reply, terms);

describe("sanitizeSubs", () => {
  it("keeps a bracketed rewrite of words that occur once, under the substitution lens", () => {
    const { flags, dropped } = run([{ line_id: 2, quote: "the first one", replacement: "[Beacon]", why: "ordinal" }]);
    expect(flags[2]).toEqual([{ quote: "the first one", reason: "ordinal", lens: SUBST_LENS, fix: "[Beacon]" }]);
    expect(dropped).toBe(0);
  });

  it("drops a quote that occurs twice in the line — applyFix would rewrite the wrong one", () => {
    const { flags, dropped } = run([{ line_id: 2, quote: "it was", replacement: "[Harbor] was", why: "" }]);
    expect(flags[2]).toBeUndefined();
    expect(dropped).toBe(1);
  });

  it("keeps the same words once widened to a unique span", () => {
    const { flags } = run([{ line_id: 2, quote: "but it was slow", replacement: "but [Harbor] was slow", why: "" }]);
    expect(flags[2]?.[0].fix).toBe("but [Harbor] was slow");
  });

  it("drops a replacement with no bracketed term — that would be a silent edit, not a substitution", () => {
    const { flags } = run([{ line_id: 2, quote: "the first one", replacement: "Beacon", why: "" }]);
    expect(flags[2]).toBeUndefined();
  });

  it("drops a proposal on a context-only speaker's line", () => {
    const { flags } = run([{ line_id: 1, quote: "the second system", replacement: "[Harbor]", why: "" }]);
    expect(flags[1]).toBeUndefined();
  });

  it("drops a line that was not sent, a hallucinated quote, and a quote on a placeholder", () => {
    const { flags, dropped } = run([
      { line_id: 9, quote: "the first one", replacement: "[Beacon]", why: "" },
      { line_id: 2, quote: "purple monkey", replacement: "[Beacon]", why: "" },
      { line_id: 2, quote: "[REDACTED_1]", replacement: "[Beacon]", why: "" },
    ]);
    expect(Object.keys(flags)).toHaveLength(0);
    expect(dropped).toBe(3);
  });

  it("restores redaction in the reason, and refuses a placeholder in the quote or the fix", () => {
    const { flags } = run([
      { line_id: 2, quote: "the first one", replacement: "[Beacon]", why: "[REDACTED_1] is clear" },
      { line_id: 2, quote: "[REDACTED_1] said", replacement: "[REDACTED_1] said [Beacon]", why: "" },
      { line_id: 3, quote: "the first one", replacement: "[Beacon] ([REDACTED_1])", why: "" },
    ]);
    expect(flags[2]).toHaveLength(1);
    expect(flags[2][0]).toMatchObject({ quote: "the first one", fix: "[Beacon]", reason: "Ann is clear" });
    expect(flags[3]).toBeUndefined();
  });

  it("keeps the first of two proposals on the same words, and refuses a newline in a fix", () => {
    const { flags, dropped } = run([
      { line_id: 3, quote: "the first one", replacement: "[Beacon]", why: "" },
      { line_id: 3, quote: "the first one", replacement: "[Harbor]", why: "" },
      { line_id: 2, quote: "the first one", replacement: "[Beacon]\nnext", why: "" },
    ]);
    expect(flags[3]).toHaveLength(1);
    expect(flags[2]).toBeUndefined();
    expect(dropped).toBe(2);
  });
});

describe("sanitizeSubs holds the reply to the brief's vocabulary and the quote's words", () => {
  it("drops a bracketed term the brief did not name, or spelt differently", () => {
    const { flags, dropped } = run([
      { line_id: 3, quote: "the first one", replacement: "[Beakon]", why: "" },
      { line_id: 2, quote: "the first one", replacement: "[beacon]", why: "" },
    ]);
    expect(Object.keys(flags)).toHaveLength(0);
    expect(dropped).toBe(2);
  });

  it("drops a replacement that adds or tidies words the participant did not say", () => {
    const { flags, dropped } = run([
      { line_id: 3, quote: "the first one", replacement: "[Beacon] is great", why: "" },
      { line_id: 2, quote: "but it was slow", replacement: "but [Harbor] were slow", why: "" },
    ]);
    expect(Object.keys(flags)).toHaveLength(0);
    expect(dropped).toBe(2);
  });

  it("keeps a possessive and a two-term resolution whose other words are the quote's", () => {
    const own = [L(5, "the second system's menu and the first one's")];
    const { flags, dropped } = sanitizeSubs(own, context, red, [
      { line_id: 5, quote: "the second system's menu", replacement: "[Harbor]'s menu", why: "" },
      { line_id: 5, quote: "the first one's", replacement: "[Beacon]'s", why: "" },
    ], terms);
    expect(flags[5]?.map((f) => f.fix)).toEqual(["[Harbor]'s menu", "[Beacon]'s"]);
    expect(dropped).toBe(0);
  });

  it("refuses to rewrite inside words already in brackets, or words another proposal claimed", () => {
    const own = [L(6, "[Beacon] was fine but it was slow")];
    const { flags, dropped } = sanitizeSubs(own, context, red, [
      { line_id: 6, quote: "Beacon", replacement: "[Harbor]", why: "" },
      { line_id: 6, quote: "but it was slow", replacement: "but [Harbor] was slow", why: "" },
      { line_id: 6, quote: "it", replacement: "[Beacon]", why: "" },
    ], terms);
    expect(flags[6]?.map((f) => f.quote)).toEqual(["but it was slow"]);
    expect(dropped).toBe(2);
  });
});

describe("renderContext", () => {
  it("tags context speakers, redacts speech and the brief, and lists settled sections", () => {
    const out = renderContext(lines, "Ann's study: [Beacon] then [Harbor]", red, context,
      [{ pid: "P01", start: 1, end: 3, dim: "condition", value: "harbor" }]);
    expect(out).toContain("1\t[context] R\tAnd with the second system?");
    expect(out).toContain("[REDACTED_1]'s study: [Beacon] then [Harbor]");
    expect(out).toContain("- condition: harbor (lines 1-3)");
    expect(out).not.toContain("Ann");
  });
});

describe("onlyResolves, via sanitizeSubs — a fix is the quote with terms standing in, nothing else", () => {
  const T = ["[Beacon]", "[Harbor]"];
  const one = (text: string, quote: string, replacement: string) =>
    sanitizeSubs([L(1, text)], new Set(), red, [{ line_id: 1, quote, replacement, why: "" }], T).flags[1]?.[0]?.fix;
  it("keeps a term for the whole quote, a term inside the quote, and a possessive", () => {
    expect(one("the first one again", "the first one", "[Beacon]")).toBe("[Beacon]");
    expect(one("but it was slow", "but it was slow", "but [Harbor] was slow")).toBe("but [Harbor] was slow");
    expect(one("the second system's menu", "the second system's menu", "[Harbor]'s menu")).toBe("[Harbor]'s menu");
  });
  it("drops duplicated, reordered, tidied or added words, and a term not in the brief", () => {
    expect(one("it was fine", "it was fine", "[Beacon] fine fine")).toBeUndefined();
    expect(one("it was fine", "it was fine", "fine [Beacon]")).toBeUndefined();
    expect(one("they were fine", "they were", "[Beacon] was")).toBeUndefined();
    expect(one("it was fine", "it", "[Beacon] really")).toBeUndefined();
    expect(one("it was fine", "it", "[Beakon]")).toBeUndefined();
  });
});

describe("redactProse", () => {
  it("redacts the brief's prose and leaves its [terms] plain, even a term that is a redaction word", () => {
    const r = redactor(["Acme", "Ann"]);
    expect(redactProse("Ann's study: [Acme] first, then [Harbor].", r)).toBe("[REDACTED_2]'s study: [Acme] first, then [Harbor].");
    expect(proseRedactions("Ann's study: [Acme] first, then [Harbor].", r)).toBe(1);
  });
});
