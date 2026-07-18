// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Transcription repair: editLine provenance (orig kept, revert clears it),
// segments untouched, corrected text flowing into both exports.
import { beforeAll, test, expect } from "vitest";
import { parseCSV } from "./contract/csv";
import { hashLine } from "./ai/flag";

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
    `line_id,timestamp,speaker,text,codes
1,00:00:03,P,I kept losing the ticket marks,magnification
2,00:00:09,P,so I zoomed in further,magnification
`,
  ], "P01.csv")]);
});

test("editing a line keeps the original and leaves segments alone", () => {
  const before = useStore.getState().segments;
  useStore.getState().editLine("P01", 1, "I kept losing the tick marks");
  const l = useStore.getState().transcripts.P01.lines[0];
  expect(l.text).toBe("I kept losing the tick marks");
  expect(l.orig).toBe("I kept losing the ticket marks");
  expect(useStore.getState().segments).toBe(before); // same reference: untouched
});

test("a second edit keeps the FIRST original", () => {
  useStore.getState().editLine("P01", 1, "I kept losing the tick marks entirely");
  expect(useStore.getState().transcripts.P01.lines[0].orig).toBe("I kept losing the ticket marks");
});

test("the edit log exports original vs corrected", () => {
  const rows = parseCSV(useStore.getState().exportEdits());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    pid: "P01", line_id: "1",
    original: "I kept losing the ticket marks",
    corrected: "I kept losing the tick marks entirely",
  });
});

test("the segments export quotes the corrected text", () => {
  const seg = parseCSV(useStore.getState().exportCSV()).find((r) => r.segment_ref === "P01:1-2");
  expect(seg!.excerpt).toContain("tick marks entirely");
});

test("editing back to the original clears the edited flag", () => {
  useStore.getState().editLine("P01", 1, "I kept losing the ticket marks");
  const l = useStore.getState().transcripts.P01.lines[0];
  expect(l.orig).toBeUndefined();
  expect(parseCSV(useStore.getState().exportEdits())).toHaveLength(0);
});

test("scan cache accumulates lenses and keeps other lenses' spans on re-scan", () => {
  const st = useStore.getState();
  const lines = st.transcripts.P01.lines;
  // first scan: transcription only
  st.addFlags("P01", { 1: [{ quote: "ticket marks", reason: "tick marks", lens: "transcription" }] }, lines, ["transcription"]);
  // second scan: emotion only — must keep the transcription span and merge the lens sets
  st.addFlags("P01", { 1: [{ quote: "losing", reason: "frustration", lens: "emotion" }] }, lines, ["emotion"]);
  const f = useStore.getState().aiFlags["P01:1"];
  expect(f.lenses!.sort()).toEqual(["emotion", "transcription"]);
  expect(f.spans.map((s) => s.lens).sort()).toEqual(["emotion", "transcription"]);
  // clean lines are recorded as scanned too (the cache), under both runs' lenses
  expect(useStore.getState().aiFlags["P01:2"]).toMatchObject({ lenses: ["transcription", "emotion"], spans: [] });
});

test("dismissing a notice removes the span but keeps the line marked as scanned", () => {
  const st = useStore.getState();
  st.dismissNotice("P01", 1, "emotion", "losing");
  const f = useStore.getState().aiFlags["P01:1"];
  expect(f.spans.map((s) => s.lens)).toEqual(["transcription"]); // emotion span gone
  expect(f.lenses).toContain("emotion");                          // no re-fetch of the same mark
});

test("applyFix repairs the line and keeps the OTHER marks alive", () => {
  const st = useStore.getState();
  const lines = st.transcripts.P01.lines;
  st.addFlags("P01", { 1: [
    { quote: "ticket marks", reason: "misheard", lens: "transcription", fix: "tick marks" },
    { quote: "losing", reason: "frustration", lens: "emotion" },
  ] }, lines, ["transcription", "emotion"]);
  st.applyFix("P01", 1, "ticket marks", "tick marks");
  const l = useStore.getState().transcripts.P01.lines[0];
  expect(l.text).toBe("I kept losing the tick marks");
  expect(l.orig).toBe("I kept losing the ticket marks"); // same provenance as a manual edit
  const f = useStore.getState().aiFlags["P01:1"];
  // the applied span is gone, the emotion span survives, and the record is
  // re-hashed against the corrected text so it still counts as valid
  expect(f.spans.map((s) => s.lens)).toEqual(["emotion"]);
  expect(f.hash).toBe(hashLine(l.text));
});

test("applyFix is a no-op when the quote is not in the line (or the line doesn't exist)", () => {
  const st = useStore.getState();
  st.applyFix("P01", 2, "ticket marks", "tick marks"); // quote lives on line 1, not here
  st.applyFix("P01", 999, "zoomed", "zoomed out");     // no such line
  const l = useStore.getState().transcripts.P01.lines[1];
  expect(l.text).toBe("so I zoomed in further");
  expect(l.orig).toBeUndefined(); // no phantom edit recorded
});

test("applyFix replaces only the FIRST occurrence — the one the mark underlines", () => {
  const st = useStore.getState();
  st.editLine("P01", 2, "the zoom broke the zoom");
  st.applyFix("P01", 2, "zoom", "map");
  expect(useStore.getState().transcripts.P01.lines[1].text).toBe("the map broke the zoom");
});

test("applyFix with no flag record still repairs the line and doesn't resurrect one", () => {
  useStore.getState().clearFlags("P01");
  useStore.getState().applyFix("P01", 2, "zoom", "view");
  expect(useStore.getState().transcripts.P01.lines[1].text).toBe("the map broke the view");
  expect(useStore.getState().aiFlags["P01:2"]).toBeUndefined();
});

test("applyFix drops a span whose quote the repair broke (never orphaned)", () => {
  const st = useStore.getState();
  st.addFlags("P01", { 1: [
    { quote: "tick marks", reason: "misheard", lens: "transcription", fix: "text marks" },
    { quote: "the tick", reason: "frustration", lens: "emotion" }, // straddles the fixed region
  ] }, st.transcripts.P01.lines, ["transcription", "emotion"]);
  st.applyFix("P01", 1, "tick marks", "text marks");
  // the emotion quote can never render against the corrected text — it must be
  // dropped, not kept as an invisible span the line announcement still reads out
  expect(useStore.getState().aiFlags["P01:1"].spans).toEqual([]);
});
