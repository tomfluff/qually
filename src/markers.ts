// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Session event logs: markers and field notes captured DURING a session (hotkey
// presses, break flags, free-text observations), imported per transcript from the
// recorder's own CSV.
//
// Deliberately schema-loose. Every study's recorder writes a slightly different
// file, so only three things are required — an `event` column, a time column, and
// whatever text the row carries. Unknown columns are kept verbatim on the marker
// (`raw`) and written back out on export, so importing into QuAlly never costs a
// column the pipeline downstream still wants.
//
// A marker's TIME is authoritative; its position in the transcript is DERIVED
// (anchorMarkers) from the video clock and the dock's per-transcript offset. So
// correcting the offset, or re-importing the transcript with different line ids,
// re-places every marker instead of stranding it on a line that moved.
import { tsToSec } from "./video/seek";
import type { Line } from "./state/store";

export interface Marker {
  mid: number;
  pid: string;
  event: string;  // recording_start | marker | recording_stop | anything else
  code: string;   // MAKE_PROGRESS | custom | "" — the grouping + colour key
  label: string;  // the note itself; editable in the app
  t: number;      // seconds on the VIDEO clock (video_time_s)
  detail: string; // the recorder's own annotations (slot=…;via=hotkey)
  raw: Record<string, string>; // the source row, for a lossless export
}

// Time columns in preference order. video_time_s is the one that matches the media
// file; rec_offset_s is the recorder's own clock (a beat earlier — it includes the
// anchor error); the h:mm:ss string is the last resort.
const TIME_COLS = ["video_time_s", "rec_offset_s"] as const;

// An events CSV, as opposed to a transcript / codebook / segments CSV.
export const isMarkerRows = (rows: Record<string, string>[]): boolean => {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return cols.includes("event")
    && (cols.includes("video_time_hms") || TIME_COLS.some((c) => cols.includes(c)));
};

