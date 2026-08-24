// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { stretchColor, stretchColorOf, stretchesAt, stretchDims, coverageOf, type Stretch } from "./stretches";

const st = (pid: string, start: number, end: number, value: string, dim = "condition"): Stretch =>
  ({ pid, start, end, dim, value });

describe("stretches", () => {
  const list = [st("P01", 1, 40, "baseline"), st("P01", 41, 90, "proposal"), st("P02", 1, 50, "baseline")];

  it("finds the stretch covering a line", () => {
    expect(stretchesAt(list, "P01", 10).map((s) => s.value)).toEqual(["baseline"]);
    expect(stretchesAt(list, "P01", 41).map((s) => s.value)).toEqual(["proposal"]);
  });

  it("a range straddling a boundary hits both", () => {
    expect(stretchesAt(list, "P01", 38, 45).map((s) => s.value)).toEqual(["baseline", "proposal"]);
  });

  it("never crosses transcripts", () => {
    expect(stretchesAt(list, "P03", 10)).toEqual([]);
  });

  it("overlapping dims coexist", () => {
    const two = [...list, st("P01", 1, 90, "bar chart", "chart")];
    expect(stretchesAt(two, "P01", 10).map((s) => s.dim).sort()).toEqual(["chart", "condition"]);
    expect(stretchDims(two)).toEqual(["chart", "condition"]);
  });

  it("colour is stable and value-determined", () => {
    expect(stretchColor("baseline")).toBe(stretchColor("Baseline "));
    expect(stretchColor("baseline")).not.toBe(stretchColor("proposal"));
  });
});

describe("coverageOf", () => {
  const stretches = [st("P01", 1, 40, "baseline"), st("P01", 41, 90, "proposal")];
  const seg = (pid: string, code: string, start: number, end: number, status = "accepted") =>
    ({ pid, code, start, end, status });

  it("splits a code's evidence by value", () => {
    const cov = coverageOf([
      seg("P01", "frustration", 5, 8),
      seg("P01", "frustration", 12, 14),
      seg("P01", "frustration", 60, 62),
    ], stretches, "condition");
    expect(cov.get("frustration")?.get("baseline")).toBe(2);
    expect(cov.get("frustration")?.get("proposal")).toBe(1);
  });

  it("evidence outside every stretch counts as unmarked", () => {
    const cov = coverageOf([seg("P02", "trust", 5, 8)], stretches, "condition");
    expect(cov.get("trust")?.get("")).toBe(1);
  });

  it("a boundary-straddling segment counts once per value", () => {
    const cov = coverageOf([seg("P01", "trust", 38, 44)], stretches, "condition");
    expect(cov.get("trust")?.get("baseline")).toBe(1);
    expect(cov.get("trust")?.get("proposal")).toBe(1);
  });

  it("candidates and rejected are not evidence", () => {
    const cov = coverageOf([seg("P01", "trust", 5, 8, "candidate")], stretches, "condition");
    expect(cov.size).toBe(0);
  });

  it("other dims' stretches are invisible", () => {
    const cov = coverageOf([seg("P01", "trust", 5, 8)], stretches, "chart");
    expect(cov.get("trust")?.get("")).toBe(1);
  });
});

// The band is the only visual signal that a line belongs to a section, so it
// owes 3:1 (WCAG 1.4.11, non-text contrast) on the ground it is painted on.
// The hue comes from a hash of the label, so this has to hold for EVERY hue —
// otherwise the contrast is a lottery decided by how a condition was spelled,
// which is exactly the bug this locks shut.
describe("band contrast", () => {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // the app's two grounds (styles/base.css --bg)
  const LIGHT = lum("#ffffff"), DARK = lum("#161a1e");
  // labels chosen to sweep the hue circle: the hash makes hue unpredictable, so
  // spread the net rather than trusting any one word
  const labels = Array.from({ length: 200 }, (_, i) => `condition ${i}`)
    .concat(["baseline", "treatment", "task a", "task b", "control", "proposal"]);

  it("clears 3:1 on the light ground, whatever the label", () => {
    for (const l of labels)
      expect(ratio(lum(stretchColor(l, false)), LIGHT)).toBeGreaterThanOrEqual(3);
  });

  it("clears 3:1 on the dark ground, whatever the label", () => {
    for (const l of labels)
      expect(ratio(lum(stretchColor(l, true)), DARK)).toBeGreaterThanOrEqual(3);
  });

  // The same fill is the LABEL PILL's background, and the pill carries small
  // uppercase text. A colour can clear the band's 3:1 and still be a fill that
  // no ink reads well on — that dead zone (worst case 4.6:1 with either ink) is
  // what "BASELINE" looked unreadable in, so it is pinned here too.
  const bestInk = (fill: string) => {
    const L = lum(fill);
    return Math.max(ratio(L, lum("#ffffff")), ratio(L, lum("#000000")));
  };

  it("the pill's text clears 4.5:1 on every fill, both themes", () => {
    for (const l of labels) {
      expect(bestInk(stretchColor(l, false))).toBeGreaterThanOrEqual(4.5);
      expect(bestInk(stretchColor(l, true))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no label lands in the dead zone where both inks are mediocre", () => {
    // 5.5:1 is the line between "technically passes" and "reads at a glance"
    for (const l of labels) {
      expect(bestInk(stretchColor(l, false))).toBeGreaterThanOrEqual(5.5);
      expect(bestInk(stretchColor(l, true))).toBeGreaterThanOrEqual(5.5);
    }
  });

  it("one ink wins decisively per theme — white on light, black on dark", () => {
    // consistency is the point: every tab in a project looks like the same
    // object, instead of some being white-on-deep and others black-on-pale
    const inkIsWhite = (fill: string) =>
      ratio(lum(fill), lum("#ffffff")) > ratio(lum(fill), lum("#000000"));
    for (const l of labels) {
      expect(inkIsWhite(stretchColor(l, false))).toBe(true);
      expect(inkIsWhite(stretchColor(l, true))).toBe(false);
    }
  });

  it("keeps the value's identity across themes — same hue, different tone", () => {
    const light = stretchColor("baseline", false), dark = stretchColor("baseline", true);
    expect(light).not.toBe(dark);
    // hue is preserved: the channels keep their ORDER (which is what hue is)
    const rank = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      .map((v, _, all) => all.filter((o) => o > v).length);
    expect(rank(light)).toEqual(rank(dark));
  });

  it("a hand-picked override still wins", () => {
    expect(stretchColorOf("baseline", { baseline: "#ff0000" }, true)).toBe("#ff0000");
    expect(stretchColorOf("baseline", {}, true)).toBe(stretchColor("baseline", true));
  });
});
