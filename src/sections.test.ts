// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F7 wave 0: the study brief's closed vocabulary, and the status discipline
// that keeps an unreviewed proposal out of every count.
import { beforeAll, test, expect } from "vitest";
import { parseBrief, briefProse, sanitizeSections, canonKey, vocabSays, SECTIONS_MAX } from "./sections";
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

test("a control character cannot smuggle an undeclared pair past the guard", () => {
  // "a" + "b\u0000c" declared, "a\u0000b" + "c" replied: joined with a bare NUL
  // both build the same key, and the undeclared pair would be handed back the
  // declared pair's spelling. canonKey strips the controls, so neither exists.
  const v = parseBrief("- a: b\u0000c");
  expect(v.axes[0].values).toEqual(["bc"]); // stored clean, too
  const out = sanitizeSections(v, IDS, [
    { dim: "a\u0000b", value: "c", line_start: 1, line_end: 2, why: "" }]);
  expect(out).toHaveLength(0);
});

test("an unrecognised status in a file reads as a CANDIDATE, never as a hand mark", async () => {
  const { parseProject } = await import("./project");
  const p = parseProject(JSON.stringify({
    format: "qually-project", version: 1,
    transcripts: { P09: { lines: [{ id: 1, ts: "", speaker: "P", text: "x" }] } },
    segments: [], codebook: {},
    stretches: [
      { pid: "P09", start: 1, end: 1, dim: "phase", value: "task 1", status: "candidte" },
      { pid: "P09", start: 1, end: 1, dim: "phase", value: "warm-up" },
    ],
  }));
  // deleting the bad status would launder an unjudged proposal into evidence
  expect(p!.stretches![0].status).toBe("candidate");
  expect(p!.stretches![1].status).toBeUndefined(); // a real hand mark stays one
});

test("a file carrying a proposal is stamped for what an older build would misread", async () => {
  const { parseProject, VERSION } = await import("./project");
  const plain = parseProject(useStore.getState().exportProject());
  expect(plain!.version).toBe(1); // nothing here an older build gets wrong
  useStore.getState().landSections("P09", sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "the second task" },
  ]), "AI · Terra");
  const withCand = parseProject(useStore.getState().exportProject());
  // a v1 build has no notion of status: it would spread the field through and
  // count an unjudged candidate as a section the researcher drew, so it must
  // refuse the file instead
  expect(withCand!.version).toBe(VERSION);
  expect(VERSION).toBeGreaterThan(1);
  useStore.getState().undo(); // leave the store as the later tests expect it
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
  // built through the sanitizer, because that is the ONLY way to build one:
  // SectionProposal is branded, so landSections cannot be handed a raw reply
  const n = st.landSections("P09", sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "warm-up", line_start: 1, line_end: 2, why: "greetings" },
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "the second task" },
  ]), "AI · Terra");
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

test("a dim's spelling never captures a same-named value, nor the reverse", () => {
  // one shared spelling map let the dim "task" claim the value "Task" of some
  // other axis, storing a spelling that forks the existing value's column
  const existing = [{ dim: "task", value: "hard" }, { dim: "phase", value: "Task" }];
  const v = parseBrief("- phase: task", existing);
  expect(v.axes[0].values).toEqual(["Task"]); // the VALUE's spelling, not the dim's
});

test("a per-transcript brief override follows a rename and dies with a delete", () => {
  const st = useStore.getState();
  expect(st.studyBrief["P09"]).toBe(""); // the deliberate empty override from above
  st.renameTranscript("P09", "P10");
  expect(useStore.getState().studyBrief["P10"]).toBe("");
  expect("P09" in useStore.getState().studyBrief).toBe(false);
  useStore.getState().deleteTranscript("P10");
  // left behind, a later transcript imported under this name would silently
  // inherit a brief written for the deleted one
  expect("P10" in useStore.getState().studyBrief).toBe(false);
});

// ── the payload (no network) ───────────────────────────────────────────────

test("labels go PLAIN, the brief's prose is redacted, and both are sent with the lines", async () => {
  const { renderSections, estimateSectionsTokens } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const red = redactor(["Ann Lee"]);
  const lines = [
    { id: 1, ts: "00:00:05", speaker: "R", text: "Ann Lee, shall we start" },
    { id: 2, ts: "00:00:20", speaker: "P", text: "sure" },
  ];
  const brief = "Ann Lee ran the session.\n- phase: warm-up, task 1";
  const v = parseBrief(brief);
  const out = renderSections(lines, v, brief, red);
  // a redacted label would come back as [REDACTED_n] and match nothing — the
  // same split F3 makes between code names and definitions
  expect(out).toContain("- phase: warm-up, task 1");
  // the prose is about the study, and study prose names people
  expect(out).toContain("BRIEF");
  expect(out).toContain("[REDACTED_1] ran the session.");
  expect(out).toContain("1\tR\t[REDACTED_1], shall we start");
  expect(out).not.toContain("Ann Lee");
  expect(estimateSectionsTokens(lines, v, brief, red)).toBeGreaterThan(0);
});

