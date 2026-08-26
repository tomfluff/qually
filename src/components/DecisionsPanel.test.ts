// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, expect, it } from "vitest";
import type { Decision } from "../state/store";
import {
  decisionCodeCanLink, decisionCodesAreAFold, decisionKindLabel, decisionMovedLabel, decisionRowKey,
} from "./DecisionsPanel";

const row = (kind: Decision["kind"]): Decision => ({
  at: "2026-08-26T00:00:00.000Z", kind, codes: ["phase: intro"],
  why: "opening exchange", source: "ai", model: "Terra", moved: 1,
});

describe("Decisions panel code links", () => {
  it("never links a section label to a same-named code", () => {
    const codebook = { "phase: intro": {} };
    expect(decisionCodeCanLink(row("accept-section"), codebook, "phase: intro")).toBe(false);
    expect(decisionCodeCanLink(row("reject-section"), codebook, "phase: intro")).toBe(false);
    expect(decisionCodeCanLink(row("discard-section"), codebook, "phase: intro")).toBe(false);
    expect(decisionCodeCanLink(row("accept-coding"), codebook, "phase: intro")).toBe(true);
  });

  it("labels discards in text and derives stable keys from the row", () => {
    const coding = row("discard-coding");
    const section = { ...row("discard-section"), at: "2026-08-26T00:01:00.000Z" };
    expect(decisionKindLabel(coding)).toBe("discarded");
    expect(decisionKindLabel(section)).toBe("discarded");
    const keys = [coding, section].map(decisionRowKey);
    expect([section, coding].map(decisionRowKey)).toEqual([...keys].reverse());
    expect(keys.every((key) => key.includes("2026-08-26") && key.includes("discard-"))).toBe(true);
  });

  it("shows an unknown persisted kind verbatim instead of an empty chip", () => {
    const future = { ...row("merge"), kind: "reviewed-elsewhere" } as unknown as Decision;
    expect(decisionKindLabel(future)).toBe("reviewed-elsewhere");
  });

  it("describes discard counts as cleared without a verdict", () => {
    expect(decisionMovedLabel({ ...row("discard-coding"), moved: 1 }))
      .toBe("1 coding cleared without a verdict");
    expect(decisionMovedLabel({ ...row("discard-section"), moved: 2 }))
      .toBe("2 sections cleared without a verdict");
  });
});

// The arrow is a merge claim. A batch row lists what one gesture touched, in no
// particular relation, so it must not be drawn there.
describe("the survivor arrow", () => {
  it("is drawn only for a fold", () => {
    expect(decisionCodesAreAFold(row("merge"))).toBe(true);
    expect(decisionCodesAreAFold(row("rename"))).toBe(true);
    for (const k of ["accept-coding", "reject-coding", "discard-coding",
      "accept-section", "reject-section", "discard-section", "dismiss"] as Decision["kind"][]) {
      expect(decisionCodesAreAFold(row(k))).toBe(false);
    }
  });
});
