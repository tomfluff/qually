// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// One place that turns the stored markers into placed ones. Two views need the
// same answer — the transcript (rows between the lines) and the sidebar's Events
// list (jump to where a note was made) — and the placement depends on the video
// offset, so computing it twice would let the two drift apart the moment someone
// nudges the offset.
import { useMemo } from "react";
import { useStore } from "./state/store";
import { anchorMarkers } from "./markers";

export function useMarkers(pid: string) {
  const markers = useStore((s) => s.markers);
  const lines = useStore((s) => s.transcripts[pid]?.lines);
  const offset = useStore((s) => s.video[pid]?.offset ?? 0);
  const list = useMemo(
    () => markers.filter((m) => m.pid === pid).sort((a, b) => a.t - b.t),
    [markers, pid]);
  const placed = useMemo(() => anchorMarkers(list, lines ?? [], offset), [list, lines, offset]);
  // mid -> the line to scroll to (the one it sits above; the last line for markers
  // past the end). What the Events list jumps to.
  const lineOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const [lid, ms] of placed.before) for (const mk of ms) m.set(mk.mid, lid);
    const last = lines?.[lines.length - 1]?.id;
    if (last !== undefined) for (const mk of placed.tail) m.set(mk.mid, last);
    return m;
  }, [placed, lines]);
  // a real line's timecode: events print their times in the transcript's own shape
  const tsSample = useMemo(() => lines?.find((l) => l.ts.trim())?.ts, [lines]);
  return { list, placed, lineOf, offset, tsSample };
}
