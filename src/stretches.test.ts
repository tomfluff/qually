// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { stretchColor, stretchesAt, stretchDims, coverageOf, type Stretch } from "./stretches";

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
