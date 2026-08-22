// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Whose voice a code lives in — the Code map's "By speaker" grouping. A code
// belongs to the speaker who owns most of the lines it was coded on; when
// nobody owns two thirds of them it belongs to the back-and-forth, which is
// its own answer (and often the interesting one: codes born in the exchange,
// or in the researcher's own prompts, rather than in one voice).
//
// A pure derivation over (codes, segments, transcripts), like codeStats — so
// the majority rule is testable without a canvas.
import type { Segment, Line } from "./state/store";

/** the share of a code's lines one speaker must hold to own the code */
export const MAJORITY = 2 / 3;

// Derived piles are keyed separately from speaker piles, because a
// PARTICIPANT MAY BE NAMED "Mixed". Keys are what the map stores positions
// against and what its node ids are built from; `label` is what it draws.
// Prefixed rather than decorated with an odd character: a key ends up in a
// DOM id and a CSS selector, so it has to be plain text.
export const MIXED = "x:mixed";
export const NONE = "x:none";

export interface SpeakerPile { key: string; label: string; codes: string[] }

export function speakerBuckets(
  codes: string[],
  segments: Segment[],
  transcripts: Record<string, { lines: Line[] }>,
): SpeakerPile[] {
  // line id → speaker, per transcript: a segment names a line RANGE, and the
  // speaker can change inside it
  const lineSpk = new Map<string, Map<number, string>>();
  for (const [pid, t] of Object.entries(transcripts))
    lineSpk.set(pid, new Map(t.lines.map((l) => [l.id, l.speaker])));

  const tallies = new Map<string, Map<string, number>>();
  for (const s of segments) {
    // accepted only — a candidate coding is not evidence the researcher has
    // stood behind, same rule as codeStats
    if (s.status !== "accepted") continue;
    const ls = lineSpk.get(s.pid);
    if (!ls) continue;   // a transcript that is not loaded tallies nothing
    const t = tallies.get(s.code) ?? new Map<string, number>();
    for (let i = s.start; i <= s.end; i++) {
      const sp = ls.get(i);
      if (sp) t.set(sp, (t.get(sp) ?? 0) + 1);
    }
    tallies.set(s.code, t);
  }

  const bucketOf = (c: string): { key: string; label: string } => {
    const t = tallies.get(c);
    if (!t || t.size === 0) return { key: NONE, label: "No excerpts" };
    const total = [...t.values()].reduce((a, b) => a + b, 0);
    // ties resolve by name, so the same data always lands the same way
    const [top, n] = [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return n / total >= MAJORITY ? { key: `spk:${top}`, label: top } : { key: MIXED, label: "Mixed" };
  };

  const piles = new Map<string, SpeakerPile>();
  for (const c of codes) {
    const { key, label } = bucketOf(c);
    if (!piles.has(key)) piles.set(key, { key, label, codes: [] });
    piles.get(key)!.codes.push(c);
  }
  // speakers alphabetically; the two derived piles close the row
  const tail = (k: string) => (k === MIXED ? 1 : k === NONE ? 2 : 0);
  return [...piles.values()].sort((a, b) => tail(a.key) - tail(b.key) || a.label.localeCompare(b.label));
}
