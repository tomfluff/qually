// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Ask: the corpus is the researcher's own analysis, and a citation is only real
// if the corpus carried that exact ref. Everything else about the feature is
// plumbing; these two are the claims it rests on.
import { beforeAll, beforeEach, test, expect } from "vitest";
import { buildCorpus, emptyCorpus, refTarget } from "./askCorpus";
import { sanitizeAskReply, renderAskPayload } from "./ai/ask";
import { redactor } from "./ai/redact";

let useStore: typeof import("./state/store").useStore;

const L = (id: number, ts: string, speaker: string, text: string) => ({ id, ts, speaker, text });

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; }, key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));
});

beforeEach(() => {
  useStore.setState({
    transcripts: {
      P01: { lines: [L(1, "00:00:03", "R", "how do you read it"), L(2, "00:00:09", "P", "I zoom right in"), L(3, "00:00:15", "P", "then I lose the labels")] },
      P02: { lines: [L(1, "00:00:04", "P", "procurement never asked us")] },
    },
    segments: [
      { sid: 1, pid: "P01", start: 2, end: 3, code: "magnification", proposedBy: "me", status: "accepted", notes: "" },
      { sid: 2, pid: "P02", start: 1, end: 1, code: "procurement", proposedBy: "me", status: "accepted", notes: "" },
      { sid: 3, pid: "P01", start: 1, end: 1, code: "magnification", proposedBy: "me", status: "candidate", notes: "" },
    ],
    codebook: {
      magnification: { color: "#4477aa", def: "Marks enlarging the view.", status: "accepted" },
      procurement: { color: "#ee6677", def: "", status: "accepted" },
    },
    markers: [{ mid: 1, pid: "P01", t: 12, event: "marker", code: "custom", label: "leans in close", detail: "", raw: {} }],
    video: {}, answers: [], nextAid: 1,
  } as never);
});

const all = { pids: ["P01", "P02"], codes: ["magnification", "procurement"], events: true, excerpts: true };

test("the corpus is the coding, not the transcript — and only ACCEPTED coding", () => {
  const c = buildCorpus(useStore.getState(), all);
  expect(c.excerpts.map((x) => x.ref)).toEqual(["P01:2-3", "P02:1"]);
  // the candidate segment is not the researcher's analysis yet
  expect(c.excerpts.some((x) => x.ref === "P01:1")).toBe(false);
  // the interviewer's line never became an excerpt of its own
  expect(c.excerpts[0].text).toBe("I zoom right in then I lose the labels");
  expect(c.events.map((x) => x.ref)).toEqual(["P01@00:00:12"]);
  expect(c.codes.map((x) => x.name)).toEqual(["magnification", "procurement"]);
});

test("scope narrows the corpus, and every ref stays resolvable", () => {
  const c = buildCorpus(useStore.getState(), { pids: ["P01"], codes: ["magnification"], events: false, excerpts: true });
  expect(c.excerpts.map((x) => x.ref)).toEqual(["P01:2-3"]);
  expect(c.events).toEqual([]);
  expect(c.where.get("P01:2-3")).toEqual({ pid: "P01", line: 2 });
});

test("turning excerpts off leaves the events, and the codebook with them", () => {
  const c = buildCorpus(useStore.getState(), { ...all, excerpts: false });
  expect(c.excerpts).toEqual([]);
  expect(c.codes).toEqual([]);
  expect(c.events.length).toBe(1);
});

test("an invented ref is dropped, and the point it carried is not shown as an answer", () => {
  const c = buildCorpus(useStore.getState(), all);
  const out = sanitizeAskReply({
    points: [
      { text: "Zooming loses the labels.", refs: ["P01:2-3", "P09:1-2"] }, // one real, one invented
      { text: "Everyone found it exhausting.", refs: ["P44:1"] },          // wholly invented
      { text: "", refs: ["P01:2-3"] },                                     // empty claim
    ],
    unsupported: ["nothing here speaks to cost"],
  }, c);
  expect(out.points).toEqual([{ text: "Zooming loses the labels.", refs: ["P01:2-3"] }]);
  // a claim with no surviving evidence is surfaced, never quietly deleted
  expect(out.unsupported).toEqual(["Everyone found it exhausting.", "nothing here speaks to cost"]);
});

test("duplicate refs on one point collapse", () => {
  const c = buildCorpus(useStore.getState(), all);
  const out = sanitizeAskReply({ points: [{ text: "x", refs: ["P01:2-3", "P01:2-3"] }], unsupported: [] }, c);
  expect(out.points[0].refs).toEqual(["P01:2-3"]);
});

test("an empty corpus can support no citation at all", () => {
  const out = sanitizeAskReply({ points: [{ text: "x", refs: ["P01:2-3"] }], unsupported: [] }, emptyCorpus());
  expect(out.points).toEqual([]);
  expect(out.unsupported).toEqual(["x"]);
});

