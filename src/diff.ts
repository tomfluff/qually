// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk

// Minimal character-level diff for a repaired transcript line: trim the shared
// head and tail so the tooltip shows only the span that actually changed, not
// the whole original re-quoted. Crude (no word alignment) but the edits are tiny
// typo repairs, and the point is "here's what moved", not a merge view.
// pre/suf say whether text was trimmed off each end (→ show a "…" there).
export function tinyDiff(a: string, b: string): { del: string; ins: string; pre: boolean; suf: boolean } {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  // the trims walk UTF-16 units, so a boundary can land inside a surrogate pair
  // (two emoji sharing a high surrogate) — back off rather than emit lone halves
  // that render as �
  if (p > 0 && a.charCodeAt(p - 1) >= 0xd800 && a.charCodeAt(p - 1) <= 0xdbff) p--;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && a.charCodeAt(a.length - s) >= 0xdc00 && a.charCodeAt(a.length - s) <= 0xdfff) s--;
  return { del: a.slice(p, a.length - s), ins: b.slice(p, b.length - s), pre: p > 0, suf: s > 0 };
}