test("a brief that is only declarations sends no BRIEF block at all", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const brief = "- phase: warm-up";
  const out = renderSections([{ id: 1, ts: "", speaker: "P", text: "hi" }],
    parseBrief(brief), brief, redactor([]));
  expect(out).not.toContain("BRIEF");
  expect(out).toContain("LABELS");
});

test("a CJK transcript is not under-estimated into a request the API would refuse", async () => {
  const { estimateTokens } = await import("./ai/openai");
  // chars/4 alone would call this 5 tokens; it is nearer 20, and an
  // under-estimate is what slips an oversized request past the gate
  const jp = "これはとても長い日本語の文章です、テストのために書きました";
  expect(estimateTokens(jp)).toBeGreaterThanOrEqual(jp.length - 2);
  // Latin text is unchanged — the old ratio still holds where it was right
  expect(estimateTokens("abcdefgh")).toBe(2);
});

// ── the export ─────────────────────────────────────────────────────────────

test("sections.csv carries the provenance, and a blank status means you drew it", () => {
  const st = useStore.getState();
  st.markStretch({ pid: "P09", start: 1, end: 2, dim: "phase", value: "warm-up" });
  st.landSections("P09", sanitizeSections(VOCAB, IDS, [
    { dim: "phase", value: "task 1", line_start: 3, line_end: 4, why: "the second task begins" },
  ]), "AI · Terra");
  const csv = useStore.getState().exportSections();
  const [head, ...rows] = csv.trim().split(/\r?\n/); // toCSV writes CRLF
  expect(head).toBe("pid,line_start,line_end,dim,value,status,proposed_by,why");
  // the researcher's own mark: both provenance columns blank, and they mean
  // the same thing — nobody proposed it
  expect(rows[0]).toBe("P09,1,2,phase,warm-up,,,");
  expect(rows[1]).toContain("P09,3,4,phase,task 1,candidate,AI · Terra,");
  expect(rows[1]).toContain("the second task begins");
});

test("a rejected section still exports — it is the memory a re-run consults", () => {
  const i = useStore.getState().stretches.findIndex((x) => x.status === "candidate");
  useStore.getState().setStretchStatus(i, "rejected");
  expect(useStore.getState().exportSections()).toContain("rejected");
});

test("a project holding only a study brief is still stamped for the build that understands it", () => {
  const st = useStore.getState();
  st.deleteStretchesBy({ status: "candidate" });
  st.deleteStretchesBy({ status: "rejected" });
  // no AI-proposed stretch left anywhere — only the brief, which a v1 build
  // does not carry at all and would drop on its next save
  expect(useStore.getState().stretches.some((x) => x.status)).toBe(false);
  expect(Object.values(useStore.getState().studyBrief).some((t) => t.trim())).toBe(true);
  const p = JSON.parse(useStore.getState().exportProject());
  expect(p.version).toBe(2);
  expect(p.studyBrief[""]).toContain("phase");
});

test("session events ride with the transcript, anchored to the line they followed", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const red = redactor(["Ann Lee"]);
  const lines = [
    { id: 1, ts: "00:00:00", speaker: "R", text: "hello" },
    { id: 2, ts: "00:05:00", speaker: "P", text: "mid" },
    { id: 3, ts: "00:09:00", speaker: "P", text: "later" },
  ];
  const brief = "- phase: task 1";
  const mk = (mid: number, t: number, code: string, label: string) =>
    ({ mid, pid: "P09", event: "marker", code, label, t, detail: "", raw: {} });
  const out = renderSections(lines, parseBrief(brief), brief, red, [
    mk(1, 320, "TASK_START", "Ann Lee starts task 1"),  // 5:20 → after line 2
    mk(2, 10, "recording_start", ""),                   // 0:10 → after line 1
  ], 0);
  // sorted by time, each placed on the last line that had started
  const events = out.split("EVENTS")[1].split("TRANSCRIPT")[0];
  expect(events).toContain("after line 1\trecording_start");
  expect(events).toContain("after line 2\tTASK_START — [REDACTED_1] starts task 1");
  expect(events).not.toContain("Ann Lee"); // the researcher's note is prose, and prose names people
});

test("no events, no EVENTS block — the payload says only what there is", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const brief = "- phase: task 1";
  const out = renderSections([{ id: 1, ts: "", speaker: "P", text: "x" }],
    parseBrief(brief), brief, redactor([]), []);
  expect(out).not.toContain("EVENTS");
});

test("a run that was dispatched and abandoned is in the log, and says which", () => {
  const st = useStore.getState();
  const before = st.aiLog.length;
  st.logAiIncomplete(Object.assign(new Error("x"), { name: "AbortError" }),
    { model: "gpt-5.6-luna", task: "sections", pid: "P09", lines: 4, redactions: 0 });
  st.logAiIncomplete(new Error("500"),
    { model: "gpt-5.6-luna", task: "scan", pid: "P09", lines: 4, redactions: 0 });
  const log = useStore.getState().aiLog.slice(before);
  expect(log.map((c) => c.outcome)).toEqual(["aborted", "failed"]);
  // the API reported no usage; the lines left anyway, which is the point
  expect(log.every((c) => c.inTok === 0 && c.costUsd === 0 && c.lines === 4)).toBe(true);
  expect(useStore.getState().exportAiLog()).toContain("aborted");
});

