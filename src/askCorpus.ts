// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The material an Ask run reasons over: the researcher's own analysis, not the
// raw sessions. Coded excerpts (with the code and its definition), the event
// log, and nothing else — so an answer can only ever be grounded in work the
// researcher has already done. That is the point, and the UI says so.
//
// Every item carries a REF, and the ref is the contract: the model may only cite
// refs it was given, and each one resolves back to a place in a transcript the
// answer can link to. Two shapes, because the two materials are anchored
// differently and a shared shape would collide (a single-line excerpt "P01:12"
// against an event on line 12):
//
//   excerpt   P01:2-4          the segment, exactly as coded-segments.csv writes it
//   event     P01@0:12:30      the session clock, as the event list shows it
//
// A plain function, not a hook: the scope spans N transcripts and hooks can't be
// called in a loop. It leans on the same primitives useSummaryData does
// (anchorMarkers, segExcerpt, fmtLike) rather than re-deriving any of them.
import type { State } from "./state/store";
import { anchorMarkers, fmtLike, markerKey } from "./markers";
import { segExcerpt } from "./contract/excerpt";
import { formatSegRef } from "./contract/segments";

export interface AskScope {
  pids: string[];      // transcripts in scope (empty = none)
  codes: string[];     // codes in scope (empty = none)
  events: boolean;     // include the event logs
  excerpts: boolean;   // include the coded excerpts
}

export interface AskExcerpt { ref: string; pid: string; line: number; code: string; time: string; text: string }
export interface AskEvent { ref: string; pid: string; line: number; time: string; type: string; text: string }
export interface AskCorpus {
  excerpts: AskExcerpt[];
  events: AskEvent[];
  codes: { name: string; def: string }[];
  // ref -> where a citation click lands. Also the ALLOW-LIST a reply is filtered
  // against: a ref that isn't in here was invented.
  where: Map<string, { pid: string; line: number }>;
}

export const emptyCorpus = (): AskCorpus => ({ excerpts: [], events: [], codes: [], where: new Map() });

export function buildCorpus(s: State, scope: AskScope): AskCorpus {
  const out = emptyCorpus();
  const pids = scope.pids.filter((p) => s.transcripts[p]);
  const codes = new Set(scope.codes);

  for (const pid of pids) {
    const lines = s.transcripts[pid].lines;
    const tsSample = lines.find((l) => l.ts.trim())?.ts;

    if (scope.excerpts) {
      const segs = s.segments
        .filter((x) => x.pid === pid && x.status === "accepted" && codes.has(x.code))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      for (const seg of segs) {
        const text = segExcerpt(seg, lines).excerpt;
        if (!text) continue;
        // the segment's own timecodes, so a citation is seekable as well as clickable
        const a = lines.find((l) => l.id === seg.start)?.ts.trim() ?? "";
        const b = lines.find((l) => l.id === seg.end)?.ts.trim() ?? "";
        const ref = formatSegRef(pid, seg.start, seg.end);
        out.excerpts.push({
          ref, pid, line: seg.start, code: seg.code,
          time: a ? (b && b !== a ? `${a}–${b}` : a) : "", text,
        });
        out.where.set(ref, { pid, line: seg.start });
      }
    }

    if (scope.events) {
      const list = s.markers.filter((m) => m.pid === pid).sort((a, b) => a.t - b.t);
      const offset = s.video[pid]?.offset ?? 0;
      const placed = anchorMarkers(list, lines, offset);
      const lineOf = new Map<number, number>();
      for (const [lid, ms] of placed.before) for (const mk of ms) lineOf.set(mk.mid, lid);
      const last = lines[lines.length - 1]?.id;
      if (last !== undefined) for (const mk of placed.tail) lineOf.set(mk.mid, last);
      for (const m of list) {
        const time = fmtLike(m.t - offset, tsSample);
        const ref = `${pid}@${time}`;
        // an event with no note carries no information a question can use
        if (!m.label.trim() && !markerKey(m).trim()) continue;
        out.events.push({ ref, pid, line: lineOf.get(m.mid) ?? lines[0]?.id ?? 1, time, type: markerKey(m), text: m.label });
        out.where.set(ref, { pid, line: lineOf.get(m.mid) ?? lines[0]?.id ?? 1 });
      }
    }
  }

  // definitions travel with the excerpts: they are how the model knows what a
  // code MEANS, and they cost almost nothing next to the excerpts themselves
  if (scope.excerpts) {
    const used = new Set(out.excerpts.map((x) => x.code));
    out.codes = [...used].sort().map((name) => ({ name, def: s.codebook[name]?.def ?? "" }));
  }
  return out;
}
