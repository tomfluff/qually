// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Session events: the parse (schema-loose by design), the placement (derived from
// the video clock, so it must follow the dock's offset), and the round trip through
// the store — an events file that loses columns or lands on the wrong line is worse
// than no events file at all.
import { beforeAll, test, expect } from "vitest";
import { anchorMarkers, fmtLike, fmtTime, isMarkerRows, markerKey, markerRows, parseMarkers } from "./markers";
import { parseCSV } from "./contract/csv";
import type { Line } from "./state/store";

const EVENTS = `event,code,label,epoch_ms,rec_offset_s,video_time_s,video_time_hms,session,detail
recording_start,,,1786061424172,0.000,0.000,00:00:00.000,P01,anchor_err_ms=16.7
marker,MAKE_PROGRESS,Progress,1786062631965,1207.793,1206.767,00:20:06.767,P01,slot=1;via=hotkey
marker,custom,"Clicks the chart, reads each colour",1786062897390,1473.218,1472.195,00:24:32.195,P01,slot=custom;via=hotkey
marker,custom,No time on this one,1786062897391,,,,P01,slot=custom
`;

const rows = parseCSV(EVENTS);

const lines: Line[] = [
  { id: 1, ts: "0:00:05", speaker: "R", text: "How do you read this chart?" },
  { id: 2, ts: "0:20:00", speaker: "P", text: "I follow the line across." },
  { id: 3, ts: "0:24:00", speaker: "P", text: "This colour is unreadable." },
  { id: 4, ts: "0:30:00", speaker: "P", text: "So I gave up on it." },
];

test("an events CSV is recognised; a transcript CSV is not", () => {
  expect(isMarkerRows(rows)).toBe(true);
  expect(isMarkerRows(parseCSV("line_id,timestamp,text\n1,00:00:03,hello\n"))).toBe(false);
  expect(isMarkerRows([])).toBe(false);
});

test("parse keeps every source column and prefers the video clock", () => {
  const ms = parseMarkers(rows, "P01", 1);
  // the row with no readable time is dropped, not placed at zero
  expect(ms.map((m) => m.label)).toEqual(["", "Progress", "Clicks the chart, reads each colour"]);
  expect(ms.map((m) => m.mid)).toEqual([1, 2, 3]);
  // video_time_s (1206.767), NOT rec_offset_s (1207.793)
  expect(ms[1].t).toBeCloseTo(1206.767, 3);
  expect(ms[1].code).toBe("MAKE_PROGRESS");
  expect(ms[1].raw.epoch_ms).toBe("1786062631965"); // a column QuAlly has no use for survives
});

test("a marker sits before the next line to start, and follows the offset", () => {
  const ms = parseMarkers(rows, "P01", 1);
  const at = anchorMarkers(ms, lines, 0);
  // 0:00 recording_start precedes the 0:00:05 line — an event earlier than a line
  // goes ABOVE it, never pinned under it
  expect(at.before.get(1)?.map((m) => m.label)).toEqual([""]);
  // 20:06 falls between the 20:00 and 24:00 lines, so it renders above the 24:00 one
  expect(at.before.get(3)?.map((m) => m.label)).toEqual(["Progress"]);
  // 24:32 falls between 24:00 and 30:00
  expect(at.before.get(4)?.map((m) => m.label)).toEqual(["Clicks the chart, reads each colour"]);
  expect(at.tail).toEqual([]);

  // The dock's offset is video time minus line time. A +6min offset means the video
  // runs ahead of the transcript, so every marker's LINE time drops by 6 minutes:
  // 0:00 goes negative (above line one), and 20:06/24:32 become 14:06/18:32 — both
  // now before the 20:00 line.
  const early = anchorMarkers(ms, lines, 6 * 60);
  expect(early.before.get(1)?.length).toBe(1);
  expect(early.before.get(2)?.map((m) => m.label))
    .toEqual(["Progress", "Clicks the chart, reads each colour"]);
  expect(early.before.get(3)).toBeUndefined();

  // and the other way: -6min pushes them later — 20:06 becomes 26:06 (above the
  // 30:00 line) and 24:32 becomes 30:32, which is past every line
  const late = anchorMarkers(ms, lines, -6 * 60);
  expect(late.before.get(4)?.map((m) => m.label)).toEqual(["Progress"]);
  expect(late.tail.map((m) => m.label)).toEqual(["Clicks the chart, reads each colour"]);
});

test("markers outside the transcript's span are kept, at the end or the top", () => {
  const ms = parseMarkers(rows, "P01", 1);
  // a transcript whose clock starts after every marker: all three above line one
  const after: Line[] = [{ id: 7, ts: "1:00:00", speaker: "P", text: "late" }];
  expect(anchorMarkers(ms, after, 0).before.get(7)?.length).toBe(3);
  // one that ends before them: all three at the tail, none dropped
  const stub: Line[] = [{ id: 7, ts: "0:00:01", speaker: "P", text: "early" }];
  expect(anchorMarkers(ms, stub, 0).tail.length).toBe(2);
  expect(anchorMarkers(ms, stub, 0).before.get(7)?.length).toBe(1); // the 0:00 one
  // and one with no timecodes at all still shows them all
  const untimed: Line[] = [{ id: 7, ts: "", speaker: "P", text: "untimed" }];
  expect(anchorMarkers(ms, untimed, 0).before.get(7)?.length).toBe(3);
});

test("several markers at the same place keep their time order", () => {
  const ms = parseMarkers(parseCSV(
    `event,code,label,video_time_s\nmarker,a,second,1210\nmarker,b,first,1205\n`), "P01", 1);
  expect(anchorMarkers(ms, lines, 0).before.get(3)?.map((m) => m.label)).toEqual(["first", "second"]);
});

