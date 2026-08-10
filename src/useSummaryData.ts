// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// One transcript's session material, merged: the event log and the ACCEPTED coded
// segments, in transcript order. Two consumers need the same answer — the Summary
// tab's detailed timeline, and the AI summary's payload — and they must agree, or
// the consent preview would show a different session than the screen does.
import { useMemo } from "react";
import { useStore, type Segment } from "./state/store";
import { useMarkers } from "./useMarkers";
import { fmtLike, markerKey, type Marker } from "./markers";
import { excerptOf } from "./contract/excerpt";
import type { SummaryEvent, SummaryExcerpt } from "./ai/summarize";

export type SumItem =
  | { kind: "e"; m: Marker; line: number | undefined }
  | { kind: "s"; seg: Segment; excerpt: string; time: string };

export function useSummaryData(pid: string) {
  const { list, placed, lineOf, offset, tsSample } = useMarkers(pid);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);

  const accepted = useMemo(() =>
    segments.filter((s) => s.pid === pid && s.status === "accepted" && transcripts[pid])
      .sort((a, b) => a.start - b.start || a.end - b.end),
    [segments, pid, transcripts]);

  const rows = useMemo(() => accepted.map((seg) => {
    const ls = transcripts[pid].lines;
    // an excerpt is anchored by TIME, like everything else on this axis — the
    // segment's first and last line timecodes, as the CSV wrote them (one
    // timestamp when they coincide). Untimed lines fall back to line ids.
    const a = ls.find((l) => l.id === seg.start)?.ts.trim() ?? "";
    const b = ls.find((l) => l.id === seg.end)?.ts.trim() ?? "";
    const time = a ? (b && b !== a ? `${a}–${b}` : a) : "";
    return {
      seg, time,
      excerpt: excerptOf(ls
        .filter((l) => l.id >= seg.start && l.id <= seg.end)
        .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, ""),
    };
  }), [accepted, transcripts, pid]);

  // one axis: an event sorts before the line it's anchored before (that's what the
  // anchor MEANS), a segment at its start line; tail events (past the last line) go
  // to the end. lineOf can't order this — it maps tail events onto the LAST line
  // (that's where a click should land), which would sort them before a segment
  // starting there.
  const anchor = useMemo(() => {
    const m = new Map<number, number>();
    for (const [lid, ms] of placed.before) for (const mk of ms) m.set(mk.mid, lid);
    return m;
  }, [placed]);
  const items = useMemo<SumItem[]>(() => {
    const evs: SumItem[] = list.map((m) => ({ kind: "e", m, line: anchor.get(m.mid) }));
    const segs: SumItem[] = rows.map(({ seg, excerpt, time }) => ({ kind: "s", seg, excerpt, time }));
    const key = (i: SumItem): [number, number, number] => i.kind === "e"
      ? [i.line ?? Infinity, 0, i.m.t]
      : [i.seg.start, 1, i.seg.end];
    return [...evs, ...segs].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  }, [list, lineOf, rows]);

  // the same material, shaped for the AI payload
  const events = useMemo<SummaryEvent[]>(() => list.map((m) => ({
    time: fmtLike(m.t - offset, tsSample), type: markerKey(m), text: m.label,
  })), [list, offset, tsSample]);
  // the ref the model quotes back in Highlights — the time the researcher can
  // actually seek to, not an internal line id (which falls in only when untimed)
  const excerpts = useMemo<SummaryExcerpt[]>(() => rows.map(({ seg, excerpt, time }) => ({
    code: seg.code,
    ref: time ? `${pid} ${time}` : `${pid}:${seg.start}${seg.end !== seg.start ? `-${seg.end}` : ""}`,
    excerpt,
  })), [rows, pid]);

  return { items, events, excerpts, lineOf, offset, tsSample };
}