const num = (v: string | undefined): number | null => {
  const s = (v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// tsToSec is deliberately lenient for transcript timecodes — it reads "" as 0. A
// BLANK time is not midnight: a row (or a line) with no time must be unplaceable,
// or every untimed row silently piles up at the start of the session.
const secOf = (ts: string | undefined): number | null => {
  const s = (ts ?? "").trim();
  return s ? tsToSec(s) : null;
};

function rowTime(r: Record<string, string>): number | null {
  for (const c of TIME_COLS) { const n = num(r[c]); if (n !== null) return n; }
  return secOf(r.video_time_hms);
}

// The colour + grouping key. recording_start/stop carry no code, so they group
// under their event name rather than all collapsing into one blank bucket.
export const markerKey = (m: Pick<Marker, "code" | "event">): string =>
  m.code.trim() || m.event.trim() || "event";

// A palette of its own, NOT the codebook's: an event is not a code, and sharing
// the twelve code colours would make "MAKE_PROGRESS" look like somebody's coding.
// Cooler and darker than COLORS, and stable per key (FNV-1a, as elsewhere).
const MARKER_COLORS = ["#7c5cd6", "#2f8f8f", "#c2703c", "#3d7fd6",
  "#a8478f", "#5f8c37", "#c0603f", "#4a6fb5"];
// A chosen colour (ui.markerColors, set by right-clicking the type) always wins;
// otherwise the hash gives every kind of event a stable one with nothing to store.
export const markerColor = (key: string, chosen?: Record<string, string>): string => {
  const own = chosen?.[key];
  if (own) return own;
  let h = 0x811c9dc5;
  const s = key.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return MARKER_COLORS[(h >>> 0) % MARKER_COLORS.length];
};

// seconds -> H:MM:SS
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// The transcript prints its timecodes exactly as the CSV wrote them, so a marker
// formatted to a fixed shape sits next to them looking like a different clock:
// "0:01:20" beside "01:20". Copy the shape from a real line instead — the same
// number of fields, and the same width on the leading one. Hours are added anyway
// when the marker needs them (an MM:SS transcript that runs past an hour), because
// dropping them would print a time that is simply wrong.
export function fmtLike(sec: number, sample: string | undefined): string {
  const parts = (sample ?? "").split(".")[0].split(":");
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (parts.length === 2 && h === 0) return `${two(m)}:${two(ss)}`;
  if (parts.length === 3) {
    // match the hour field's width ("00:20:06" vs "0:20:06")
    const hw = Math.max(1, parts[0].trim().length);
    return `${String(h).padStart(hw, "0")}:${two(m)}:${two(ss)}`;
  }
  return fmtTime(sec);
}

// Parse an events CSV into markers for ONE transcript. Rows with no readable time
// are skipped — a marker that can't be placed is worse than one that isn't there.
export function parseMarkers(rows: Record<string, string>[], pid: string, firstMid: number): Marker[] {
  const out: Marker[] = [];
  let mid = firstMid;
  for (const r of rows) {
    const t = rowTime(r);
    if (t === null) continue;
    out.push({
      mid: mid++, pid,
      event: (r.event ?? "").trim(),
      code: (r.code ?? "").trim(),
      label: r.label ?? "",
      t, detail: r.detail ?? "",
      raw: r,
    });
  }
  return out;
}

// Same marker, imported twice (the file re-dropped, or an overlapping export).
// Identity is the recorded fact — transcript, time, event, code, text — never the
// mid, which is ours and always fresh.
export const markerIdent = (m: Marker): string =>
  `${m.pid}|${m.t}|${m.event}|${m.code}|${m.label}`;

// Where each marker falls in the transcript. `offset` is the video dock's
// per-transcript offset, with the SAME sign convention as seekVideo (video time =
// line time + offset), so a marker's line time is its video time minus the offset.
//
// Placement is PURELY by the clock: a marker goes immediately before the first line
// that starts after it. So an event at 0:01 precedes a line starting at 0:05 rather
// than being pinned under it, and reading down the transcript the times only ever
// increase. Markers after the last line become `tail`; a transcript with no
// timecodes at all collects them all at the top rather than dropping them — an
// unplaceable note must still be visible and clickable.
interface Placed {
  before: Map<number, Marker[]>; // line id -> markers rendered immediately above it
  tail: Marker[];                // markers later than every line
}

export function anchorMarkers(markers: Marker[], lines: Line[], offset: number): Placed {
  const before = new Map<number, Marker[]>();
  const tail: Marker[] = [];
  if (!lines.length) return { before, tail };
  const timed = lines
    .map((l) => ({ id: l.id, sec: secOf(l.ts) }))
    .filter((x): x is { id: number; sec: number } => x.sec !== null);
  const add = (id: number, m: Marker) => {
    const cur = before.get(id);
    if (cur) cur.push(m); else before.set(id, [m]);
  };
  for (const m of [...markers].sort((a, b) => a.t - b.t)) {
    const target = m.t - offset;
    // linear scan: an events file is dozens of rows, a transcript is thousands —
    // a binary search here would be a cleverness with nothing to buy
    const next = timed.find((l) => l.sec > target);
    if (next) add(next.id, m);
    else if (timed.length) tail.push(m);
    else add(lines[0].id, m); // nothing is timed: keep them, at the top
  }
  return { before, tail };
}

// Export: every column the imported rows carried, in first-appearance order, with
// the in-app edits (label, code) winning over the stored copy. A marker that never
// came from a file still writes the canonical columns.
// `pid` FIRST and always. exportMarkers writes every transcript's events to one
// file; without a pid column, re-importing that file onto a tab stamped the
// target's pid on every row, so P02's events silently became P01's and the toast
// read as success. DATA-FORMAT.md promised the round-trip was a no-op, and for
// any study with more than one transcript it was not.
const CORE = ["pid", "event", "code", "label", "video_time_s", "video_time_hms", "detail"];
export function markerRows(markers: Marker[]): { rows: Record<string, string>[]; fields: string[] } {
  const fields: string[] = [];
  for (const m of markers) for (const k of Object.keys(m.raw)) if (!fields.includes(k)) fields.push(k);
  for (const c of CORE) if (!fields.includes(c)) fields.push(c);
  const rows = markers.map((m) => ({
    ...m.raw,
    pid: m.pid,
    event: m.event, code: m.code, label: m.label, detail: m.detail,
    // the in-app time wins, like every other edited field above: keeping the
    // source row's copy meant retiming an imported event exported (and
    // re-imported) the time it had before the edit
    video_time_s: String(m.t),
    video_time_hms: fmtTime(m.t),
  }));
  return { rows, fields };
}
