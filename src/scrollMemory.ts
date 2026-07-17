// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Per-tab scroll positions. Module scope, NOT component state: TranscriptView unmounts
// entirely while the Browse tab is shown, so a ref would forget every position on the
// way through Browse.
//
// It lives HERE rather than inside TranscriptView because the store has to be able to
// forget a position — a pid is not a stable identity across a re-import or a project
// swap. "P01" in the project you just opened is a different transcript from "P01" in the
// one you closed, and restoring the old scroll anchor into it lands on unrelated text.
//
// The position is an ANCHOR (top item's child index + pixels into it), not a raw
// scrollTop: row heights above the viewport are virtua estimates, and the same VList
// instance serves every tab, so after showing another transcript the estimates for this
// one have changed — a saved pixel offset would land on different text.
export interface ScrollAnchor { index: number; delta: number }

export const savedScroll: Record<string, ScrollAnchor> = {};
export const positioned = new Set<string>(); // tabs whose initial position has been applied

/** Forget one tab's position, or every tab's (a project swap). */
export function forgetScroll(pid?: string) {
  if (pid === undefined) {
    for (const k of Object.keys(savedScroll)) delete savedScroll[k];
    positioned.clear();
    return;
  }
  delete savedScroll[pid];
  positioned.delete(pid);
}