test("export carries every imported column, with the edits winning", () => {
  const ms = parseMarkers(rows, "P01", 1);
  ms[1].label = "Progress — he restated the task";
  const { rows: out, fields } = markerRows(ms);
  expect(fields).toContain("epoch_ms");
  expect(fields).toContain("session");
  expect(out[1].label).toBe("Progress — he restated the task");
  expect(out[1].epoch_ms).toBe("1786062631965");
});

test("H:MM:SS", () => {
  expect(fmtTime(0)).toBe("0:00:00");
  expect(fmtTime(1206.767)).toBe("0:20:07");
  expect(fmtTime(-5)).toBe("0:00:00"); // a marker before a positive offset clamps, never renders "-0:00:05"
});

test("an event's time is printed in the transcript's own shape", () => {
  // MM:SS transcript -> MM:SS event, not "0:01:20"
  expect(fmtLike(80, "01:20")).toBe("01:20");
  expect(fmtLike(1206.767, "20:00")).toBe("20:07");
  // ...but never at the cost of a wrong time: past an hour the hours appear anyway
  expect(fmtLike(3725, "20:00")).toBe("1:02:05");
  // H:MM:SS transcripts keep their hour-field width
  expect(fmtLike(80, "0:00:03")).toBe("0:01:20");
  expect(fmtLike(80, "00:00:03")).toBe("00:01:20");
  // no sample (a transcript with no timecodes at all) falls back to H:MM:SS
  expect(fmtLike(80, undefined)).toBe("0:01:20");
});

// ── through the real store ──────────────────────────────────────────────────
let useStore: typeof import("./state/store").useStore;

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));
  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text\n1,00:00:05,R,How do you read this chart?\n2,00:20:00,P,I follow the line.\n`,
  ], "P01.csv")]);
});

test("importing the same events file twice adds nothing the second time", () => {
  const s = () => useStore.getState();
  expect(s().importMarkers("P01", rows)).toEqual({ added: 3, skipped: 1 }); // 1 = no usable time
  expect(s().markers.length).toBe(3);
  expect(s().importMarkers("P01", rows)).toEqual({ added: 0, skipped: 4 });
  expect(s().markers.length).toBe(3);
});

test("edit, delete and undo behave like the rest of the coding work", () => {
  const s = () => useStore.getState();
  const mid = s().markers[1].mid;
  s().editMarker(mid, "Progress — restated the task");
  expect(s().markers.find((m) => m.mid === mid)?.label).toBe("Progress — restated the task");
  s().deleteMarker(mid);
  expect(s().markers.some((m) => m.mid === mid)).toBe(false);
  s().undo();
  expect(s().markers.find((m) => m.mid === mid)?.label).toBe("Progress — restated the task");
  s().undo();
  expect(s().markers.find((m) => m.mid === mid)?.label).toBe("Progress");
});

test("events.csv re-imports as the same events", () => {
  const s = () => useStore.getState();
  const csv = s().exportMarkers();
  const back = parseCSV(csv);
  expect(isMarkerRows(back)).toBe(true);
  // every event round-trips, so re-importing the export is a no-op
  expect(s().importMarkers("P01", back)).toEqual({ added: 0, skipped: back.length });
});

test("a hand-added event round-trips and dedupes like an imported one", () => {
  const s = () => useStore.getState();
  const n = s().markers.length;
  s().addMarker("P01", { t: 100, code: "custom", label: "typed in the app" });
  expect(s().markers.length).toBe(n + 1);
  const added = s().markers[s().markers.length - 1];
  expect(added.event).toBe("marker");
  // same identity again: a no-op, not a duplicate
  s().addMarker("P01", { t: 100, code: "custom", label: "typed in the app" });
  expect(s().markers.length).toBe(n + 1);
  // it exports through the canonical columns (raw is empty)
  const out = parseCSV(s().exportMarkers());
  expect(out.some((r) => r.label === "typed in the app" && r.event === "marker")).toBe(true);
  s().undo();
  expect(s().markers.length).toBe(n);
});

test("updateMarker edits time/type/text in one undoable step", () => {
  const s = () => useStore.getState();
  const m = s().markers[0];
  s().updateMarker(m.mid, { t: 42, code: "RETYPED", label: "new words" });
  const after = s().markers.find((x) => x.mid === m.mid)!;
  expect([after.t, after.code, after.label]).toEqual([42, "RETYPED", "new words"]);
  s().undo();
  const back = s().markers.find((x) => x.mid === m.mid)!;
  expect([back.t, back.code, back.label]).toEqual([m.t, m.code, m.label]);
});

test("renameMarkerType renames every event of the type and moves its colour", () => {
  const s = () => useStore.getState();
  s().setMarkerColor("custom", "#123456");
  const n = s().markers.filter((m) => markerKey(m) === "custom").length;
  expect(n).toBeGreaterThan(0);
  s().renameMarkerType("custom", "observation");
  expect(s().markers.filter((m) => markerKey(m) === "custom").length).toBe(0);
  expect(s().markers.filter((m) => markerKey(m) === "observation").length).toBe(n);
  expect(s().ui.markerColors.observation).toBe("#123456");
  expect(s().ui.markerColors.custom).toBeUndefined();
  // undo brings the events back under the old name (colour is display state, not undone)
  s().undo();
  expect(s().markers.filter((m) => markerKey(m) === "custom").length).toBe(n);
});

test("renaming a transcript takes its events with it", () => {
  const s = () => useStore.getState();
  expect(s().renameTranscript("P01", "P01-final")).toBe(null);
  expect(s().markers.every((m) => m.pid === "P01-final")).toBe(true);
});
