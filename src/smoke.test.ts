// Smoke test: drive the REAL store through import -> code -> export -> re-import,
// verifying the data pipeline that writes coded-segments.csv. Node env; a tiny
// localStorage shim lets zustand's persist middleware load.
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
});

const TRANSCRIPT = `line_id,timestamp,speaker,text,codes
1,00:00:03,R,So how do you read a chart,
2,00:00:09,P,I zoom in really close,magnification
3,00:00:15,P,and pan across to follow it,magnification
4,00:00:22,P,but then I lose the axis labels,lost context
5,00:00:29,R,that sounds exhausting,
`;

test("import transcript -> inline codes collapse into segments", async () => {
  const s = useStore.getState();
  await s.importFiles([new File([TRANSCRIPT], "P01.csv")]);
  const st = useStore.getState();
  expect(Object.keys(st.transcripts)).toContain("P01");
  expect(st.active).toBe("P01");
  const refs = st.segments.map((x) => `${x.pid}:${x.start}${x.end !== x.start ? "-" + x.end : ""}:${x.code}`).sort();
  // magnification collapses 2-3; lost context on 4
  expect(refs).toContain("P01:2-3:magnification");
  expect(refs).toContain("P01:4:lost context");
});

test("apply a code to a drag-style selection", () => {
  const s = useStore.getState();
  s.selectLine(2);
  s.selectLine(3, { extend: true });     // select 2-3
  s.applyCode("member check");
  const segs = useStore.getState().segments;
  expect(segs.some((x) => x.pid === "P01" && x.start === 2 && x.end === 3 && x.code === "member check")).toBe(true);
});

test("export produces a valid coded-segments.csv with computed excerpts", () => {
  const csv = useStore.getState().exportCSV();
  const rows = parseCSV(csv);
  expect(Object.keys(rows[0])).toEqual(["segment_ref", "pid", "excerpt", "code", "proposed_by", "status", "notes"]);
  const mag = rows.find((r) => r.segment_ref === "P01:2-3" && r.code === "magnification");
  expect(mag).toBeTruthy();
  // dominant-speaker excerpt = the P lines joined, no [R:] prefix
  expect(mag!.excerpt).toBe("I zoom in really close and pan across to follow it");
});

test("a wrong-format file rejects with a message naming it, instead of vanishing", async () => {
  const s = useStore.getState();
  const tabsBefore = s.tabs.length;
  await expect(s.importFiles([new File(["just some prose\nnot a csv at all"], "notes.txt")]))
    .rejects.toThrow(/notes\.txt doesn't match any QuAlly format/);
  await expect(s.importFiles([new File([""], "empty.csv")]))
    .rejects.toThrow(/empty\.csv is empty/);
  expect(useStore.getState().tabs.length).toBe(tabsBefore); // nothing imported
});

test("re-importing the exported CSV is idempotent (no dupes, identical re-export)", async () => {
  const csv1 = useStore.getState().exportCSV();
  const before = useStore.getState().segments.length;
  await useStore.getState().importFiles([new File([csv1], "coded-segments.csv")]);
  expect(useStore.getState().segments.length).toBe(before); // dedup held
  expect(useStore.getState().exportCSV()).toBe(csv1);        // round-trips exactly
});

test("selection is undoable, and a whole drag is ONE step", () => {
  const s = useStore.getState();
  s.clearSelection();

  s.pushSelUndo("mouse"); s.selectLine(2); s.endSelGesture();      // click line 2
  expect([...useStore.getState().selection.lines]).toEqual([2]);

  // a drag: one gesture, many selectLine calls (the fixture is 5 lines long)
  s.pushSelUndo("mouse");
  useStore.getState().selectLine(3);
  useStore.getState().selectLine(4, { extend: true });
  useStore.getState().selectLine(5, { extend: true });
  useStore.getState().endSelGesture();
  expect([...useStore.getState().selection.lines].sort()).toEqual([3, 4, 5]);

  useStore.getState().undo();                                     // ONE undo, not three
  expect([...useStore.getState().selection.lines]).toEqual([2]);  // back to the click
  useStore.getState().redo();
  expect([...useStore.getState().selection.lines].sort()).toEqual([3, 4, 5]);
});

test("undoing a code also puts back the lines it was applied to", () => {
  const s = useStore.getState();
  s.pushSelUndo("mouse"); s.selectLine(2); s.selectLine(3, { extend: true }); s.endSelGesture();
  const before = useStore.getState().segments.length;

  useStore.getState().applyCode("undo probe");
  expect(useStore.getState().segments.length).toBe(before + 1);

  useStore.getState().undo();
  expect(useStore.getState().segments.length).toBe(before);
  // the selection that the code was applied to comes back with it
  expect([...useStore.getState().selection.lines].sort()).toEqual([2, 3]);
});
