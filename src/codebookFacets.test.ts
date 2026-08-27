// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Codebook's facet filters hide evidence, so what they hide is pinned here
// rather than checked by clicking. The combinations are where the meaning is: the
// two speaker facets INTERSECT (Near-balanced is a subset of Mixed speakers, not
// an alternative to it), and a code facet must not start passing codes an excerpt
// facet has already rejected.
import { describe, expect, it } from "vitest";
import { EMPTY_CODEBOOK_FACETS, hasCodebookFacets, matchesCodebookFacets,
  matchesExcerptFacets, needsExcerptFacetData,
  type CodebookFacets, type ExcerptFacetValues } from "./codebookFacets";

const on = (patch: Partial<CodebookFacets>): CodebookFacets =>
  ({ ...EMPTY_CODEBOOK_FACETS, ...patch });
const values = (...rows: [number, ExcerptFacetValues][]) => new Map(rows);

describe("Codebook facets", () => {
  it("leaves every excerpt and code alone without building excerpt data when no facet is on", () => {
    expect(needsExcerptFacetData(EMPTY_CODEBOOK_FACETS)).toBe(false);
    expect(matchesExcerptFacets(99, EMPTY_CODEBOOK_FACETS, null)).toBe(true);
    expect(matchesCodebookFacets("A definition", () => [],
      EMPTY_CODEBOOK_FACETS, null)).toBe(true);
  });

  it("keeps only excerpts that dropped another speaker for Mixed speakers", () => {
    const facets = on({ mixedSpeakers: true });
    const data = values(
      [1, { mixedSpeakers: true, nearBalanced: false, note: "" }],
      [2, { mixedSpeakers: false, nearBalanced: false, note: "" }],
    );
    expect([1, 2].filter((sid) => matchesExcerptFacets(sid, facets, data))).toEqual([1]);
    expect(matchesCodebookFacets("", () => [{ sid: 1 }], facets, data)).toBe(true);
    expect(matchesCodebookFacets("", () => [{ sid: 2 }], facets, data)).toBe(false);
  });

  it("keeps only close calls for Near-balanced", () => {
    const facets = on({ nearBalanced: true });
    const data = values(
      [1, { mixedSpeakers: true, nearBalanced: true, note: "" }],
      [2, { mixedSpeakers: true, nearBalanced: false, note: "" }],
    );
    expect([1, 2].filter((sid) => matchesExcerptFacets(sid, facets, data))).toEqual([1]);
    expect(matchesCodebookFacets("", () => [{ sid: 1 }], facets, data)).toBe(true);
    expect(matchesCodebookFacets("", () => [{ sid: 2 }], facets, data)).toBe(false);
  });

  it("intersects Mixed speakers and Near-balanced", () => {
    const facets = on({ mixedSpeakers: true, nearBalanced: true });
    const data = values(
      [1, { mixedSpeakers: true, nearBalanced: false, note: "" }],
      [2, { mixedSpeakers: true, nearBalanced: true, note: "" }],
      [3, { mixedSpeakers: false, nearBalanced: true, note: "" }],
    );
    expect([1, 2, 3].filter((sid) => matchesExcerptFacets(sid, facets, data))).toEqual([2]);
    expect(matchesCodebookFacets("", () => [{ sid: 2 }], facets, data)).toBe(true);
    expect(matchesCodebookFacets("", () => [{ sid: 1 }], facets, data)).toBe(false);
  });

  it("keeps only excerpts with a trimmed non-empty note", () => {
    const facets = on({ withNote: true });
    const data = values(
      [1, { mixedSpeakers: false, nearBalanced: false, note: " A note " }],
      [2, { mixedSpeakers: false, nearBalanced: false, note: " \t" }],
    );
    expect([1, 2].filter((sid) => matchesExcerptFacets(sid, facets, data))).toEqual([1]);
    expect(matchesCodebookFacets("", () => [{ sid: 1 }], facets, data)).toBe(true);
    expect(matchesCodebookFacets("", () => [{ sid: 2 }], facets, data)).toBe(false);
  });

  it("keeps only codes whose trimmed definition is empty for Without a definition", () => {
    const facets = on({ withoutDefinition: true });
    expect(matchesCodebookFacets(" \t", () => [], facets, null)).toBe(true);
    expect(matchesCodebookFacets("Meaning", () => [], facets, null)).toBe(false);
    // a hand-edited project file can carry a codebook entry with no `def` field
    // at all; reading through it used to throw inside render and crash the app
    expect(matchesCodebookFacets(undefined, () => [], facets, null)).toBe(true);
  });

  // Gathering a code's eligible segments allocates, so a code the definition
  // check has already settled must never pay for it — this is the whole reason
  // the argument is a thunk rather than an array.
  it("never gathers a code's segments when a cheaper check already answered", () => {
    let gathered = 0;
    const segments = () => { gathered++; return []; };
    matchesCodebookFacets("Meaning", segments, on({ withoutDefinition: true }), null);
    expect(gathered).toBe(0);
    matchesCodebookFacets("", segments, EMPTY_CODEBOOK_FACETS, null);
    expect(gathered).toBe(0);
    matchesCodebookFacets("", segments, on({ mixedSpeakers: true }), null);
    expect(gathered).toBe(1);
  });

  // Same lesson as the missing `def` above, one level deeper: a hand-edited file
  // can put anything in these fields, and a value that is not text is not a note
  // and not a definition — never a reason to throw inside render.
  it("treats a non-string note or definition as absent rather than throwing", () => {
    const data = values(
      [1, { mixedSpeakers: false, nearBalanced: false, note: undefined }],
      [2, { mixedSpeakers: false, nearBalanced: false, note: 42 }],
      [3, { mixedSpeakers: false, nearBalanced: false, note: { text: "hi" } }],
    );
    const withNote = on({ withNote: true });
    expect([1, 2, 3].filter((sid) => matchesExcerptFacets(sid, withNote, data))).toEqual([]);
    const undefined_ = on({ withoutDefinition: true });
    expect(matchesCodebookFacets(42, () => [], undefined_, null)).toBe(true);
    expect(matchesCodebookFacets({}, () => [], undefined_, null)).toBe(true);
  });

  it("lets an unloaded transcript match no excerpt facet", () => {
    const unloaded = new Map<number, ExcerptFacetValues>();
    expect(matchesExcerptFacets(1, on({ mixedSpeakers: true }), unloaded)).toBe(false);
    expect(matchesExcerptFacets(1, on({ nearBalanced: true }), unloaded)).toBe(false);
    expect(matchesExcerptFacets(1, on({ withNote: true }), unloaded)).toBe(false);
  });

  it("lets a code survive the code facet without requiring a surviving excerpt", () => {
    const facets = on({ withoutDefinition: true });
    expect(matchesCodebookFacets("", () => [], facets, null)).toBe(true);
  });

  // The one combination that could quietly widen the filter instead of narrowing
  // it: an undefined code has nothing an excerpt facet would accept, and must
  // still be dropped rather than let through on the strength of its missing
  // definition.
  it("still requires a surviving excerpt when a code facet joins an excerpt facet", () => {
    const facets = on({ withoutDefinition: true, mixedSpeakers: true });
    const data = values(
      [1, { mixedSpeakers: false, nearBalanced: false, note: "" }],
      [2, { mixedSpeakers: true, nearBalanced: false, note: "" }],
    );
    expect(matchesCodebookFacets("", () => [{ sid: 1 }], facets, data)).toBe(false);
    expect(matchesCodebookFacets("", () => [{ sid: 2 }], facets, data)).toBe(true);
    expect(matchesCodebookFacets("Meaning", () => [{ sid: 2 }], facets, data)).toBe(false);
  });

  // hasCodebookFacets is what the Options dot, the "3 of 12" header and the
  // Clear filters chip all read: if it ever said false while something was
  // hidden, evidence would be missing with nothing on screen admitting it.
  it("reports that something is being hidden for every facet, and only then", () => {
    expect(hasCodebookFacets(EMPTY_CODEBOOK_FACETS)).toBe(false);
    for (const k of ["mixedSpeakers", "nearBalanced", "withNote", "withoutDefinition"] as const) {
      expect(hasCodebookFacets(on({ [k]: true }))).toBe(true);
    }
    // the code facet alone needs no excerpt pass; the others all do
    expect(needsExcerptFacetData(on({ withoutDefinition: true }))).toBe(false);
  });

  it("intersects a note with a speaker facet rather than widening to either", () => {
    const facets = on({ withNote: true, mixedSpeakers: true });
    const data = values(
      [1, { mixedSpeakers: true, nearBalanced: false, note: "" }],
      [2, { mixedSpeakers: false, nearBalanced: false, note: "worth a look" }],
      [3, { mixedSpeakers: true, nearBalanced: false, note: "worth a look" }],
    );
    expect([1, 2, 3].filter((sid) => matchesExcerptFacets(sid, facets, data))).toEqual([3]);
  });

  // Show rejected is the caller's job: it hands in only the segments that count,
  // so a code whose sole mixed-speaker excerpt was rejected disappears with it.
  // Pinning it here keeps the two rules from being re-merged into one.
  it("judges a code only on the segments the caller passed in", () => {
    const facets = on({ mixedSpeakers: true });
    const data = values([7, { mixedSpeakers: true, nearBalanced: false, note: "" }]);
    expect(matchesCodebookFacets("", () => [], facets, data)).toBe(false);
    expect(matchesCodebookFacets("", () => [{ sid: 7 }], facets, data)).toBe(true);
  });
});
