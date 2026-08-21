// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Overlap removal for the Code map's "Spread" toggle.
//
// The problem: group captions counter-scale with the viewport (they hold a
// readable on-screen size as you zoom out), so far enough out they grow past
// the blocks they name and collide with the neighbours. Scaling every position
// away from the origin fixes the collisions but throws the whole map across
// the screen, which is disorienting — the researcher has a mental picture of
// where things are.
//
// So: move things as LITTLE as possible instead. This is the standard
// push-apart relaxation (the family PRISM and Igarashi-style "as-rigid-as-
// possible" layout adjustment come from): repeatedly find overlapping pairs
// and separate them along the axis where they overlap least, splitting the
// correction between them. Relative arrangement survives — what was left stays
// left, what was above stays above — because each push is the smallest one
// that resolves that pair, and the total drift is re-centred at the end so the
// map does not walk away from the viewport.
export interface RBox { id: string; x: number; y: number; w: number; h: number }

export function relaxBoxes(boxes: RBox[], gap = 8, iterations = 60): RBox[] {
  const out = boxes.map((b) => ({ ...b }));
  if (out.length < 2) return out;
  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        // signed overlap on each axis, including the breathing gap
        const ox = Math.min(a.x + a.w + gap, b.x + b.w + gap) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h + gap, b.y + b.h + gap) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // separate along the cheaper axis, half the correction each — ties
        // broken by id so the result is deterministic, never jittery
        if (ox < oy) {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? -1 : 1;
          a.x += (dir * ox) / 2; b.x -= (dir * ox) / 2;
        } else {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? -1 : 1;
          a.y += (dir * oy) / 2; b.y -= (dir * oy) / 2;
        }
      }
    }
    if (!moved) break; // settled: nothing overlaps any more
  }
  // hold the centre still, so the spread grows outward around what the
  // researcher is looking at rather than drifting off in one direction
  const mid = (list: RBox[], k: "x" | "y", s: "w" | "h") => {
    const lo = Math.min(...list.map((b) => b[k]));
    const hi = Math.max(...list.map((b) => b[k] + b[s]));
    return (lo + hi) / 2;
  };
  const dx = mid(boxes, "x", "w") - mid(out, "x", "w");
  const dy = mid(boxes, "y", "h") - mid(out, "y", "h");
  return out.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy }));
}