test("the payload redacts excerpts, notes and the question — and restores on the way back", () => {
  const r = redactor(["Ann"]);
  useStore.setState({
    markers: [{ mid: 1, pid: "P01", t: 12, event: "marker", code: "custom", label: "Ann leans in", detail: "", raw: {} }],
  } as never);
  const c = buildCorpus(useStore.getState(), all);
  const payload = renderAskPayload("what did Ann do?", c, r);
  expect(payload).not.toContain("Ann");
  expect(payload).toContain("[P01:2-3]");
  // a placeholder echoed back in an answer is meaningless to the reader
  const out = sanitizeAskReply(
    { points: [{ text: `${r.redact("Ann")} leaned in.`, refs: ["P01:2-3"] }], unsupported: [] }, c, r);
  expect(out.points[0].text).toBe("Ann leaned in.");
});

test("answers export one row per citation, so they join to coded-segments on the ref", () => {
  useStore.getState().addAnswer({
    question: "why is it hard?",
    points: [{ text: "zooming loses context", refs: ["P01:2-3", "P01@00:00:12"] }],
    unsupported: ["nothing on frequency"],
    scope: { pids: ["P01"], codes: ["magnification"], events: true, excerpts: true },
    model: "gpt-5.6-terra", costUsd: 0.0132,
  });
  const csv = useStore.getState().exportAnswers();
  const rows = csv.trim().split(/\r?\n/); // toCSV writes CRLF, like every other export
  expect(rows[0]).toBe("asked_at,question,kind,point,ref,scope_transcripts,scope_codes,scope_material,model");
  expect(rows.length).toBe(4); // header + two citations + one unsupported
  expect(csv).toContain("P01:2-3");
  expect(csv).toContain("P01@00:00:12");
  expect(csv).toContain("unsupported");
  // the scope goes out in full, so a later reader can tell what the answer covered
  expect(csv).toContain("magnification");
});

test("an answer that produced nothing still exports as a question that was asked", () => {
  useStore.setState({ answers: [], nextAid: 1 } as never);
  useStore.getState().addAnswer({
    question: "anything about cost?", points: [], unsupported: [],
    scope: { pids: ["P01"], codes: [], events: true, excerpts: false },
    model: "gpt-5.6-luna", costUsd: 0.0004,
  });
  const rows = useStore.getState().exportAnswers().trim().split(/\r?\n/);
  expect(rows.length).toBe(2); // header + the empty answer
  expect(rows[1]).toContain("empty");
});

test("an answer records the scope it came from, so it stays interpretable later", () => {
  useStore.setState({ answers: [], nextAid: 1 } as never);
  useStore.getState().addAnswer({
    question: "q", points: [], unsupported: [],
    scope: { pids: ["P01"], codes: ["magnification"], events: false, excerpts: true },
    model: "gpt-5.6-luna", costUsd: 0.001,
  });
  const a = useStore.getState().answers[0];
  expect(a.scope).toEqual({ pids: ["P01"], codes: ["magnification"], events: false, excerpts: true });
  expect(a.model).toBe("gpt-5.6-luna");
  expect(a.at).toMatch(/^\d{4}-\d\d-\d\dT/);
});

test("a citation resolves to where the material lives NOW", () => {
  const s = useStore.getState();
  expect(refTarget(s, "P01:2-3")).toEqual({ pid: "P01", line: 2 });
  expect(refTarget(s, "P01@00:00:12")).toEqual({ pid: "P01", line: 3 }); // the line the note sits above
  expect(refTarget(s, "P09:1")).toBe(null);        // transcript gone
  expect(refTarget(s, "P01@09:99:99")).toBe(null); // event gone
});

test("a pid containing @ is still read as a transcript, not as an event time", () => {
  useStore.setState({
    transcripts: { "a@b": { lines: [L(1, "00:00:01", "P", "one"), L(2, "00:00:05", "P", "two")] } },
    segments: [{ sid: 9, pid: "a@b", start: 2, end: 2, code: "c", proposedBy: "me", status: "accepted", notes: "" }],
    codebook: { c: { color: "#123456", def: "", status: "accepted" } },
    markers: [], video: {},
  } as never);
  const c = buildCorpus(useStore.getState(), { pids: ["a@b"], codes: ["c"], events: false, excerpts: true });
  expect(c.excerpts[0].ref).toBe("a@b:2");
  // splitting on the FIRST "@" would have read this as an event on a transcript "a"
  expect(refTarget(useStore.getState(), "a@b:2")).toEqual({ pid: "a@b", line: 2 });
});

