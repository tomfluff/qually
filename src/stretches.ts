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
  // ── set only on a stretch an AI proposed (F7). Absent = the researcher's
  // own mark, which is what every stretch written before F7 is.
  status?: StretchStatus;
  proposedBy?: string;   // "AI · Terra"
  /** the model's one sentence of evidence, restored from redaction. KEPT after
      accepting: a candidate outlives its run (a reload, a project file), and a
      boundary whose reason has evaporated cannot be judged — nor written up. */
  why?: string;
}
/** candidate: proposed, not yet judged. accepted: the researcher said yes, and
    it is now as real as one they drew. rejected: they said no — kept ONLY so a
    re-run does not propose it again, and invisible everywhere else. */
export type StretchStatus = "candidate" | "accepted" | "rejected";

// The one rule every consumer of `stretches` has to obey, in one place.
//
// A section says where in the session something was said, and analysis leans on
// that: coverageOf splits a code's evidence by the values a segment falls
// inside, and the Code map groups by it. An unreviewed proposal reaching those
// would silently reclassify the researcher's own coding — the AI deciding,
// which is the one thing this app promises it never does. So:
//
//   evidence  — theirs, and the proposals they accepted. Counts. Groups. Exports.
//   candidate — drawn striped in the gutter and listed for review. Counts nowhere.
//   rejected  — memory, so a re-run does not resurface it. Drawn nowhere, counts nowhere.

/** does this stretch ASSERT something about the session? */
export const isEvidence = (s: Stretch) => !s.status || s.status === "accepted";
/** the stretches that assert something — for every count, grouping and summary */
export const evidence = (list: Stretch[]) => list.filter(isEvidence);
/** the stretches worth DRAWING: evidence plus what is waiting to be judged */
export const visible = (list: Stretch[]) => list.filter((s) => s.status !== "rejected");

/** deterministic colour per value: stable across sessions and machines with no
    stored palette — the value IS the identity. Hex, not hsl(), so inkOn() can
    pick a readable text colour for the solid label pill. */
// The band is the ONLY visual signal that a line belongs to a section, so it
// owes the 3:1 that WCAG asks of a meaningful graphic. Lightness is what buys
// that, and which lightness depends on the ground: the hue comes from a hash of
// the label, so at one fixed lightness the contrast was a lottery decided by how
// the researcher spelled their condition — and the losing hue FLIPPED between
// themes (yellow reached only 2.26:1 on white, blue 1.89:1 on the dark ground).
// The colour has TWO jobs, and they pull in opposite directions: the band has to
// stand out from the page, and the label pill has to carry small uppercase text
// printed on it. A fixed HSL lightness serves neither reliably, because HSL
// lightness is not brightness — at one setting a yellow is luminous and a blue
// is nearly black, so some labels landed in the dead zone where NEITHER white
// nor black ink clears much over 4.5:1 and the tab reads as mush.
//
// So the target is stated in the terms that actually matter — relative
// luminance — and the lightness is solved per hue to hit it. Every section then
// behaves identically whatever it is called: on the light ground a deep fill
// with white lettering (the same voice as the speaker chips), on the dark
// ground a bright fill with black lettering. Measured over all 360 hues, the
// worst case is 5.76:1 (light) / 8.25:1 (dark) for both the text and the band,
// whichever hue the name happens to hash to.
const BAND = { light: { lum: 0.13, sat: 0.6 }, dark: { lum: 0.45, sat: 0.55 } };

/** relative luminance (WCAG 2.1), the perceptual brightness contrast is built on */
const relLum = ([r, g, b]: [number, number, number]): number => {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** the HSL lightness at which this hue reaches `target` luminance — bisection,
    because luminance climbs monotonically with lightness at a fixed hue but has
    no closed form worth writing */
const lightnessFor = (hue: number, sat: number, target: number): number => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (relLum(hslToRgb(hue, sat, mid)) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

// The solve is 20 bisection steps, and the overlay recolours every visible band
// and pill on every scroll frame — so remember the answer. It is a pure function
// of (value, theme) and the palette is tiny, so the cache is simply kept.
const colorCache = new Map<string, string>();

export function stretchColor(value: string, dark = false): string {
  const key = `${dark ? "d" : "l"}:${value.toLowerCase().trim()}`;
  const hit = colorCache.get(key);
  if (hit) return hit;
  let h = 0;
  for (const ch of value.toLowerCase().trim()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // the HUE still comes from the value alone: a section keeps its identity
  // across sessions, machines and themes, and only its tone follows the ground
  const hue = h % 360;
  const { lum, sat } = dark ? BAND.dark : BAND.light;
  const [r, g, b] = hslToRgb(hue, sat, lightnessFor(hue, sat, lum));
  const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  colorCache.set(key, hex);
  return hex;
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
export const stretchColorOf = (value: string, overrides?: Record<string, string>, dark = false): string =>
  overrides?.[value.toLowerCase().trim()] ?? stretchColor(value, dark);

const stretchOverlaps = (s: Stretch, start: number, end: number): boolean =>
  s.start <= end && s.end >= start;

/** the stretches covering any of lines start..end of a transcript — EVIDENCE
    only, because every caller is asking what these lines belong to, not what
    has been suggested for them. `pending` asks the other question (the review
    dialog), and is the only place a candidate is listed as a fact about lines. */
export function stretchesAt(list: Stretch[], pid: string, start: number, end = start): Stretch[] {
  return list.filter((s) => s.pid === pid && isEvidence(s) && stretchOverlaps(s, start, end));
}
/** the CANDIDATES covering those lines — what the review dialog offers a verdict on */
export function pendingAt(list: Stretch[], pid: string, start: number, end = start): Stretch[] {
  return list.filter((s) => s.pid === pid && s.status === "candidate" && stretchOverlaps(s, start, end));
}

/** A section as an AI payload names it: the same stretch, plus a short id so an
    excerpt can say which parts of the session it sits in without repeating the
    label on every line.

    Numbered rather than named because the axes OVERLAP by design — an excerpt is
    routinely "phase: task 1" and "condition: assisted" at once — so excerpts
    cannot simply be grouped under one heading without lying about the other
    axes. One list, and a tag per excerpt, says the true thing.

    EVIDENCE only, and the guard is here rather than at the call sites for the
    same reason coverageOf's is: a payload that presented an unjudged proposal as
    the shape of the session would have the model reasoning over a boundary the
    researcher never accepted. */
export interface PayloadSection {
  id: string; pid: string; dim: string; value: string; start: number; end: number;
}
export function payloadSections(list: Stretch[], pids: readonly string[]): PayloadSection[] {
  const out: PayloadSection[] = [];
  for (const pid of pids) {
    // by where they start, so the list reads down the session
    const mine = evidence(list).filter((s) => s.pid === pid)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const s of mine) {
      out.push({ id: `S${out.length + 1}`, pid, dim: s.dim, value: s.value, start: s.start, end: s.end });
    }
  }
  return out;
}

/** which of those sections cover lines start..end of a transcript */
export const sectionIdsAt = (
  sections: readonly PayloadSection[], pid: string, start: number, end = start,
): string[] => sections
  .filter((s) => s.pid === pid && s.start <= end && s.end >= start)
  .map((s) => s.id);

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
    // not a call-site filter: this is THE place a proposal could silently
    // reclassify coded evidence, so the guard lives where it cannot be forgotten
    if (s.dim !== dim || !isEvidence(s)) continue;
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
