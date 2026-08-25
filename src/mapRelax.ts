// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Overlap removal for the Code map's "Adjust to zoom".
//
// The job: when captions grow at low zoom and start colliding, move the FEWEST
// things the SHORTEST distance to clear them, and leave everything that is
// already readable exactly where the researcher put it.
//
// Three rules earn their keep, each from a way the first attempt got it wrong:
//
// 1. Only true overlaps count. An earlier version padded every box by a margin
//    scaled to the zoom (24px on screen — 240 world px at 10% zoom) and then
//    looked for overlap, so boxes a comfortable distance apart registered as
//    colliding and got shoved. Boxes are compared as they are; `pad` is only
//    the breathing space added when a pair genuinely does overlap.
//
// 2. Sideways first. Codebook maps are wide and shallow: chips are short and
//    long, so the smaller overlap between two of them is almost always the
//    vertical one, and "separate along the cheaper axis" quietly turned into
//    "always push down". That stacked the map into a column. Horizontal
//    separation is preferred unless it would cost much more than vertical.
//
// 3. Untouched is untouched. Each collision moves BOTH boxes half the
//    correction, so the map grows symmetrically around wherever the crowding
//    is; there is no global re-centring pass, because translating the whole
//    map would move every code the researcher never asked to move.
export interface RBox { id: string; x: number; y: number; w: number; h: number }

interface RelaxOpts {
  /** breathing space inserted between a pair that actually overlaps */
  pad?: number;
  iterations?: number;
  /**
   * How much more expensive a sideways push may be before falling back to a
   * vertical one. 1 = pick the cheaper axis; higher = prefer horizontal.
   */
  horizontalBias?: number;
  /**
   * Boxes that must not move. The other box in the pair takes the whole
   * correction. Used to settle the groups first and then move only the codes
   * their captions landed on, instead of shaking the entire field.
   */
  anchored?: Set<string>;
}

export function relaxBoxes(boxes: RBox[], opts: RelaxOpts = {}): RBox[] {
  const { pad = 10, iterations = 80, horizontalBias = 3, anchored } = opts;
  const out = boxes.map((b) => ({ ...b }));
  if (out.length < 2) return out;

  for (let pass = 0; pass < iterations; pass++) {
    let touched = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        // real overlap, no phantom margin: positive on both axes means the
        // rectangles genuinely intersect
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        const aFixed = anchored?.has(a.id) ?? false;
        const bFixed = anchored?.has(b.id) ?? false;
        if (aFixed && bFixed) continue; // neither may move: not ours to solve
        touched = true;
        // whoever can move pays; if both can, they split it
        const aShare = aFixed ? 0 : bFixed ? 1 : 0.5;
        const bShare = 1 - aShare;
        const pushX = ox + pad, pushY = oy + pad;
        if (pushX <= pushY * horizontalBias) {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? -1 : 1;
          a.x += dir * pushX * aShare; b.x -= dir * pushX * bShare;
        } else {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? -1 : 1;
          a.y += dir * pushY * aShare; b.y -= dir * pushY * bShare;
        }
      }
    }
    if (!touched) break; // settled: nothing overlaps any more
  }

  return out;
}
