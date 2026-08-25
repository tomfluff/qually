// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Which colour a code gets.
//
// Two codes sharing a colour is only a PROBLEM when you see them together: two
// identical greens in transcripts you never read side by side cost nothing, but
// two on the same line are unreadable — the lane bars stop telling you which
// coding is which. So the palette is widened (below) and the recolour pass is
// conflict-aware (recolorPlan): it treats codes that overlap on a line as
// neighbours in a graph and refuses to give neighbours the same colour.
//
// Pure functions on purpose: the interesting part is graph colouring, and it is
// worth testing without a store, a codebook, or a browser.

// The twelve hand-picked hues, unchanged — the first twelve codes in any project
// still look exactly as they always have.
export const BASE_COLORS = ["#e0554f", "#3b82c4", "#3fa860", "#c98a2a", "#8e6bc9", "#2fa3a3",
  "#c95c9c", "#7d8f2e", "#b0653a", "#5470d6", "#4f9e86", "#a35ac0"];

const hex2rgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
};
const rgb2hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// HSL, so a hue can be kept while lightness moves — the tiers below are the same
// twelve hues at different lightness, which stays coherent where arbitrary hue
// rotation would drift into muddy or near-duplicate colours.
function rgb2hsl(hex: string): [number, number, number] {
  const [r, g, b] = hex2rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
    : max === g ? (b - r) / d + 2
    : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2hex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgb2hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
// A lightness shift with saturation pulled slightly the other way, so a lighter
// variant reads as its own colour instead of a washed-out version of the base.
const shade = (hex: string, dl: number, ds: number): string => {
  const [h, s, l] = rgb2hsl(hex);
  return hsl2hex(h, Math.max(0.15, Math.min(1, s + ds)), Math.max(0.12, Math.min(0.88, l + dl)));
};

// Thirty-six colours in three tiers. Assignment walks this in order, so a project
// exhausts the twelve distinct hues before it ever reaches a variant.
export const PALETTE: string[] = [
  ...BASE_COLORS,
  ...BASE_COLORS.map((c) => shade(c, 0.18, -0.12)), // lighter, softer
  ...BASE_COLORS.map((c) => shade(c, -0.15, 0.06)), // deeper, richer
];

// How far apart two colours LOOK. Hue does most of the work (circular, so red and
// magenta are close); lightness separates the tiers, which share a hue.
export function colorDistance(a: string, b: string): number {
  const [ha, sa, la] = rgb2hsl(a), [hb, sb, lb] = rgb2hsl(b);
  const dh = Math.abs(ha - hb) > 180 ? 360 - Math.abs(ha - hb) : Math.abs(ha - hb);
  // a grey has no meaningful hue — fall back to lightness alone when either is flat
  const hueWeight = Math.min(sa, sb) < 0.12 ? 0 : 1;
  return dh * hueWeight + Math.abs(la - lb) * 240 + Math.abs(sa - sb) * 40;
}

/** The colour for a NEW code: the first palette entry nothing else is using, else
 *  the least-used one. A counter over codebook size repeated as soon as a code was
 *  deleted; this cannot collide while the palette has an unused colour left. */
export function pickNewColor(used: string[]): string {
  const count = new Map<string, number>();
  for (const c of used) count.set(c.toLowerCase(), (count.get(c.toLowerCase()) ?? 0) + 1);
  let best = PALETTE[0], bestN = Infinity;
  for (const c of PALETTE) {
    const n = count.get(c.toLowerCase()) ?? 0;
    if (n === 0) return c;        // first unused wins — keeps the tier order meaningful
    if (n < bestN) { best = c; bestN = n; }
  }
  return best;
}

export interface SegSpan { pid: string; start: number; end: number; code: string; status: string }

/** Codes that share a line, and so are drawn side by side. Rejected segments are
 *  not drawn as coding, so they create no conflict. */
export function conflictGraph(segments: SegSpan[]): Map<string, Set<string>> {
  const live = segments.filter((s) => s.status !== "rejected");
  const g = new Map<string, Set<string>>();
  const edge = (a: string, b: string) => {
    if (a === b) return;
    (g.get(a) ?? g.set(a, new Set()).get(a)!).add(b);
    (g.get(b) ?? g.set(b, new Set()).get(b)!).add(a);
  };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      // same transcript, overlapping line ranges = visible on the same rows
      if (a.pid === b.pid && a.start <= b.end && b.start <= a.end) edge(a.code, b.code);
    }
  }
  return g;
}

/** Assign every code a colour so that no two codes sharing a line share a colour.
 *
 *  Greedy, highest-degree-first (Welsh–Powell): the codes with the most conflicts
 *  are hardest to place, so they choose while the palette is still open. Among
 *  the colours no neighbour is using, it takes the one that is both least used
 *  overall and most distant from the neighbours already placed — "not identical"
 *  is the requirement, "clearly different" is the point.
 *
 *  `locked` pins colours the researcher chose by hand: they are placed first and
 *  constrain everyone else, rather than being overwritten.
 *  Deterministic: same input, same output (ties break on the code name).
 */
export function recolorPlan(
  codes: string[],
  graph: Map<string, Set<string>>,
  locked: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const deg = (c: string) => graph.get(c)?.size ?? 0;
  for (const c of codes) if (locked[c]) out[c] = locked[c];
  const free = codes.filter((c) => !locked[c])
    .sort((a, b) => deg(b) - deg(a) || (a < b ? -1 : a > b ? 1 : 0));

  const usage = new Map<string, number>();
  for (const c of Object.values(out)) usage.set(c.toLowerCase(), (usage.get(c.toLowerCase()) ?? 0) + 1);

  for (const code of free) {
    const neighbours = [...(graph.get(code) ?? [])].map((n) => out[n]).filter(Boolean);
    const taken = new Set(neighbours.map((c) => c.toLowerCase()));
    let best = "", bestKey: [number, number] = [Infinity, -Infinity];
    for (const c of PALETTE) {
      if (taken.has(c.toLowerCase())) continue;
      const n = usage.get(c.toLowerCase()) ?? 0;
      const near = neighbours.length ? Math.min(...neighbours.map((x) => colorDistance(c, x))) : Infinity;
      // fewer uses first, then furthest from the nearest neighbour
      if (n < bestKey[0] || (n === bestKey[0] && near > bestKey[1])) { best = c; bestKey = [n, near]; }
    }
    // every palette colour already sits on a neighbour (36 codes on one line):
    // nothing left to be distinct from, so fall back to the least-used overall
    const chosen = best || pickNewColor([...usage.entries()].flatMap(([c, n]) => Array(n).fill(c) as string[]));
    out[code] = chosen;
    usage.set(chosen.toLowerCase(), (usage.get(chosen.toLowerCase()) ?? 0) + 1);
  }
  return out;
}
