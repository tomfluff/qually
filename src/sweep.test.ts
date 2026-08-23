// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { sweepWording, refusedPairs, familyReason, pairKey } from "./sweep";
import type { Decision } from "./state/store";

const book = (...names: string[]) => names.map((name) => ({ name, def: "" }));
const of = (fams: ReturnType<typeof sweepWording>, code: string) =>
  fams.find((f) => f.codes.includes(code));

describe("the whole-book wording sweep", () => {
  it("calls a contained pair typed twice", () => {
    const f = of(sweepWording(book("trust in AI", "can trust AI", "workaround")), "trust in AI")!;
    expect(f.tier).toBe("typed-twice");
    expect(f.codes.sort()).toEqual(["can trust AI", "trust in AI"]);
    expect(f.words).toContain("trust");
  });

  it("pushes a valence flip down a tier, however contained it looks", () => {
    const f = of(sweepWording(book("prior AI experience", "no prior AI experience")), "prior AI experience")!;
    expect(f.tier).toBe("shares-wording");
  });

  it("sees a 'not' the stopword list would hide", () => {
    // tokens() drops "not" as a stopword, so this flip is invisible to a
    // token-side negation check — it has to be read off the raw name
    const f = of(sweepWording(book("does not trust AI", "trust AI")), "trust AI")!;
    expect(f.tier).toBe("shares-wording");
  });

  it("groups a splintered concept into one family, not three pairs", () => {
    const fams = sweepWording(book("reading fatigue", "fatigue while reading", "strategies for reading"));
    const f = of(fams, "reading fatigue")!;
    expect(f.codes.length).toBeGreaterThanOrEqual(2);
    expect(fams.filter((x) => x.codes.includes("reading fatigue"))).toHaveLength(1);
  });

  it("never puts one code in two families", () => {
    const fams = sweepWording(book(
      "small text", "text", "text size", "tiny text", "trust in AI", "can trust AI", "trusting the system"));
    const seen = new Set<string>();
    for (const f of fams) for (const c of f.codes) {
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
  });

  it("leaves codes already inside a pending proposal alone", () => {
    const fams = sweepWording(book("trust in AI", "can trust AI"), { skip: new Set(["can trust AI"]) });
    expect(fams).toHaveLength(0);
  });

  it("does not re-propose a pair you turned down", () => {
    const refused = new Set([pairKey("trust in AI", "can trust AI")]);
    expect(sweepWording(book("trust in AI", "can trust AI"), { refused })).toHaveLength(0);
  });

  it("finds nothing in a book of unrelated names", () => {
    expect(sweepWording(book("frustration", "workaround", "time pressure"))).toHaveLength(0);
  });

  it("puts the low-judgement tier first", () => {
    const fams = sweepWording(book(
      "difficult to see", "hard to see", "trust in AI", "can trust AI"));
    expect(fams[0].tier).toBe("typed-twice");
  });

  it("says what it matched on, never what it thinks", () => {
    const f = of(sweepWording(book("trust in AI", "can trust AI")), "trust in AI")!;
    expect(familyReason(f)).toContain("trust");
    expect(familyReason(f)).not.toMatch(/should|probably|duplicate/i);
  });
});

describe("refusals read back out of the ledger", () => {
  const d = (kind: Decision["kind"], codes: string[], undone?: boolean): Decision =>
    ({ at: "", kind, codes, why: "", source: "wording", ...(undone ? { undone } : {}) });

  it("collects every pair inside a turned-down proposal", () => {
    const r = refusedPairs([d("dismiss", ["a", "b", "c"])]);
    expect(r.has(pairKey("a", "b"))).toBe(true);
    expect(r.has(pairKey("b", "c"))).toBe(true);
  });

  it("ignores accepted decisions and reversed refusals", () => {
    expect(refusedPairs([d("merge", ["a", "b"])]).size).toBe(0);
    expect(refusedPairs([d("dismiss", ["a", "b"], true)]).size).toBe(0);
  });
});

describe("the sweep's edges", () => {
  it("sees a contraction the word split would hand back as two words", () => {
    const f = sweepWording(book("can't trust AI", "trust AI"))
      .find((x) => x.codes.includes("trust AI"))!;
    expect(f.tier).toBe("shares-wording");
  });

  it("gives a code its strongest containment pair, not the first one found", () => {
    // "small text" and "small text size" share more than "small text" and "text"
    const fams = sweepWording(book("text", "small text", "small text size"));
    const one = fams.find((f) => f.tier === "typed-twice")!;
    expect(one.codes.sort()).toEqual(["small text", "small text size"]);
  });

  it("honours a caller's floor", () => {
    const loose = sweepWording(book("wants export", "wants offline"), { floor: 0.2 });
    const strict = sweepWording(book("wants export", "wants offline"), { floor: 0.9 });
    expect(loose.length).toBe(1);
    expect(strict).toHaveLength(0);
  });
});
