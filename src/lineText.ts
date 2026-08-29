// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Which text of a line is THE text, in one place.
//
// A transcript may carry a translation (the CSV's `text_en` column). Reading it
// is a display choice, but the choice reaches much further than display: the
// excerpt a code carries, what an export writes, and what a model is shown all
// have to agree with each other, or a quote in a paper stops matching the
// evidence behind it. So every one of those surfaces resolves its text through
// this function and none of them re-derives the rule.
//
// The fallback is per LINE, never per transcript: a partly translated file is
// normal (a translator working through it, a passage left in the original on
// purpose), and refusing English for the whole transcript because one line
// lacks it would be worse than showing that line as it was spoken. What must
// never happen is inventing a translation — so an untranslated line reads in
// its own language, and `untranslated` below is how a surface says so out loud.
//
// Structurally typed on purpose: these take the two fields they read, not a
// whole Line, so a caller holding a CSV row or a projection can ask too.

/** "source" is what was spoken; "en" prefers the translation where there is one. */
export type Lang = "source" | "en";

/** A line's text in the requested language, falling back to the source. */
export const lineText = (l: { text: string; en?: string }, lang: Lang): string =>
  (lang === "en" && l.en?.trim() ? l.en : l.text);

/** Does this transcript carry any translation at all? Gates the whole control:
    with no translated line there is nothing to switch between, and an inert
    toggle is a worse answer than no toggle. */
export const hasTranslation = (lines: readonly { en?: string }[]): boolean =>
  lines.some((l) => !!l.en?.trim());

/** How many of these lines have no translation — what a mixed-language excerpt
    is owed. Counted, not guessed at, and 0 when nothing is translated at all:
    a transcript with no translation is not "all untranslated", it is a
    transcript in one language, and there is nothing to report about it. */
export function untranslated(lines: readonly { en?: string }[]): number {
  return hasTranslation(lines) ? lines.filter((l) => !l.en?.trim()).length : 0;
}
