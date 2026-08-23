// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Stretches: a labelled span of transcript — "these lines come from the
// baseline condition", "this part is the second task". Within-subject studies
// switch conditions INSIDE a session, so the label belongs to a stretch of
// lines, not to the transcript; and because it is a dimension:value pair, the
// same machinery covers any comparison the study declares (condition, task,
// chart type), several at once, overlapping freely.
//
// Deliberately decoupled from event markers: a marker records that something
// happened at a moment; a stretch asserts what a span of talk BELONGS to.
// The researcher may keep marking condition switches as events — this is the
// membership those events only imply.

export interface Stretch {
  pid: string;
  start: number;  // first line id, inclusive
  end: number;    // last line id, inclusive
  dim: string;    // the comparison axis, e.g. "condition"
  value: string;  // the label within it, e.g. "baseline"
}

/** deterministic colour per value: stable across sessions and machines with no
    stored palette — the value IS the identity. Hex, not hsl(), so inkOn() can
    pick a readable text colour for the solid label pill. */
export function stretchColor(value: string): string {
  let h = 0;
  for (const ch of value.toLowerCase().trim()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [r, g, b] = hslToRgb(h % 360, 0.55, 0.45);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** the value's colour, honouring a hand-picked override; keys are normalized
    the same way the hash reads the value, so "Baseline " finds "baseline" */
export const stretchColorOf = (value: string, overrides?: Record<string, string>): string =>
  overrides?.[value.toLowerCase().trim()] ?? stretchColor(value);

export const stretchOverlaps = (s: Stretch, start: number, end: number): boolean =>
  s.start <= end && s.end >= start;

/** the stretches covering any of lines start..end of a transcript */
export function stretchesAt(list: Stretch[], pid: string, start: number, end = start): Stretch[] {
  return list.filter((s) => s.pid === pid && stretchOverlaps(s, start, end));
}

/** the dims in play, stable order — each gets its own gutter column */
export function stretchDims(list: Stretch[]): string[] {
  return [...new Set(list.map((s) => s.dim))].sort();
}

/** per-code evidence split across one dim's values, from accepted segments:
    value -> count of segments overlapping a stretch of that value. A segment
    outside every stretch of the dim counts under "" (unmarked). */
export function coverageOf(
  segments: { pid: string; start: number; end: number; code: string; status: string }[],
  stretches: Stretch[],
  dim: string,
): Map<string, Map<string, number>> {
  const byPid = new Map<string, Stretch[]>();
  for (const s of stretches) {
    if (s.dim !== dim) continue;
    const arr = byPid.get(s.pid) ?? [];
    arr.push(s);
    byPid.set(s.pid, arr);
  }
  const out = new Map<string, Map<string, number>>();
  for (const seg of segments) {
    if (seg.status !== "accepted") continue;
    const hits = (byPid.get(seg.pid) ?? []).filter((s) => stretchOverlaps(s, seg.start, seg.end));
    const values = hits.length ? [...new Set(hits.map((s) => s.value))] : [""];
    const m = out.get(seg.code) ?? new Map<string, number>();
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
    out.set(seg.code, m);
  }
  return out;
}
