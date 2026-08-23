// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { houseStyle } from "./style";

describe("houseStyle", () => {
  it("says nothing about a book too small to have a style", () => {
    expect(houseStyle(["a", "b", "c", "d"])).toBeNull();
  });

  it("measures an all-lowercase, gerund-led book", () => {
    const s = houseStyle([
      "using click interaction", "asking AI", "using own vision",
      "verifying the answer", "reading the chart", "trusting AI",
    ])!;
    expect(s).toContain("all-lowercase");
    expect(s).toContain("gerund-led");
    expect(s).toContain("3 words");
  });

  it("lowercase names with embedded acronyms still count as lowercase", () => {
    const s = houseStyle(["trust in AI", "asking AI", "AI as a tool", "using vision", "reading charts"])!;
    expect(s).toContain("all-lowercase");
  });

  it("measures Title Case", () => {
    const s = houseStyle([
      "Visual Effort", "Chart Confusion", "Trust Building",
      "Independent Checking", "Tool Switching",
    ])!;
    expect(s).toContain("Title Case");
  });

  it("notices the colon convention", () => {
    const s = houseStyle([
      "proposal: positive", "proposal: negative", "baseline: negative",
      "using vision", "asking AI", "trust in AI",
    ])!;
    expect(s).toContain("colon");
  });

  it("asserts no case when the book is split", () => {
    const s = houseStyle(["Visual Effort", "using vision", "Chart Confusion", "asking AI", "Trust Building", "reading charts"])!;
    expect(s).not.toContain("Title Case");
    expect(s).not.toContain("all-lowercase (");
  });

  it("carries real examples from the book", () => {
    const s = houseStyle([
      "using click interaction", "asking AI questions", "using own vision",
      "verifying the answer", "reading the chart",
    ])!;
    expect(s).toMatch(/Examples from the codebook: “[^”]+”/);
  });
});