test("an event is placed on the transcript's clock, not the video's", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const lines = [
    { id: 1, ts: "00:00:00", speaker: "R", text: "one" },
    { id: 2, ts: "00:05:00", speaker: "P", text: "two" },
    { id: 3, ts: "00:09:00", speaker: "P", text: "three" },
  ];
  const brief = "- phase: task 1";
  const ev = [{ mid: 1, pid: "P09", event: "marker", code: "TASK", label: "", t: 620, detail: "", raw: {} }];
  const sec = (offset: number) =>
    renderSections(lines, parseBrief(brief), brief, redactor([]), ev, offset)
      .split("EVENTS")[1].split("TRANSCRIPT")[0];
  // 10:20 on the video clock lands after the last line
  expect(sec(0)).toContain("after line 3");
  // ...but if the media starts 6 minutes before the transcript does, the same
  // event happened at 4:20 — line 1's stretch, not line 3's
  expect(sec(360)).toContain("after line 1");
});

test("an event before the first timed line keeps its own clock", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const brief = "- phase: task 1";
  const out = renderSections([{ id: 1, ts: "00:05:00", speaker: "P", text: "x" }],
    parseBrief(brief), brief, redactor([]),
    [{ mid: 1, pid: "P09", event: "recording_start", code: "", label: "", t: 12, detail: "", raw: {} }], 0);
  // unplaceable on a line, but "it happened at 12 seconds" is worth more than
  // dropping the event entirely
  expect(out).toContain("at 00:00:12\trecording_start");
});

test("a transcript whose timestamps do not ascend still finds the right line", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const brief = "- phase: task 1";
  // line 2's time is out of order (a hand-mangled CSV); line 3 must still be
  // reachable — an early break would have stopped the scan at line 2
  const lines = [
    { id: 1, ts: "00:00:00", speaker: "R", text: "a" },
    { id: 2, ts: "00:20:00", speaker: "P", text: "b" },
    { id: 3, ts: "00:05:00", speaker: "P", text: "c" },
  ];
  const out = renderSections(lines, parseBrief(brief), brief, redactor([]),
    [{ mid: 1, pid: "P09", event: "marker", code: "TASK", label: "", t: 400, detail: "", raw: {} }], 0);
  expect(out).toContain("after line 3"); // 6:40 → the latest line at or before it
});

test("the gate's sample anchors events against the WHOLE transcript", async () => {
  const { renderSections } = await import("./ai/sections");
  const { redactor } = await import("./ai/redact");
  const brief = "- phase: task 1";
  const lines = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, ts: `00:${String(i).padStart(2, "0")}:00`, speaker: "P", text: `line ${i + 1}`,
  }));
  const ev = [
    { mid: 1, pid: "P09", event: "recording_start", code: "", label: "", t: 30, detail: "", raw: {} },
    { mid: 2, pid: "P09", event: "marker", code: "PROGRESS", label: "", t: 20 * 60, detail: "", raw: {} },
    { mid: 3, pid: "P09", event: "marker", code: "OBSERVATION", label: "", t: 50 * 60, detail: "", raw: {} },
  ];
  // `show` truncates only what is DISPLAYED; the anchors are the ones the real
  // request sends. Slicing the lines before rendering — what the gate used to
  // do — collapsed every later event onto the last line of the sample.
  const out = renderSections(lines, parseBrief(brief), brief, redactor([]), ev, 0, 6);
  const events = out.split("EVENTS")[1].split("TRANSCRIPT")[0];
  expect(events).toContain("after line 1\trecording_start");
  expect(events).toContain("after line 21\tPROGRESS");
  expect(events).toContain("after line 51\tOBSERVATION");
  // and the transcript body really is only the sample
  expect(out).toContain("6\tP\tline 6");
  expect(out).not.toContain("7\tP\tline 7");
});

test("the reply's ceiling is enforced here, not only in the schema", async () => {
  const brief = "- phase: task 1";
  const v = parseBrief(brief);
  const ids = Array.from({ length: 400 }, (_, i) => i + 1);
  // a reply that ignores maxItems entirely: the schema is enforced by the other
  // end of the wire, which is exactly what this function does not trust
  const reply = Array.from({ length: 300 }, (_, i) => ({
    dim: "phase", value: "task 1", line_start: i + 1, line_end: i + 1, why: "x".repeat(5000),
  }));
  const out = sanitizeSections(v, ids, reply);
  expect(out).toHaveLength(SECTIONS_MAX);
  // and a reason is one sentence, not an essay that rides into every save
  expect(out[0].why.length).toBeLessThanOrEqual(600);
});
