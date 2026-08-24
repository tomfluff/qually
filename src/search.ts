// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Case-insensitive substring occurrences in a line: [start, end) char offsets.
export function findMatches(text: string, query: string): [number, number][] {
  if (!query) return [];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  let i = 0;
  while ((i = lower.indexOf(q, i)) !== -1) { out.push([i, i + q.length]); i += q.length; }
  return out;
}

/** One occurrence replaced, by its index among the matches in this line.
    Occurrence indices come from findMatches, so this is the same counting the
    search bar shows and steps through. Out-of-range index: text unchanged. */
export function replaceOccurrence(text: string, query: string, occ: number, repl: string): string {
  const m = findMatches(text, query);
  const hit = m[occ];
  if (!hit) return text;
  return text.slice(0, hit[0]) + repl + text.slice(hit[1]);
}

/** Every occurrence in one line replaced, left to right. Returns the new text
    and how many went — the caller reports the count, and a zero means it must
    not touch the line at all (an edit that changes nothing still costs an undo
    entry and a provenance mark). */
export function replaceAllIn(text: string, query: string, repl: string): { text: string; n: number } {
  const m = findMatches(text, query);
  if (!m.length) return { text, n: 0 };
  let out = "", last = 0;
  for (const [s, e] of m) { out += text.slice(last, s) + repl; last = e; }
  return { text: out + text.slice(last), n: m.length };
}
