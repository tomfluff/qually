// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Dominant-speaker excerpts keep brief interviewer backchannels from drowning
// out the participant's words while still allowing researcher-led excerpts.
//  - excerpt = lines of the speaker with the most total (trimmed) characters
//    in the range; ties -> the participant (non-R).
//  - if the winning speaker is R, prefix the excerpt once with "[R:] ".
//  - closeCall warns when a losing speaker held >= 40% of the characters.

export interface ExLine {
  text: string;
  speaker: string;
}

export interface DroppedSpeaker {
  speaker: string;
  lines: number;
  chars: number;
}

interface ExcerptResult {
  excerpt: string;
  closeCall: boolean;
  speaker: string; // the dominant speaker whose lines the excerpt keeps ("" if empty)
  dropped: DroppedSpeaker[];
}

// Whole-label matches only, same set as the interviewer guess (store.ts guessQuiet
// imports this). The old startsWith("R") rule exported a participant named "Rachel"
// with the researcher prefix — the exact mislabeling the speaker-identity rework
// removed from display logic.
export const RESEARCHER = /^(r|r\d+|researcher|interviewer|moderator|facilitator|int|i)$/i;
const isR = (speaker: string) => RESEARCHER.test(speaker.trim());

// A segment's excerpt: pick its lines out of the transcript, run the rule, and
// hand back the BODY without the "[R:] " marker plus the dominant speaker as a
// field. The marker is produced in exactly one place (below) and was being
// un-produced by nine hand-written regexes scattered across the app — copies
// that had already drifted, since only the Codebook kept the speaker and every
// other surface dropped it, silently showing an interviewer's line as the
// participant's words. One helper, so a surface that wants to label the speaker
// can, and none of them has to know about the marker at all.
interface SegLine { id: number; text: string; speaker: string }
export function segExcerpt(range: { start: number; end: number }, lines: SegLine[]): ExcerptResult {
  const r = excerptOf(lines.filter((l) => l.id >= range.start && l.id <= range.end));
  return { ...r, excerpt: r.excerpt.replace(/^\[R:\] /, "") };
}

export function excerptOf(lines: ExLine[]): ExcerptResult {
  const chars = new Map<string, number>();
  const lineCounts = new Map<string, number>();
  const order: string[] = [];
  for (const l of lines) {
    const sp = l.speaker.trim();
    if (!chars.has(sp)) { chars.set(sp, 0); lineCounts.set(sp, 0); order.push(sp); }
    chars.set(sp, chars.get(sp)! + l.text.trim().length);
    lineCounts.set(sp, lineCounts.get(sp)! + 1);
  }
  if (!order.length) return { excerpt: "", closeCall: false, speaker: "", dropped: [] };

  const total = [...chars.values()].reduce((a, b) => a + b, 0);

  let winner = order[0];
  for (const sp of order) {
    if (chars.get(sp)! > chars.get(winner)!) winner = sp;
    else if (chars.get(sp)! === chars.get(winner)! && isR(winner) && !isR(sp)) winner = sp;
  }

  const body = lines
    .filter((l) => l.speaker.trim() === winner)
    .map((l) => l.text.trim())
    .join(" ");
  const excerpt = isR(winner) ? "[R:] " + body : body;

  let maxLoser = 0;
  for (const sp of order) if (sp !== winner) maxLoser = Math.max(maxLoser, chars.get(sp)!);
  const closeCall = total > 0 && maxLoser / total >= 0.4;
  const dropped = order
    .map((speaker, index) => ({ speaker, index }))
    .filter(({ speaker }) => speaker !== winner && lineCounts.get(speaker)! > 0)
    .sort((a, b) => chars.get(b.speaker)! - chars.get(a.speaker)! || a.index - b.index)
    .map(({ speaker }) => ({ speaker, lines: lineCounts.get(speaker)!, chars: chars.get(speaker)! }));

  return { excerpt, closeCall, speaker: winner, dropped };
}
