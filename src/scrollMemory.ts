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
// The anchors also OUTLIVE the page: the work is autosaved and the tab you were
// on is restored, so a refresh that dropped you back at line 1 of a 900-line
// transcript threw away the one thing the reload couldn't reconstruct — where
// you had read up to. Kept in their own localStorage key rather than the main
// store: they are view state, they change on every scroll frame, and they must
// not ride the project file to another machine (see project.ts).
export interface ScrollAnchor { index: number; delta: number }

const KEY = "coding-app-scroll";

function load(): Record<string, ScrollAnchor> {
  try {
    // localStorage is hand-editable and an anchor is fed straight to
    // scrollToIndex — validate rather than trust
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    const out: Record<string, ScrollAnchor> = {};
    for (const [pid, a] of Object.entries(p as Record<string, unknown>)) {
      const { index, delta } = (a ?? {}) as ScrollAnchor;
      if (Number.isFinite(index) && Number.isFinite(delta) && index >= 0) out[pid] = { index, delta };
    }
    return out;
  } catch { return {}; }
}

export const savedScroll: Record<string, ScrollAnchor> = load();
export const positioned = new Set<string>(); // tabs whose initial position has been applied

// Debounced for the same reason the dock's geometry is: this is written on every
// scroll frame, and localStorage.setItem is synchronous — one write per frame
// would put disk I/O on the scroll's critical path.
let timer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(savedScroll)); } catch { /* quota: the coding matters, this doesn't */ }
  }, 400);
}

/** Record where a tab is parked (the only writer — it keeps the copy on disk in step). */
export function rememberScroll(pid: string, anchor: ScrollAnchor) {
  savedScroll[pid] = anchor;
  persist();
}

/** Carry a tab's position to its new name. A rename is the SAME transcript —
 *  forgetting threw the researcher back to line 1 of a long one, which is the
 *  single thing a reload can't reconstruct and the costliest to redo at a
 *  low-vision reading speed. */
export function renameScroll(from: string, to: string) {
  if (!(from in savedScroll)) return;
  savedScroll[to] = savedScroll[from];
  delete savedScroll[from];
  if (positioned.has(from)) { positioned.delete(from); positioned.add(to); }
  persist();
}

/** Forget one tab's position, or every tab's (a project swap). */
export function forgetScroll(pid?: string) {
  if (pid === undefined) {
    for (const k of Object.keys(savedScroll)) delete savedScroll[k];
    positioned.clear();
    persist();
    return;
  }
  delete savedScroll[pid];
  positioned.delete(pid);
  persist();
}