test("one span coded twice is ONE excerpt carrying both codes, so a ref stays unique", () => {
  useStore.setState({
    transcripts: { P01: { lines: [L(1, "00:00:01", "P", "one"), L(2, "00:00:05", "P", "the same words")] } },
    segments: [
      { sid: 1, pid: "P01", start: 2, end: 2, code: "magnification", proposedBy: "me", status: "accepted", notes: "" },
      { sid: 2, pid: "P01", start: 2, end: 2, code: "frustration", proposedBy: "me", status: "accepted", notes: "" },
    ],
    codebook: {
      magnification: { color: "#4477aa", def: "", status: "accepted" },
      frustration: { color: "#ee6677", def: "", status: "accepted" },
    },
    markers: [], video: {},
  } as never);
  const c = buildCorpus(useStore.getState(), { pids: ["P01"], codes: ["magnification", "frustration"], events: false, excerpts: true });
  expect(c.excerpts.length).toBe(1);
  expect(c.excerpts[0].codes.sort()).toEqual(["frustration", "magnification"]);
  expect(c.where.size).toBe(1); // one ref, one meaning
});

test("two events on the same second read as one moment rather than sharing a ref", () => {
  useStore.setState({
    transcripts: { P01: { lines: [L(1, "00:00:01", "P", "one"), L(2, "00:00:20", "P", "two")] } },
    segments: [], codebook: {}, video: {},
    markers: [
      { mid: 1, pid: "P01", t: 12, event: "marker", code: "custom", label: "leans in", detail: "", raw: {} },
      { mid: 2, pid: "P01", t: 12, event: "marker", code: "custom", label: "squints", detail: "", raw: {} },
    ],
  } as never);
  const c = buildCorpus(useStore.getState(), { pids: ["P01"], codes: [], events: true, excerpts: false });
  expect(c.events.length).toBe(1);
  expect(c.events[0].text).toBe("leans in; squints");
});

test("renaming a transcript carries the citations of every saved answer", () => {
  useStore.setState({
    transcripts: { P01: { lines: [L(1, "00:00:01", "P", "x")] }, P01b: { lines: [L(1, "00:00:01", "P", "y")] } },
    tabs: ["P01", "P01b"], active: "P01", segments: [], markers: [], codebook: {},
    answers: [{
      aid: 1, at: "2026-08-14T10:00:00.000Z", question: "q",
      points: [{ text: "p", refs: ["P01:2-3", "P01@00:00:12", "P01b:1"] }],
      unsupported: [], scope: { pids: ["P01", "P01b"], codes: [], events: true, excerpts: true },
      model: "m", costUsd: 0,
    }],
    nextAid: 2,
  } as never);
  expect(useStore.getState().renameTranscript("P01", "P07")).toBe(null);
  const a = useStore.getState().answers[0];
  // the prefix-sharing transcript must NOT be caught by the rewrite
  expect(a.points[0].refs).toEqual(["P07:2-3", "P07@00:00:12", "P01b:1"]);
  expect(a.scope.pids).toEqual(["P07", "P01b"]);
});

// Sections are the comparison axis of most study designs — without them
// "what did people say in the baseline condition" cannot be answered from this
// payload at all. They are listed once and referenced by id, because the axes
// overlap and grouping the excerpts under one of them would hide the others.
test("the payload says where in the session each excerpt sits", () => {
  useStore.setState({
    stretches: [
      { pid: "P01", start: 1, end: 9, dim: "condition", value: "baseline", status: "accepted" },
      { pid: "P01", start: 1, end: 3, dim: "phase", value: "warm-up" },
      // unjudged: must not reach the model as the shape of the session
      { pid: "P01", start: 4, end: 9, dim: "phase", value: "task", status: "candidate" },
    ],
  } as never);
  const c = buildCorpus(useStore.getState(), all);
  const payload = renderAskPayload("which condition was harder?", c, redactor([]));

  expect(payload).toContain("SESSION STRUCTURE:");
  expect(payload).toContain("condition: baseline");
  expect(payload).toContain("phase: warm-up");
  // the proposal is absent from the structure AND from every excerpt's tags
  expect(payload).not.toContain("phase: task");

  // the excerpt at lines 2-3 is inside both accepted sections, and says so
  const line = payload.split("\n").find((l) => l.startsWith("[P01:2-3]"))!;
  expect(line).toMatch(/\[S1, S2\]$/);

  // and so do EVENTS — the prompt promises both carry them, and an events-only
  // question ("what was observed during baseline?") is answerable only if they do
  const ev = payload.split("\n").find((l) => l.startsWith("[P01@"));
  expect(ev).toMatch(/\[S1, S2\]$/);
});

test("a study with no marked sections sends no structure block at all", () => {
  useStore.setState({ stretches: [] } as never);
  const payload = renderAskPayload("q", buildCorpus(useStore.getState(), all), redactor([]));
  expect(payload).not.toContain("SESSION STRUCTURE");
  // and no excerpt grows an empty tag
  expect(payload).not.toContain("[]");
});
