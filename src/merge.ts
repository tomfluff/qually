// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import type { Line } from "./state/store";
import { tsToSec } from "./video/seek";

// A display unit: one or more consecutive same-speaker lines joined by either
// rule below. Data stays per-line — a Group is only a view over lines
// [startId..endId].
export interface Group {
  ids: number[];
  lines: Line[];
  startId: number;
  endId: number;
  speaker: string;
  ts: string;
}

// ends with . ? ! … (optionally trailing quotes/brackets) -> a complete line
const TERMINATED = /[.?!…]['")\]]*$/;
const isPartial = (text: string) => !TERMINATED.test(text.trim());

// The pause rule needs a line's END. A real end_timestamp wins when the import
// carried one; otherwise it's estimated from how long the text takes to say
// (~150 wpm). A word count beats characters: "mm" and "encyclopedia" are one
// beat each.
const WPS = 2.5;
export const speechSec = (text: string) => (text.trim().match(/\S+/g)?.length ?? 0) / WPS;
const endSec = (l: Line): number | null => {
  if (l.end?.trim()) {
    const e = tsToSec(l.end);
    if (e !== null) return e;
  }
  const s = l.ts.trim() ? tsToSec(l.ts) : null;
  return s === null ? null : s + speechSec(l.text);
};

// Two independent join rules, either merges a line into the same-speaker run
// before it:
//   partial — the previous line doesn't end in a terminator (a sentence split
//             across lines by the transcriber)
//   gapSec  — the pause between the previous line's end and this line's start
//             is at most gapSec (null = off)
export function mergeGroups(lines: Line[], partial: boolean, gapSec: number | null = null): Group[] {
  const groups: Group[] = [];
  const push = (ls: Line[]) => groups.push({
    ids: ls.map((l) => l.id), lines: ls,
    startId: ls[0].id, endId: ls[ls.length - 1].id,
    speaker: ls[0].speaker, ts: ls[0].ts,
  });
  if (!partial && gapSec === null) { for (const l of lines) push([l]); return groups; }
  const joins = (prev: Line, l: Line): boolean => {
    if (prev.speaker.trim() !== l.speaker.trim()) return false;
    if (partial && isPartial(prev.text)) return true;
    // guards keep tsToSec("") (which is 0, not null) from making an untimed
    // pair look 0s apart
    if (gapSec !== null && l.ts.trim() && prev.ts.trim()) {
      const a = endSec(prev), b = tsToSec(l.ts), prevStart = tsToSec(prev.ts);
      // A line that starts BEFORE the one above it is a broken timeline, not a
      // short pause — its negative gap would clear every threshold and merge the
      // whole transcript. (A start inside the previous line's SPEECH is only an
      // overlap, and still merges: b < a, but b >= prevStart.)
      if (b !== null && prevStart !== null && b < prevStart) return false;
      if (a !== null && b !== null && b - a <= gapSec) return true;
    }
    return false;
  };
  let run: Line[] = [];
  for (const l of lines) {
    if (run.length) {
      const prev = run[run.length - 1];
      if (joins(prev, l)) { run.push(l); continue; }
      push(run); run = [];
    }
    run.push(l);
  }
  if (run.length) push(run);
  return groups;
}
