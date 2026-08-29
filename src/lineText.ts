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

// Every surface downstream — the transcript, an excerpt, an export, an AI
// payload — wants a list of lines whose `text` is already the one being read.
// Resolving here rather than at each of the sixty-odd places that touch
// `line.text` is not only shorter: it is the only way those places can be
// guaranteed to agree.
//
// Two properties this leans on, both deliberate:
//  - "source" returns the SAME ARRAY, not a copy. An untranslated project (every
//    project that exists today) therefore keeps referential equality through
//    every useMemo and every downstream comparison, and pays nothing at all.
//  - the mapped array is cached against the array it came from, so the whole
//    transcript is walked once per language and not once per render. A new
//    lines array — an import, an edit — is a new key, so the cache cannot go
//    stale; a WeakMap so it dies with the transcript it describes.
const cache = new WeakMap<object, Map<Lang, readonly TextLine[]>>();
interface TextLine { text: string; en?: string }
export function viewLines<T extends TextLine>(lines: readonly T[], lang: Lang): readonly T[] {
  if (lang === "source") return lines;
  let byLang = cache.get(lines);
  if (!byLang) cache.set(lines, (byLang = new Map()));
  const hit = byLang.get(lang);
  if (hit) return hit as readonly T[];
  // an untranslated transcript resolves to itself: same array, same identity,
  // so switching language on a file with no translation changes nothing at all
  const out = hasTranslation(lines) ? lines.map((l) => ({ ...l, text: lineText(l, lang) })) : lines;
  byLang.set(lang, out);
  return out;
}

/** The same, for a whole record of transcripts — for the surfaces that are
    handed the record rather than one transcript's lines (gatherCodeEvidence and
    its three callers). Resolving at the boundary like this is what lets the
    functions BELOW it — the excerpt rule, the evidence gatherer — stay exactly
    as they were: they never learn that a translation exists. */
const recCache = new WeakMap<object, Map<Lang, Record<string, { lines: readonly TextLine[] }>>>();
export function viewTranscripts<T extends TextLine>(
  transcripts: Record<string, { lines: T[] }>, lang: Lang,
): Record<string, { lines: T[] }> {
  if (lang === "source") return transcripts;
  let byLang = recCache.get(transcripts);
  if (!byLang) recCache.set(transcripts, (byLang = new Map()));
  const hit = byLang.get(lang);
  if (hit) return hit as Record<string, { lines: T[] }>;
  const out: Record<string, { lines: readonly TextLine[] }> = {};
  for (const [pid, t] of Object.entries(transcripts)) out[pid] = { lines: viewLines(t.lines, lang) };
  byLang.set(lang, out);
  return out as Record<string, { lines: T[] }>;
}
