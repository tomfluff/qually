// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// How much evidence a code carries, and the orders you can put codes in. Every
// list of codes in the app (transcript sidebar, Codebook, Assist Definitions,
// Draft-definitions picker) reads the same because they all come through here —
// and the first three share one ui.codeSort setting on top of it.
import type { Segment } from "./state/store";

export interface CodeStat { segs: number; pids: number }

// accepted segments only — a candidate or rejected coding is not evidence the
// researcher has stood behind, and the counts are read as "what I have coded"
export function codeStats(
  segments: Segment[],
  transcripts: Record<string, unknown>,
): Record<string, CodeStat> {
  const pidSets: Record<string, Set<string>> = {};
  const out: Record<string, CodeStat> = {};
  for (const s of segments) {
    if (s.status !== "accepted" || !transcripts[s.pid]) continue;
    (out[s.code] ??= { segs: 0, pids: 0 }).segs++;
    (pidSets[s.code] ??= new Set()).add(s.pid);
  }
  for (const c in out) out[c].pids = pidSets[c].size;
  return out;
}

// labels name the ORDER, not just the key — "Excerpts" alone didn't say most-first
export const SORTS = [
  { id: "name", label: "A–Z" },
  { id: "excerpts", label: "Most excerpts" },
  { id: "transcripts", label: "Most transcripts" },
] as const;
export type SortBy = (typeof SORTS)[number]["id"];

// Count sorts run high → low (the point is "what have I coded most"), and fall
// back to the name so equal counts keep a stable, readable order rather than
// whatever order the segments happened to arrive in.
export function sortCodes(names: string[], stats: Record<string, CodeStat>, by: SortBy): string[] {
  const n = (c: string) => stats[c] ?? { segs: 0, pids: 0 };
  return [...names].sort((a, b) => {
    if (by === "excerpts" && n(a).segs !== n(b).segs) return n(b).segs - n(a).segs;
    if (by === "transcripts" && n(a).pids !== n(b).pids) return n(b).pids - n(a).pids;
    return a.localeCompare(b);
  });
}
