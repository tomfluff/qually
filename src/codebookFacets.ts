// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Which excerpts and codes the Codebook is showing, as a pure predicate over
// facts already computed elsewhere. Kept out of the view so the combinations —
// two speaker facets that must intersect rather than union, a code facet that
// answers without consulting any excerpt — can be pinned by test rather than by
// clicking four checkboxes in every order.
//
// The caller decides which segments are ELIGIBLE (Show rejected is a status
// question, not a facet) and hands only those in; a segment absent from that
// list is absent from the answer.

export interface CodebookFacets {
  mixedSpeakers: boolean;
  nearBalanced: boolean;
  withNote: boolean;
  withoutDefinition: boolean;
}

export interface ExcerptFacetValues {
  mixedSpeakers: boolean;
  nearBalanced: boolean;
  note: unknown;
}

// A project file is hand-editable and nothing validates a segment's notes or a
// codebook entry's definition on the way in: either can arrive missing, or as a
// number, or as an object. Reading `.trim()` through one of those threw INSIDE
// render and took the whole app to the crash screen — the exact failure parseProject
// filters its markers and stretches to avoid. Anything that is not a string is not
// text, so it is not a note and not a definition.
const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const EMPTY_CODEBOOK_FACETS: CodebookFacets = {
  mixedSpeakers: false,
  nearBalanced: false,
  withNote: false,
  withoutDefinition: false,
};

export const hasCodebookFacets = (facets: CodebookFacets): boolean =>
  facets.mixedSpeakers || facets.nearBalanced || facets.withNote || facets.withoutDefinition;

export const needsExcerptFacetData = (facets: CodebookFacets): boolean =>
  facets.mixedSpeakers || facets.nearBalanced || facets.withNote;

export function matchesExcerptFacets(sid: number, facets: CodebookFacets,
  values: ReadonlyMap<number, ExcerptFacetValues> | null): boolean {
  if (!needsExcerptFacetData(facets)) return true;
  const v = values?.get(sid);
  if (!v) return false;
  return (!facets.mixedSpeakers || v.mixedSpeakers)
    && (!facets.nearBalanced || v.nearBalanced)
    && (!facets.withNote || !!asText(v.note));
}

// The name filter is the CALLER's: it decides which codes are in the running at
// all (and its count is what the "3 of 12" header divides by), so running it here
// too would be the same rule in two places, free to drift.
//
// `segments` arrives as a thunk because gathering a code's eligible segments
// allocates, and the definition check settles most codes without ever needing
// them — an argument would have been built for every code in the book, on every
// keystroke in the name filter.
export function matchesCodebookFacets(definition: unknown,
  segments: () => readonly { sid: number }[], facets: CodebookFacets,
  values: ReadonlyMap<number, ExcerptFacetValues> | null): boolean {
  if (facets.withoutDefinition && asText(definition)) return false;
  if (!needsExcerptFacetData(facets)) return true;
  return segments().some((s) => matchesExcerptFacets(s.sid, facets, values));
}
