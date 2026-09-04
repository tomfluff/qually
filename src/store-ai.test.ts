// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Store paths added for the AI features: the reserved-view predicate and the
// grounding-record pruning when a segment is deleted.
import { beforeAll, test, expect } from "vitest";
import { isTranscriptView } from "./state/store";

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

test("isTranscriptView: the two reserved views are not transcripts", () => {
  expect(isTranscriptView("browse")).toBe(false);
  expect(isTranscriptView("assist")).toBe(false);
  expect(isTranscriptView("P01")).toBe(true);
  expect(isTranscriptView("anything-else")).toBe(true);
});

test("deleteSegment prunes only that segment's grounding record", () => {
  const st = useStore.getState();
  st.addSegment("P01", 1, 1, "magnification", "(default)", "accepted");
  st.addSegment("P01", 2, 2, "frustration", "(default)", "accepted");
  const [a, b] = useStore.getState().segments.slice(-2);
  st.addGrounds({ [a.sid]: { hash: "h1", quotes: ["x"] }, [b.sid]: { hash: "h2", quotes: ["y"] } });
  expect(useStore.getState().aiGrounds[a.sid]).toBeDefined();

  st.deleteSegment(a.sid);
  expect(useStore.getState().aiGrounds[a.sid]).toBeUndefined();  // pruned
  expect(useStore.getState().aiGrounds[b.sid]).toBeDefined();    // sibling survives
});

// F9: "write in all" is one gesture, so one undo — and undo brings the marks back
test("applyFixes writes every substitution of one transcript as ONE undo entry", async () => {
  const { SUBST_LENS, hashLine } = await import("./ai/flag");
  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text
1,00:00:03,R,and the second one?
2,00:00:09,P,it was slower than the first one
3,00:00:14,P,but it had better labels
4,00:00:20,P,nothing to change here
`,
  ], "P09.csv")]);
  const st = useStore.getState();
  const lines = st.transcripts.P09.lines;
  st.addFlags("P09", {
    2: [{ quote: "it was", reason: "R asked", lens: SUBST_LENS, fix: "[Harbor] was" },
        { quote: "the first one", reason: "ordinal", lens: SUBST_LENS, fix: "[Beacon]" },
        { quote: "slower", reason: "evaluation", lens: "evaluation" }],
    3: [{ quote: "but it", reason: "", lens: SUBST_LENS, fix: "but [Harbor]" }],
  }, lines.filter((l) => l.speaker === "P"), [SUBST_LENS]);
  const before = useStore.getState().undoStack.length;
  expect(useStore.getState().applyFixes("P09", SUBST_LENS)).toBe(2);
  const after = useStore.getState().transcripts.P09.lines;
  expect(after[1].text).toBe("[Harbor] was slower than [Beacon]");
  expect(after[1].orig).toBe("it was slower than the first one");
  expect(after[2].text).toBe("but [Harbor] had better labels");
  expect(after[3].orig).toBeUndefined();
  expect(useStore.getState().undoStack.length).toBe(before + 1);
  // the applied marks are retired; the observation on the same line survives
  // at the new hash, so the researcher does not lose it to a rewrite
  const f2 = useStore.getState().aiFlags["P09:2"];
  expect(f2.hash).toBe(hashLine(after[1].text));
  expect(f2.spans).toEqual([{ quote: "slower", reason: "evaluation", lens: "evaluation" }]);
  expect(useStore.getState().aiFlags["P09:3"].spans).toEqual([]);
  useStore.getState().undo();
  const back = useStore.getState().transcripts.P09.lines;
  expect(back[1].text).toBe("it was slower than the first one");
  expect(back[2].text).toBe("but it had better labels");
  expect(useStore.getState().aiFlags["P09:2"].spans).toHaveLength(3);
  // nothing pending: a second call changes nothing and costs no history
  expect(useStore.getState().applyFixes("P09", SUBST_LENS)).toBe(2);
  expect(useStore.getState().applyFixes("P09", SUBST_LENS)).toBe(0);
});
