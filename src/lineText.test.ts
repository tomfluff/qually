// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The rule that decides which text a code's excerpt, an export and an AI
// request all carry. It is pinned here rather than checked by reading the
// screen, because the three surfaces must agree and only this function makes
// them agree.
import { describe, expect, it } from "vitest";
import { hasTranslation, lineText, untranslated } from "./lineText";

const l = (text: string, en?: string) => ({ text, en });

describe("which text is the text", () => {
  it("reads the source unless English was asked for", () => {
    expect(lineText(l("チャート", "A chart"), "source")).toBe("チャート");
    expect(lineText(l("チャート", "A chart"), "en")).toBe("A chart");
  });

  // The whole reason the fallback is per line: a translator part-way through a
  // file, or a passage deliberately left in the original, must not make the
  // English reading unavailable for everything else.
  it("falls back to the source for a line with no translation", () => {
    expect(lineText(l("チャート"), "en")).toBe("チャート");
    expect(lineText(l("チャート", ""), "en")).toBe("チャート");
    expect(lineText(l("チャート", "   "), "en")).toBe("チャート");
  });

  it("never invents a translation for an empty source either", () => {
    expect(lineText(l("", "A chart"), "en")).toBe("A chart");
    expect(lineText(l("", ""), "en")).toBe("");
  });

  it("offers the switch only when there is something to switch to", () => {
    expect(hasTranslation([l("a"), l("b")])).toBe(false);
    expect(hasTranslation([l("a"), l("b", " ")])).toBe(false);
    expect(hasTranslation([l("a"), l("b", "B")])).toBe(true);
  });

  // A mixed-language excerpt is honest but it has to SAY so, the way the
  // multi-speaker contract reports the speakers it dropped.
  it("counts the lines that will fall back, and only when some are translated", () => {
    expect(untranslated([l("a", "A"), l("b"), l("c", "C")])).toBe(1);
    expect(untranslated([l("a", "A"), l("b", "B")])).toBe(0);
    // not "all untranslated" — a transcript in one language has nothing to report
    expect(untranslated([l("a"), l("b")])).toBe(0);
    expect(untranslated([])).toBe(0);
  });
});
