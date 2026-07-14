// Transcription repair: editLine provenance (orig kept, revert clears it),
// segments untouched, corrected text flowing into both exports.
import { beforeAll, test, expect } from "vitest";
import { parseCSV } from "./contract/csv";

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
