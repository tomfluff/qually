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

// Does this line finish a sentence? Only the "no" answer merges, so a
// terminator we fail to recognise is the damaging direction: every line of that
// language reads as unfinished and the whole transcript folds into one group per
// speaker. Being generous here is the safe way to be wrong.
//
// Sentence-final marks. ASCII covers the Latin-script languages and modern
// Hebrew, which punctuates with . ? ! like its neighbours; the rest are the
// marks those keyboards actually produce.
const TERMINATORS =
  ".?!\u2026"                    // . ? ! …
  + "\u3002\uFF0E\uFF1F\uFF01" // 。．？！  CJK and fullwidth
  + "\u061F\u06D4"              // ؟ ۔       Arabic question mark, Urdu full stop
  + "\u0964\u0965"              // । ॥       Devanagari danda and double danda
  + "\u0589\u055E\u055C"       // ։ ՞ ՜     Armenian
  + "\u1362\u1367\u1368"       // ። ፧ ፨     Ethiopic
  // Greek's question mark is U+037E. Most Greek keyboards emit ASCII ";" for it
  // instead, and that one is deliberately NOT here: at the end of a line it is a
  // Greek question but in English it is a clause that continues, and guessing
  // wrong for English would stop merging lines that should merge. A Greek
  // question typed with ASCII ";" therefore reads as unfinished — the merge is
  // wrong, the text is not, and no other language pays for it.
  + "\u037E"
  + "\u203D\u2047\u2048\u2049"; // ‽ ⁇ ⁈ ⁉
// What may TRAIL the mark and still leave the sentence finished: closing quotes
// and brackets, in every shape a transcription tool emits. The curly ones matter
// as much as the CJK ones — “I zoom in.” comes out of Word and out of most
// transcription services, and read as unfinished under straight quotes alone.
const CLOSERS =
  "'\")\\]}"                     // ' " ) ] }
  // German closes with “ and ‘ — the marks other languages OPEN with — so both
  // directions of every curly pair belong here; an opening quote can never be
  // what trails a full stop anyway.
  + "\u2019\u201D\u2018\u201C\u203A\u00BB\u2039\u00AB" // ’ ” ‘ “ › » ‹ «
  + "\u300D\u300F\u3011\u3009\u300B\u3015\uFF09\uFF5D\uFF62\uFF63"; // 」』】〉》〕）｝｢｣
// Bidi controls are formatting, not content: RTL text routinely carries a mark
// after its full stop, and it was hiding the terminator behind the anchor.
const BIDI = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const TERMINATED = new RegExp(`[${TERMINATORS}][${CLOSERS}]*$`);
const isPartial = (text: string) => !TERMINATED.test(text.replace(BIDI, "").trim());

// The pause rule needs a line's END. A real end_timestamp wins when the import
// carried one; otherwise it's estimated from how long the text takes to say
// (~150 wpm). A word count beats characters: "mm" and "encyclopedia" are one
// beat each.
const WPS = 2.5;
const speechSec = (text: string) => (text.trim().match(/\S+/g)?.length ?? 0) / WPS;
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
