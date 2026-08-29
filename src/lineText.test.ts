// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The rule that decides which text a code's excerpt, an export and an AI
// request all carry. It is pinned here rather than checked by reading the
// screen, because the three surfaces must agree and only this function makes
// them agree.
import { describe, expect, it } from "vitest";
import { hasTranslation, lineText, untranslated, viewLines, viewTranscripts } from "./lineText";

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

  // viewLines is what lets sixty-odd call sites keep reading `line.text`. Two
  // properties everything downstream leans on, so both are pinned here.
  describe("resolving a whole transcript", () => {
    const lines = [{ id: 1, text: "\u30c1\u30e3\u30fc\u30c8", en: "A chart" },
                   { id: 2, text: "\u306f\u3044" }];

    it("hands back the very same array for the source, so nothing re-renders", () => {
      expect(viewLines(lines, "source")).toBe(lines);
      // and for a transcript with no translation, in EITHER language: switching
      // language on a file that has none must change nothing at all
      const plain = [{ id: 1, text: "hello" }];
      expect(viewLines(plain, "en")).toBe(plain);
    });

    it("resolves each line and leaves the rest of it alone", () => {
      const out = viewLines(lines, "en");
      expect(out.map((l) => l.text)).toEqual(["A chart", "\u306f\u3044"]);
      expect(out[0].id).toBe(1);                 // every other field survives
      expect(out[0].en).toBe("A chart");         // the translation is still there
      expect(lines[0].text).toBe("\u30c1\u30e3\u30fc\u30c8"); // the stored line is untouched
    });

    // order and length have to hold: the Codebook binary-searches the resolved
    // array and then slices the SAME index range out of the stored one
    it("preserves order and length, which the excerpt slice depends on", () => {
      const out = viewLines(lines, "en");
      expect(out).toHaveLength(lines.length);
      expect(out.map((l) => l.id)).toEqual(lines.map((l) => l.id));
    });

    it("computes a language once per array rather than once per read", () => {
      expect(viewLines(lines, "en")).toBe(viewLines(lines, "en"));
      // a NEW array is a new key — an import or an edit cannot serve a stale one
      expect(viewLines([...lines], "en")).not.toBe(viewLines(lines, "en"));
    });

    it("resolves a whole record the same way, for the surfaces handed one", () => {
      const t = { P01: { lines } };
      expect(viewTranscripts(t, "source")).toBe(t);
      expect(viewTranscripts(t, "en").P01.lines.map((l) => l.text)).toEqual(["A chart", "\u306f\u3044"]);
      expect(viewTranscripts(t, "en")).toBe(viewTranscripts(t, "en"));
    });
  });
});
