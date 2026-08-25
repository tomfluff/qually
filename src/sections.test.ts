// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F7 wave 0: the study brief's closed vocabulary, and the status discipline
// that keeps an unreviewed proposal out of every count.
import { beforeAll, test, expect } from "vitest";
import { parseBrief, briefProse, sanitizeSections, canonKey, vocabSays } from "./sections";
import { coverageOf, stretchesAt, pendingAt, evidence, visible, type Stretch } from "./stretches";

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
1,00:00:05,R,shall we start with the warm-up,
2,00:00:20,P,sure — this first one feels quicker,pace
3,00:05:00,R,now the second task,
4,00:05:40,P,this one lost my place,pace
`,
  ], "P09.csv")]);
});

// ── the brief ──────────────────────────────────────────────────────────────

test("a bulleted axis is a declaration; a sentence with a colon is not", () => {
  const v = parseBrief([
    "A within-subject study, two systems, counterbalanced.",
    "- phase: warm-up, task 1, task 2, debrief",
    "* condition: baseline, beacon",
    "Note: participants were tired, confused, and often quiet.",
  ].join("\n"));
  expect(v.axes.map((a) => a.dim)).toEqual(["phase", "condition"]);
  expect(v.axes[0].values).toEqual(["warm-up", "task 1", "task 2", "debrief"]);
  expect(v.axes[1].values).toEqual(["baseline", "beacon"]);
  // the prose line would have widened the guard with a bogus "Note" axis
  expect([...v.canon.keys()].some((k) => k.startsWith("note"))).toBe(false);
});

test("a repeated axis merges, duplicates collapse, empty items drop", () => {
  const v = parseBrief("- phase: warm-up, task 1\n- phase: task 1, , debrief");
  expect(v.axes).toHaveLength(1);
  expect(v.axes[0].values).toEqual(["warm-up", "task 1", "debrief"]);
});

test("a brief that declares nothing yields no vocabulary — the run has no guard", () => {
  expect(parseBrief("just some prose about the study").axes).toEqual([]);
  expect(parseBrief("").axes).toEqual([]);
});

test("the project's own spelling wins over the declared one", () => {
  const hand = [{ dim: "Phase", value: "Warm-Up" }];
  const v = parseBrief("- phase: warm-up, task 1", hand);
  // otherwise the gutter forks into two identically-coloured columns that mean
  // the same thing — every store comparison on dim/value is case-SENSITIVE
  expect(v.axes[0].dim).toBe("Phase");
  expect(v.axes[0].values).toEqual(["Warm-Up", "task 1"]);
});

test("labels match case-folded and NFC-normalised, however they were typed", () => {
  expect(canonKey("  Task   1 ")).toBe("task 1");
  expect(canonKey("café")).toBe(canonKey("café")); // é the two ways
  const v = parseBrief("- phase: Task 1");
  expect(v.canon.get("phase\u0000task 1")).toEqual({ dim: "phase", value: "Task 1" });
});

test("the prose half is what is left when the declarations are taken out", () => {
  const brief = "Two systems.\n- phase: warm-up, task 1\nIgnore the setup chatter.";
  expect(briefProse(brief)).toBe("Two systems.\nIgnore the setup chatter.");
  expect(vocabSays(parseBrief(brief))).toBe("phase → warm-up / task 1");
});

// ── the trust boundary ─────────────────────────────────────────────────────

const VOCAB = parseBrief("- phase: warm-up, task 1\n- condition: baseline");
const IDS = [1, 2, 3, 4];

test("an undeclared label is dropped, not negotiated", () => {
  const out = sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "the second task begins" },
    { dim: "phase", value: "debrief", line_start: 1, line_end: 2, why: "invented" },
    { dim: "mood", value: "tense", line_start: 1, line_end: 2, why: "invented axis" },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ dim: "phase", value: "task 1", start: 3, end: 4 });
});

test("a declared label is stored in the declared spelling, whatever the model typed", () => {
  const out = sanitizeSections(VOCAB, IDS, [
    { dim: "PHASE", value: "  Warm-Up ", line_start: 1, line_end: 2, why: "greetings" },
  ]);
  expect(out[0]).toMatchObject({ dim: "phase", value: "warm-up" });
});

test("endpoints must be real lines of this transcript; ranges normalise; dupes drop", () => {
  const out = sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 4, line_end: 3, why: "backwards" },
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "the same span again" },
    { dim: "phase", value: "task 1", line_start: 3, line_end: 99, why: "off the end" },
    { dim: "phase", value: "task 1", line_start: 1.5, line_end: 2, why: "not an integer" },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ start: 3, end: 4 });
});

test("rejection memory is EXACT — a boundary one line off may be proposed again", () => {
  const rejected: Stretch[] = [
    { pid: "P09", start: 3, end: 4, dim: "phase", value: "task 1", status: "rejected" },
  ];
  const same = sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "" }], rejected, "P09");
  expect(same).toHaveLength(0);
  // a section spans hundreds of lines: suppressing every OVERLAP (F3's rule for
  // excerpts) would forbid this label anywhere near here, forever
  const moved = sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 2, line_end: 4, why: "" }], rejected, "P09");
  expect(moved).toHaveLength(1);
});

// ── the status discipline ──────────────────────────────────────────────────

const seg = (start: number, end: number) =>
  ({ pid: "P09", start, end, code: "pace", status: "accepted" });
const cand: Stretch = { pid: "P09", start: 1, end: 4, dim: "phase", value: "task 1", status: "candidate" };
const mine: Stretch = { pid: "P09", start: 1, end: 2, dim: "phase", value: "warm-up" };
const nope: Stretch = { pid: "P09", start: 3, end: 4, dim: "phase", value: "debrief", status: "rejected" };

test("a candidate never reaches a count — it would reclassify the researcher's coding", () => {
  const cov = coverageOf([seg(3, 4)], [mine, cand, nope], "phase");
  // the segment falls outside the researcher's own warm-up stretch, and the
  // only things covering it are a proposal and a refusal: it is unmarked
  expect(cov.get("pace")).toEqual(new Map([["", 1]]));
});

test("an ACCEPTED proposal counts exactly like a hand mark", () => {
  const cov = coverageOf([seg(3, 4)], [{ ...cand, status: "accepted" }], "phase");
  expect(cov.get("pace")).toEqual(new Map([["task 1", 1]]));
});

test("evidence, visible and pending each answer a different question", () => {
  const all = [mine, cand, nope];
  expect(evidence(all)).toEqual([mine]);
  expect(visible(all)).toEqual([mine, cand]);       // drawn: rejected is not
  expect(stretchesAt(all, "P09", 3, 4)).toEqual([]); // what these lines belong to
  expect(pendingAt(all, "P09", 3, 4)).toEqual([cand]); // what is proposed for them
});

// ── the store ──────────────────────────────────────────────────────────────

test("a whole run lands as ONE undo entry, and one Ctrl+Z takes it back", () => {
  const st = useStore.getState();
  const depth = st.undoStack.length;
  const n = st.landSections("P09", [
    { dim: "phase", value: "warm-up", start: 1, end: 2, why: "greetings" },
    { dim: "phase", value: "task 1", start: 3, end: 4, why: "the second task" },
  ], "AI · Terra");
  expect(n).toBe(2);
  expect(useStore.getState().undoStack.length).toBe(depth + 1); // not depth + 2
  expect(useStore.getState().stretches).toHaveLength(2);
  expect(useStore.getState().stretches[0]).toMatchObject({
    status: "candidate", proposedBy: "AI · Terra", why: "greetings" });
  useStore.getState().undo();
  expect(useStore.getState().stretches).toHaveLength(0);
  useStore.getState().redo();
  expect(useStore.getState().stretches).toHaveLength(2);
});

test("accepting the run is one gesture too, and the reason survives the verdict", () => {
  const n = useStore.getState().acceptSections("P09");
  expect(n).toBe(2);
  const after = useStore.getState().stretches;
  expect(after.every((x) => x.status === "accepted")).toBe(true);
  expect(after[0].why).toBe("greetings"); // kept: the methods appendix needs it
  useStore.getState().undo();
  expect(useStore.getState().stretches.every((x) => x.status === "candidate")).toBe(true);
});

test("discarding forgets; rejecting remembers", () => {
  useStore.getState().setStretchStatus(0, "rejected");
  expect(useStore.getState().deleteStretchesBy({ pid: "P09", status: "candidate" })).toBe(1);
  const left = useStore.getState().stretches;
  expect(left).toHaveLength(1);
  expect(left[0].status).toBe("rejected"); // the memory a re-run consults
});

test("the brief remembers per project and per transcript, and an override is REMOVED", () => {
  const st = useStore.getState();
  st.setStudyBrief("", "- phase: warm-up, task 1");
  st.setStudyBrief("P09", "- phase: intro only");
  const brief = (pid: string) => {
    const b = useStore.getState().studyBrief;
    return b[pid] ?? b[""];
  };
  expect(brief("P09")).toBe("- phase: intro only");
  useStore.getState().clearStudyBrief("P09");
  expect(brief("P09")).toBe("- phase: warm-up, task 1");
  // "" is a real override, not an absence — it must not fall back
  useStore.getState().setStudyBrief("P09", "");
  expect(brief("P09")).toBe("");
});
