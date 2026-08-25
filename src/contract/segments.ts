// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Segment identity + run-collapse.
// segment_ref = "PID:start" or "PID:start-end" (contiguous ranges only).

export function norm(code: string): string {
  return code.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface CodedLine {
  n: number;
  codes: Set<string>;
}

// Per-code independent contiguous runs; overlaps are legal.
// INPUT MUST BE SORTED by n ascending.
export function collapseRuns(lines: CodedLine[]): Map<string, [number, number][]> {
  const runs = new Map<string, [number, number][]>();
  const allCodes = new Set<string>();
  for (const l of lines) for (const c of l.codes) allCodes.add(c);
  for (const code of allCodes) {
    const spans: [number, number][] = [];
    let start: number | null = null;
    let prev: number | null = null;
    for (const l of lines) {
      if (l.codes.has(code)) {
        if (start === null) start = l.n;
        else if (prev !== null && l.n !== prev + 1) { spans.push([start, prev]); start = l.n; }
        prev = l.n;
      } else if (start !== null) { spans.push([start, prev!]); start = null; }
    }
    if (start !== null) spans.push([start, prev!]);
    runs.set(code, spans);
  }
  return runs;
}

export function formatSegRef(pid: string, start: number, end: number): string {
  return pid + ":" + (start === end ? start : start + "-" + end);
}
