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
import { linesOf, type State } from "./state/store";
import { anchorMarkers, fmtLike, markerKey } from "./markers";
import { segExcerpt } from "./contract/excerpt";
import { formatSegRef } from "./contract/segments";
import { payloadSections, sectionIdsAt, type PayloadSection } from "./stretches";

export interface AskScope {
  pids: string[];      // transcripts in scope (empty = none)
  codes: string[];     // codes in scope (empty = none)
  events: boolean;     // include the event logs
  excerpts: boolean;   // include the coded excerpts
}

// `codes` is a LIST because one span is routinely coded twice — the excerpt is
// one piece of evidence carrying two codes, not two excerpts. Merging them is
// what keeps a ref unique, which is the whole contract.
interface AskExcerpt { ref: string; pid: string; line: number; codes: string[]; speaker: string; time: string; text: string;
  /** ids of the sections these lines sit in — see payloadSections */
  sections: string[] }
interface AskEvent { ref: string; pid: string; line: number; time: string; type: string; text: string;
  /** ids of the sections this moment falls inside — see payloadSections */
  sections: string[] }
export interface AskCorpus {
  excerpts: AskExcerpt[];
  events: AskEvent[];
  /** the shape of the sessions in scope: what the excerpts and events sit inside */
  sections: PayloadSection[];
  codes: { name: string; def: string }[];
  // ref -> where a citation click lands. Also the ALLOW-LIST a reply is filtered
  // against: a ref that isn't in here was invented.
  where: Map<string, { pid: string; line: number }>;
}

export const emptyCorpus = (): AskCorpus => ({ excerpts: [], events: [], sections: [], codes: [], where: new Map() });

export function buildCorpus(s: State, scope: AskScope): AskCorpus {
  const out = emptyCorpus();
  const pids = scope.pids.filter((p) => s.transcripts[p]);
  const codes = new Set(scope.codes);
  // where in each session things were said. Accepted sections only (the helper
  // enforces it), so a question is never answered against a boundary the
  // researcher has not agreed to.
  out.sections = payloadSections(s.stretches, pids);

  for (const pid of pids) {
    // the language the study is read in, so a question and its answer quote
    // the same words the codebook does
    const lines = linesOf(s.transcripts, s.ui.lang, pid);
    const tsSample = lines.find((l) => l.ts.trim())?.ts;

    if (scope.excerpts) {
      const segs = s.segments
        .filter((x) => x.pid === pid && x.status === "accepted" && codes.has(x.code))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      // Two codes on one span share a segment ref, and a ref that denotes two
      // different things is a citation that can point at the wrong evidence. They
      // are the same excerpt, so they become ONE entry carrying both codes.
      const byRef = new Map<string, AskExcerpt>();
      for (const seg of segs) {
        const ex = segExcerpt(seg, lines);
        if (!ex.excerpt) continue;
        const ref = formatSegRef(pid, seg.start, seg.end);
        const already = byRef.get(ref);
        if (already) { if (!already.codes.includes(seg.code)) already.codes.push(seg.code); continue; }
        // the segment's own timecodes, so a citation is seekable as well as clickable
        const a = lines.find((l) => l.id === seg.start)?.ts.trim() ?? "";
        const b = lines.find((l) => l.id === seg.end)?.ts.trim() ?? "";
        byRef.set(ref, {
          ref, pid, line: seg.start, codes: [seg.code], speaker: ex.speaker,
          time: a ? (b && b !== a ? `${a}–${b}` : a) : "", text: ex.excerpt,
          sections: sectionIdsAt(out.sections, pid, seg.start, seg.end),
        });
      }
      for (const x of byRef.values()) {
        out.excerpts.push(x);
        out.where.set(x.ref, { pid, line: x.line });
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
      // two events can land on the same second, which would share a ref for the
      // same reason — they are one moment, so they read as one entry
      const evByRef = new Map<string, AskEvent>();
      for (const m of list) {
        const type = markerKey(m).trim();
        // an event with neither a type nor a note carries nothing a question can use
        if (!m.label.trim() && !type) continue;
        const time = fmtLike(m.t - offset, tsSample);
        const ref = `${pid}@${time}`;
        const line = lineOf.get(m.mid) ?? lines[0]?.id ?? 1;
        const already = evByRef.get(ref);
        if (already) {
          if (type && !already.type.includes(type)) already.type += `; ${type}`;
          if (m.label.trim()) already.text = already.text ? `${already.text}; ${m.label}` : m.label;
          continue;
        }
        // an event is anchored to a line, so it sits in the same sections that
        // line does — the prompt promises both excerpts AND events carry these
        evByRef.set(ref, { ref, pid, line, time, type, text: m.label,
          sections: sectionIdsAt(out.sections, pid, line) });
      }
      for (const x of evByRef.values()) {
        out.events.push(x);
        out.where.set(x.ref, { pid, line: x.line });
      }
    }
  }

  // definitions travel with the excerpts: they are how the model knows what a
  // code MEANS, and they cost almost nothing next to the excerpts themselves
  if (scope.excerpts) {
    const used = new Set(out.excerpts.flatMap((x) => x.codes));
    out.codes = [...used].sort().map((name) => ({ name, def: s.codebook[name]?.def ?? "" }));
  }
  return out;
}

// Where a citation lands. Resolved against the CURRENT project, not a map stored
// with the answer: an excerpt can be recoded, resized or deleted afterwards, and
// a link that goes where the segment lives NOW is the honest one. A ref that no
// longer resolves simply doesn't navigate.
//
// Lives here because this module defines both ref shapes, and a parser that
// drifts from the writer is how a citation ends up pointing at the wrong thing.
export function refTarget(s: State, ref: string): { pid: string; line: number } | null {
  // the segment shape is tried FIRST because it is the stricter one: a pid may
  // legally contain "@" (it comes from a filename), and splitting on that first
  // would read the excerpt ref "a@b:2-3" as an event on a transcript called "a"
  const seg = /^(.+):(\d+)(?:-(\d+))?$/.exec(ref);
  if (seg && s.transcripts[seg[1]]) return { pid: seg[1], line: +seg[2] };
  const at = ref.lastIndexOf("@");
  if (at <= 0) return null;
  const pid = ref.slice(0, at), time = ref.slice(at + 1);
  const lines = s.transcripts[pid]?.lines;
  if (!lines?.length) return null;
  const offset = s.video[pid]?.offset ?? 0;
  const tsSample = lines.find((l) => l.ts.trim())?.ts;
  const list = s.markers.filter((m) => m.pid === pid).sort((a, b) => a.t - b.t);
  const hit = list.find((m) => fmtLike(m.t - offset, tsSample) === time);
  if (!hit) return null;
  const placed = anchorMarkers(list, lines, offset);
  for (const [lid, ms] of placed.before) if (ms.some((m) => m.mid === hit.mid)) return { pid, line: lid };
  return { pid, line: lines[lines.length - 1].id }; // an event past the last line
}
