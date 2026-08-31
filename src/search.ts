// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { tsToSec } from "./video/seek";
// Case-insensitive substring occurrences in a line: [start, end) char offsets.
export function findMatches(text: string, query: string): [number, number][] {
  if (!query) return [];
  const q = query.toLowerCase();
  const out: [number, number][] = [];
  // Scanned in TEXT coordinates, not in text.toLowerCase(). toLowerCase is not
  // length-preserving — Turkish dotted capital I (U+0130) lowercases to two
  // UTF-16 units — so offsets taken from the lowered string drift by one for
  // everything after it, and here that drift lands on a WRITE: replaceAllIn
  // sliced the original text with them and ate a character.
  // "Istanbul was mentioned" (with U+0130) replacing "was" produced "wXmentioned".
  // Lines are short; comparing per position costs nothing and is right for
  // every input, including the ones where a case fold changes length.
  const n = query.length;
  if (!n) return out;
  for (let i = 0; i + n <= text.length; i++) {
    if (text.slice(i, i + n).toLowerCase() === q) { out.push([i, i + n]); i += n - 1; }
  }
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

// ── the filter: which lines a search is allowed to look at ──────────────────
// A search of a study transcript is often a search of one PERSON's words ("did
// the participant ever say this, or was it only ever me asking?"), or of one
// stretch of the session ("the second task, after 12 minutes"). Both narrow
// what counts as a hit — and, when Replace All runs, what it is allowed to
// rewrite.

/** speaker: "" is every speaker; otherwise an exact (case-insensitive) name.
    range: "" is the whole transcript — see parseRange for what it accepts. */
export interface LineScope { speaker: string; range: string }

/** A line range ("12-40") or a stretch of the session ("3:00-12:30"), parsed.
    Either end may be left off ("12-", "-40"), and a bare "12" reads as "12
    onward". A colon on either side makes it a TIME range; without one it is
    line numbers. A mixed pair ("12-3:00") is refused, not guessed at: a bare
    number beside a timecode could mean seconds, minutes, or a line, and
    "3:00-12" quietly read as 0:12–3:00 would hand Replace All the wrong
    stretch of the session. Backwards ("40-12") is the same stretch, not an
    empty one. Unparseable returns null, which every caller reads as "no
    range". */
export function parseRange(s: string): { time: boolean; a: number; b: number } | null {
  const p = s.trim().split("-");
  if (p.length > 2) return null;
  const a = p[0].trim(), b = (p[1] ?? "").trim();
  if (!a && !b) return null;
  const time = a.includes(":") || b.includes(":");
  const val = (v: string) => time
    ? (v.includes(":") ? tsToSec(v) : null) // both ends of a time range are times
    : (/^\d+$/.test(v) ? Number(v) : null);
  const lo = a ? val(a) : 0;
  const hi = b ? val(b) : Infinity;
  if (lo === null || hi === null) return null;
  return { time, a: Math.min(lo, hi), b: Math.max(lo, hi) };
}

/** The predicate for one filter, with the range parsed ONCE — it is asked of
    every line of the transcript, on every keystroke.
    An UNTIMED line is outside every time range: a line with no timecode cannot
    be placed in the session, and reading a blank as 0:00 would pile every
    untimed line into the opening minute. */
export function scopeFilter(f: LineScope): (l: { id: number; ts: string; speaker: string }) => boolean {
  const sp = f.speaker.trim().toLowerCase();
  const r = parseRange(f.range);
  // A range typed but unreadable ("12--40") matches NOTHING. Reading it as "no
  // range" is the dangerous half of a typo: the bar prints its hint, but the
  // count, the highlights and — worst — Replace All would go on working
  // against the whole transcript, which is exactly what the researcher had
  // just told them not to do. Nothing found is a state they can see and fix.
  if (!r && f.range.trim()) return () => false;
  if (!sp && !r) return () => true;
  return (l) => {
    if (sp && l.speaker.trim().toLowerCase() !== sp) return false;
    if (!r) return true;
    if (!r.time) return l.id >= r.a && l.id <= r.b;
    const s = l.ts.trim() ? tsToSec(l.ts) : null;
    return s !== null && s >= r.a && s <= r.b;
  };
}
