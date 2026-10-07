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

test("applyFixes resolves every quote before a substitution writes the same letters", async () => {
  const { SUBST_LENS, hashLine } = await import("./ai/flag");
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text\n1,00:00:03,P,the first one beat it easily\n",
  ], "BATCH.csv")]);
  const lines = useStore.getState().transcripts.BATCH.lines;
  useStore.getState().addFlags("BATCH", {
    1: [{ quote: "the first one", reason: "ordinal", lens: SUBST_LENS, fix: "[Digital map]" },
        { quote: "it", reason: "reference", lens: SUBST_LENS, fix: "[Paper]" }],
  }, lines, [SUBST_LENS]);

  expect(useStore.getState().applyFixes("BATCH", SUBST_LENS)).toBe(1);
  const line = useStore.getState().transcripts.BATCH.lines[0];
  expect(line.text).toBe("[Digital map] beat [Paper] easily");
  expect(line.orig).toBe("the first one beat it easily");
  expect(useStore.getState().aiFlags["BATCH:1"]).toMatchObject({ hash: hashLine(line.text), spans: [] });
});

test("applyFix drops a remaining quote whose first occurrence moved into the substitution", async () => {
  const { SUBST_LENS, hashLine } = await import("./ai/flag");
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text\n1,00:00:03,P,the first one beat it easily\n",
  ], "SINGLE.csv")]);
  const lines = useStore.getState().transcripts.SINGLE.lines;
  useStore.getState().addFlags("SINGLE", {
    1: [{ quote: "the first one", reason: "ordinal", lens: SUBST_LENS, fix: "[Digital map]" },
        { quote: "it", reason: "reference", lens: SUBST_LENS, fix: "[Paper]" }],
  }, lines, [SUBST_LENS]);

  expect(useStore.getState().applyFix("SINGLE", 1, "the first one", "[Digital map]")).toBe(true);
  const line = useStore.getState().transcripts.SINGLE.lines[0];
  expect(line.text).toBe("[Digital map] beat it easily");
  expect(useStore.getState().aiFlags["SINGLE:1"]).toMatchObject({ hash: hashLine(line.text), spans: [] });
});

test("applySpanFixes writes literal fixes in position order, skips overlaps and preserves shifted observations", async () => {
  const { applySpanFixes, SUBST_LENS } = await import("./ai/flag");
  const observation = { quote: "slower", reason: "evaluation", lens: "evaluation" };
  const result = applySpanFixes("alpha beta slower omega", [
    { quote: "beta slower", reason: "", lens: SUBST_LENS, fix: "overlap" },
    { quote: "alpha beta", reason: "", lens: SUBST_LENS, fix: "$&" },
    observation,
    { quote: "omega", reason: "", lens: SUBST_LENS, fix: "[$']" },
  ], (sp) => !!sp.fix);
  expect(result).toEqual({ text: "$& slower [$']", spans: [observation], written: 2 });
});

// A substitution widened to be unique keeps the participant's other words, so
// an observation on those words is still on them afterwards — it must survive
// the write, as it did before positions were fixed. One on words the write
// changed, or one that would now resolve inside the [term], must not.
test("applySpanFixes keeps a mark whose words the replacement carries through, and only those", async () => {
  const { applySpanFixes, SUBST_LENS } = await import("./ai/flag");
  const slower = { quote: "slower", reason: "evaluation", lens: "evaluation" };
  const first = { quote: "first", reason: "ordinal", lens: "evaluation" };
  const harbor = { quote: "Harb", reason: "", lens: "evaluation" };
  const result = applySpanFixes("the first one was slower than Harbor", [
    { quote: "the first one was slower", reason: "", lens: SUBST_LENS, fix: "[Harbor] was slower" },
    slower, first, harbor,
  ], (sp) => sp.lens === SUBST_LENS);
  expect(result.text).toBe("[Harbor] was slower than Harbor");
  expect(result.spans).toEqual([slower]);
});

// Carried means the SAME characters, not the same string somewhere in the fix:
// "it was it" → "[Paper] was it" keeps the second "it", and a mark on the first
// must not slide onto it.
test("applySpanFixes never moves a mark onto another instance of its words", async () => {
  const { applySpanFixes, SUBST_LENS } = await import("./ai/flag");
  const first = { quote: "it", reason: "the first it", lens: "evaluation" };
  const result = applySpanFixes("it was it", [
    { quote: "it was it", reason: "", lens: SUBST_LENS, fix: "[Paper] was it" }, first,
  ], (sp) => sp.lens === SUBST_LENS);
  expect(result.text).toBe("[Paper] was it");
  expect(result.spans).toEqual([]);
});

// "All except these": the rest is written as one gesture, and exactly the
// flagged substitutions stay pending, on their lines, for review one by one.
test("applyFixes with a skip writes the rest and leaves exactly the skipped marks pending", async () => {
  const { SUBST_LENS, hashLine } = await import("./ai/flag");
  const { suspicious } = await import("./ai/contextualize");
  await useStore.getState().importFiles([new File([
    "line_id,timestamp,speaker,text\n" +
    "1,00:00:01,P,the one with the map was fine\n" +
    "2,00:00:05,P,it froze\n" +
    "3,00:00:09,P,this crashed and it was not usable\n",
  ], "EXCEPT.csv")]);
  const lines = useStore.getState().transcripts.EXCEPT.lines;
  const longRef = { quote: "the one with the map", reason: "", lens: SUBST_LENS, fix: "[Beacon]" };
  const pronoun = { quote: "it", reason: "", lens: SUBST_LENS, fix: "[Harbor]" };
  const shortRef = { quote: "this", reason: "", lens: SUBST_LENS, fix: "[Harbor]" };
  const judgment = { quote: "it was not usable", reason: "", lens: SUBST_LENS, fix: "[Beacon]" };
  useStore.getState().addFlags("EXCEPT", { 1: [longRef], 2: [pronoun], 3: [shortRef, judgment] }, lines, [SUBST_LENS]);
  const before = useStore.getState().undoStack.length;

  expect(useStore.getState().applyFixes("EXCEPT", SUBST_LENS, "source", suspicious)).toBe(2);
  const after = useStore.getState().transcripts.EXCEPT.lines.map((l) => l.text);
  expect(after).toEqual(["the one with the map was fine", "[Harbor] froze", "[Harbor] crashed and it was not usable"]);
  expect(useStore.getState().undoStack.length).toBe(before + 1);
  // every pending substitution left is one the skip picked, still on its line
  const pending = useStore.getState().transcripts.EXCEPT.lines.flatMap((l) => {
    const f = useStore.getState().aiFlags[`EXCEPT:${l.id}`];
    return f && f.hash === hashLine(l.text) ? f.spans.filter((s) => s.lens === SUBST_LENS && s.fix) : [];
  });
  expect(pending).toEqual([longRef, judgment]);
});
