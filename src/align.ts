// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Re-import alignment: map an already-coded transcript's line ids onto the line
// ids of a newly imported version of the same transcript, so segments keep
// pointing at the same words.
//
// Line order is preserved across a re-import, so this is a diff, not a search:
// LCS over (speaker + normalized text) gives exact anchors, and lines that only
// changed in place (a typo fix) are recovered by pairing same-length, same-speaker
// gaps between anchors. No similarity scoring, no threshold to tune.
import type { Line } from "./state/store";
import type { Segment } from "./state/store";

const key = (l: Line) =>
  l.speaker.trim().toLowerCase() + String.fromCharCode(0) + l.text.trim().replace(/\s+/g, " ").toLowerCase();

// ponytail: O(n*m) DP. The common prefix/suffix trim below collapses the real
// case (edits inside an otherwise identical file) to a tiny middle, so the cap
// is unreachable in practice. Above it, alignment reports no matches and the
// caller steers the user to Replace / Import as new.
const MAX_CELLS = 4_000_000;

export interface Alignment {
  map: Map<number, number>; // old line id -> new line id
  overlap: number;          // share of old lines that found a home in the new file (0..1)
}

// index pairs of a longest common subsequence of a and b
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

export function alignLines(oldLines: Line[], newLines: Line[]): Alignment {
  const map = new Map<number, number>();
  if (!oldLines.length || !newLines.length) return { map, overlap: 0 };

  const a = oldLines.map(key), b = newLines.map(key);

  // trim the identical head and tail; only the changed middle needs the DP
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  for (let i = 0; i < p; i++) map.set(oldLines[i].id, newLines[i].id);
  for (let i = 0; i < s; i++) map.set(oldLines[oldLines.length - 1 - i].id, newLines[newLines.length - 1 - i].id);

  const aMid = a.slice(p, a.length - s), bMid = b.slice(p, b.length - s);
  if (aMid.length && bMid.length && aMid.length * bMid.length <= MAX_CELLS) {
    const anchors = lcsPairs(aMid, bMid).map(([i, j]) => [i + p, j + p] as [number, number]);
    for (const [i, j] of anchors) map.set(oldLines[i].id, newLines[j].id);

    // Gaps between anchors: a line edited in place doesn't anchor, but it sits
    // between two that did. Same number of old and new lines with matching
    // speakers -> they're the same lines, edited. Pair them off.
    const bounds: [number, number][] = [
      [p - 1, p - 1], ...anchors, [a.length - s, b.length - s],
    ];
    for (let k = 0; k < bounds.length - 1; k++) {
      const [ai, bj] = bounds[k], [an, bn] = bounds[k + 1];
      const oldGap = oldLines.slice(ai + 1, an), newGap = newLines.slice(bj + 1, bn);
      if (!oldGap.length || oldGap.length !== newGap.length) continue;
      if (!oldGap.every((l, i) => l.speaker.trim() === newGap[i].speaker.trim())) continue;
      oldGap.forEach((l, i) => map.set(l.id, newGap[i].id));
    }
  }

  return { map, overlap: map.size / oldLines.length };
}

// A segment survives if any of its lines survives: clamp to the outermost lines
// of its range that still exist. Returns null when the whole range is gone.
export function remapSegment(seg: { start: number; end: number }, map: Map<number, number>): { start: number; end: number } | null {
  let start: number | null = null, end = 0;
  for (let id = seg.start; id <= seg.end; id++) {
    const n = map.get(id);
    if (n === undefined) continue;
    if (start === null) start = n;
    end = n;
  }
  return start === null ? null : { start, end };
}

export interface ImportPreview {
  total: number;     // segments currently on this transcript
  remapped: number;  // how many survive the re-import
  dropped: number;   // how many have no line left to point at
  overlap: number;   // share of old lines found in the new file
  different: boolean; // near-zero overlap -> almost certainly a different transcript
  // Sections are line-id work too, and "replace" discards every one of them
  // while "update" drops the unmappable ones. Undo is cleared across an import,
  // so this preview is the only safety net — counting segments alone let a
  // transcript with no coding and three marked sections offer "discard all 0
  // codes" and then discard all three.
  sections: number;
  sectionsDropped: number;
}

export function previewImport(
  segs: Segment[], oldLines: Line[], newLines: Line[],
  stretches: { start: number; end: number }[] = [],
): ImportPreview & { map: Map<number, number> } {
  const { map, overlap } = alignLines(oldLines, newLines);
  const remapped = segs.filter((s) => remapSegment(s, map) !== null).length;
  const stKept = stretches.filter((s) => remapSegment(s, map) !== null).length;
  return {
    map, overlap, total: segs.length, remapped, dropped: segs.length - remapped,
    sections: stretches.length, sectionsDropped: stretches.length - stKept,
    different: overlap < 0.25,
  };
}
