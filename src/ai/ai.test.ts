// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The parts of the AI path that must not be wrong: redaction (data leaves the
// device), the content hash (stale flags), and the guard against a hallucinated
// quote being rendered over text that doesn't exist.
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "./redact";
import { hashLine, renderChunk, chunksOf, scanChunk, buildSystem, LENSES, CHUNK } from "./flag";
import { MODELS, DEFAULT_MODEL, modelOf, costOf } from "./openai";
import type { Line } from "../state/store";

const L = (id: number, text: string, speaker = "P"): Line => ({ id, ts: "", speaker, text });

// a Responses-API envelope: a reasoning item comes BEFORE the message item
const apiReply = (flags: unknown[]) => new Response(JSON.stringify({
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ flags }) }] },
  ],
  usage: { input_tokens: 100, output_tokens: 20 },
}), { status: 200 });

describe("redaction", () => {
  const r = redactor(["Ann Lee", "Ann", "Acme Corp"]);

  it("replaces terms and restores them", () => {
    const red = r.redact("Ann Lee showed me the Acme Corp dashboard.");
    expect(red).toBe("[REDACTED_1] showed me the [REDACTED_3] dashboard.");
    expect(r.restore(red)).toBe("Ann Lee showed me the Acme Corp dashboard.");
  });

  it("prefers the longest term, so a name isn't half-redacted", () => {
    expect(r.redact("Ann Lee")).toBe("[REDACTED_1]");   // not "[REDACTED_2] Lee"
  });

  it("is case-insensitive but whole-word", () => {
    expect(r.redact("ANN said so")).toBe("[REDACTED_2] said so");
    expect(r.redact("Annapurna is a mountain")).toBe("Annapurna is a mountain"); // no partial hit
  });

  it("counts what it would remove", () => {
    expect(r.count("Ann and Ann Lee at Acme Corp")).toBe(3);
  });

  it("is a no-op with no terms — and must not crash on an empty list", () => {
    const none = redactor([]);
    expect(none.redact("Ann Lee")).toBe("Ann Lee");
    expect(none.count("Ann Lee")).toBe(0);
  });

  // JS \b is ASCII-only: these names used to pass through UNREDACTED (PII leak)
  it("redacts names that start or end in non-ASCII letters", () => {
    const u = redactor(["José", "Łukasz", "田中"]);
    expect(u.redact("José said so.")).toBe("[REDACTED_1] said so.");
    expect(u.redact("and Łukasz agreed")).toBe("and [REDACTED_2] agreed");
    expect(u.redact("田中さんの意見")).toBe("[REDACTED_3]さんの意見"); // no spaces in CJK: bare match
    expect(u.redact("Josée is someone else")).toBe("Josée is someone else"); // still whole-word
    expect(u.count("José and 田中")).toBe(2);
  });
});

describe("content hash", () => {
  it("changes when the line is corrected — this is what expires a flag", () => {
    expect(hashLine("the ticket marks")).not.toBe(hashLine("the tick marks"));
  });
  it("is stable for identical text", () => {
    expect(hashLine("same words")).toBe(hashLine("same words"));
  });
});

describe("chunking", () => {
  it("splits a transcript into windows, never sending the corpus at once", () => {
    const lines = Array.from({ length: CHUNK * 2 + 5 }, (_, i) => L(i + 1, "hi"));
    const cs = chunksOf(lines);
    expect(cs).toHaveLength(3);
    expect(cs[0]).toHaveLength(CHUNK);
    expect(cs[2]).toHaveLength(5);
  });

  it("sends redacted text, with ids so flags can be mapped back", () => {
    const out = renderChunk([L(7, "Ann said it was fine")], redactor(["Ann"]));
    expect(out).toBe("7\tP\t[REDACTED_1] said it was fine");
    expect(out).not.toContain("Ann");
  });
});

describe("scanChunk — what the model says is not trusted", () => {
  afterEach(() => vi.unstubAllGlobals());

  const lines = [L(1, "So Ann, how do you read a chart?", "R"), L(2, "I lost the ticket marks and honestly I hate this chart.")];
  const red = redactor(["Ann"]);
  const run = (flags: unknown[], lenses = ["transcription", "emotion"]) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiReply(flags)));
    return scanChunk({ key: "sk-x", model: DEFAULT_MODEL, lines, lenses, redaction: red });
  };

  it("keeps a genuine mark, tagged with its lens", async () => {
    const { flags } = await run([{ line_id: 2, lens: "transcription", quote: "ticket marks", note: "tick marks" }]);
    expect(flags[2]).toEqual([{ quote: "ticket marks", reason: "tick marks", lens: "transcription" }]);
  });

  it("keeps a notice from a different lens on the same line", async () => {
    const { flags } = await run([
      { line_id: 2, lens: "transcription", quote: "ticket marks", note: "tick marks" },
      { line_id: 2, lens: "emotion", quote: "I hate this chart", note: "frustration" },
    ]);
    expect(flags[2]).toHaveLength(2);
    expect(flags[2][1].lens).toBe("emotion");
  });

  it("drops a mark from a lens that wasn't requested", async () => {
    const { flags } = await run([{ line_id: 2, lens: "desire", quote: "ticket marks", note: "x" }]);
    expect(flags[2]).toBeUndefined();
  });

  it("drops a hallucinated quote that isn't in the line", async () => {
    const { flags } = await run([{ line_id: 2, lens: "emotion", quote: "purple monkey", note: "invented" }]);
    expect(flags[2]).toBeUndefined();
  });

  it("drops a mark ON a redaction placeholder — the model never saw the real name, so it cannot judge it", async () => {
    const { flags } = await run([{ line_id: 1, lens: "transcription", quote: "[REDACTED_1]", note: "looks odd" }]);
    expect(flags[1]).toBeUndefined(); // must NOT underline the participant's real name
  });

  it("drops a mark on a line that wasn't sent", async () => {
    const { flags } = await run([{ line_id: 999, lens: "emotion", quote: "whatever", note: "x" }]);
    expect(Object.keys(flags)).toHaveLength(0);
  });

  it("reports real usage from the API, not the estimate", async () => {
    const { usage } = await run([]);
    expect(usage).toMatchObject({ inTok: 100, outTok: 20 });
    expect(usage.costUsd).toBeCloseTo((100 / 1e6) * 1 + (20 / 1e6) * 6, 9); // Luna pricing
  });

  it("sends the redacted text, only the ticked lenses, and asks for strict JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiReply([]));
    vi.stubGlobal("fetch", fetchMock);
    await scanChunk({ key: "sk-x", model: "gpt-5.6-sol", lines, lenses: ["emotion", "desire"], redaction: red });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.text.format.schema.properties.flags.items.properties.lens.enum).toEqual(["emotion", "desire"]);
    expect(body.input[0].content).toContain("[emotion]");
    expect(body.input[0].content).not.toContain("[transcription]");
    expect(body.input[1].content).not.toContain("Ann");
    expect(body.input[1].content).toContain("[REDACTED_1]");
  });

  // the fix field: a one-click repair is a WRITE into the transcript, so every
  // gate matters — see the validation block at the end of scanChunk
  it("keeps a usable fix on a transcription mark", async () => {
    const { flags } = await run([{ line_id: 2, lens: "transcription", quote: "ticket marks", note: "misheard", fix: "tick marks" }]);
    expect(flags[2]).toEqual([{ quote: "ticket marks", reason: "misheard", lens: "transcription", fix: "tick marks" }]);
  });

  it("drops a fix that merely repeats the quote — nothing to apply", async () => {
    const { flags } = await run([{ line_id: 2, lens: "transcription", quote: "ticket marks", note: "odd", fix: "ticket marks" }]);
    expect(flags[2]).toEqual([{ quote: "ticket marks", reason: "odd", lens: "transcription" }]); // mark survives, fix does not
  });

  it("drops a fix still holding an unknown placeholder — applying it would write [REDACTED_n] into the transcript", async () => {
    const { flags } = await run([{ line_id: 2, lens: "transcription", quote: "ticket marks", note: "x", fix: "[REDACTED_9] marks" }]);
    expect(flags[2]![0].fix).toBeUndefined();
  });

  it("restores a KNOWN placeholder inside the fix, same as the quote", async () => {
    const { flags } = await run([{ line_id: 1, lens: "transcription", quote: "read a chart", note: "x", fix: "read [REDACTED_1]'s chart" }]);
    expect(flags[1]![0].fix).toBe("read Ann's chart");
  });

  it("ignores a fix on a non-transcription lens — strict schema forces the field, only this lens gives it meaning", async () => {
    const { flags } = await run([{ line_id: 2, lens: "emotion", quote: "I hate this chart", note: "frustration", fix: "I love this chart" }]);
    expect(flags[2]).toEqual([{ quote: "I hate this chart", reason: "frustration", lens: "emotion" }]);
  });
});

describe("lenses", () => {
  it("cover the proposed set, transcription first", () => {
    expect(LENSES.map((l) => l.id)).toEqual(
      ["transcription", "emotion", "evaluation", "desire", "workaround", "tension", "invivo"]);
  });
  it("the system prompt includes exactly the requested scans", () => {
    const sys = buildSystem(["tension", "invivo"]);
    expect(sys).toContain("[tension]");
    expect(sys).toContain("[invivo]");
    expect(sys).not.toContain("[emotion]");
  });
});

describe("models", () => {
  it("defaults to the cheap tier — transcripts are long and this task is shallow", () => {
    expect(DEFAULT_MODEL).toBe("gpt-5.6-luna");
    expect(modelOf(DEFAULT_MODEL).name).toBe("Luna");
  });
  it("exposes all three tiers with their real ids", () => {
    expect(MODELS.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
  });
  it("falls back rather than throwing on an unknown id (a stale saved setting)", () => {
    expect(modelOf("gpt-4-turbo").id).toBe("gpt-5.6-luna");
  });
  it("prices a call", () => {
    // Luna: $1/1M in, $6/1M out
    expect(costOf(modelOf("gpt-5.6-luna"), 1_000_000, 1_000_000)).toBeCloseTo(7, 6);
  });
});

it("placeholders never reach the codebook or the merge review", async () => {
  const { redactor } = await import("./redact");
  const { sanitizeDescribeReply } = await import("./describe");
  const { sanitizeMergeReply } = await import("./dedupe");
  const r = redactor(["Ann Lee"]);
  const token = r.redact("Ann Lee");
  expect(token).not.toContain("Ann");

  // the model is told to refine the existing definition, which it was handed
  // redacted — so it echoes the token straight back
  const [draft] = sanitizeDescribeReply(
    [{ name: "trust", def: "", excerpts: [] }],
    [{ code: "trust", definition: `The pattern ${token} described.` }], r);
  expect(draft.definition).toBe("The pattern Ann Lee described.");

  const [prop] = sanitizeMergeReply(
    [{ name: "a", def: "", excerpts: [] }, { name: "b", def: "", excerpts: [] }],
    [{ from: "a", into: "b", rationale: `Both are ${token}'s point.`, tier: "overlap" }], r);
  expect(prop.rationale).toBe("Both are Ann Lee's point.");
});

it("a summary payload redacts the event type and the excerpt ref, not just the free text", async () => {
  const { redactor } = await import("./redact");
  const { renderSummaryPayload } = await import("./summarize");
  const r = redactor(["Ann"]);
  // both fields are study-authored: the type comes from an events CSV column or
  // the add-event modal, the ref carries the transcript name
  const out = renderSummaryPayload(
    [{ time: "0:01", type: "Ann arrives", text: "" }],
    [{ code: "x", ref: "Ann-interview 0:02", excerpt: "hello" }],
    "", r);
  expect(out).not.toContain("Ann");
});

describe("cluster sanitize (Code map grouping)", () => {
  it("keeps only real codes, one group each, drops thin groups, restores redactions", async () => {
    const { sanitizeClusterReply } = await import("./cluster");
    const { redactor } = await import("./redact");
    const r = redactor(["Ann"]);
    const token = r.redact("Ann");
    const codes = ["a", "b", "c", "d"].map((name) => ({ name, def: "", excerpts: [] }));
    const out = sanitizeClusterReply(codes, [
      { name: `${token}'s things`, codes: ["a", "b", "ghost"], rationale: `About ${token}.` },
      { name: "double dip", codes: ["b", "c"], rationale: "" },   // b already taken -> only c left -> drops
      { name: "solo", codes: ["d"], rationale: "" },              // fewer than 2 -> drops
    ], r);
    expect(out).toHaveLength(1);
    expect(out[0].codes).toEqual(["a", "b"]);
    expect(out[0].name).toBe("Ann's things");
    expect(out[0].rationale).toBe("About Ann.");
  });
});


describe("reconcile sanitize (cluster plan)", () => {
  it("clusters: one per code, survivor in members, collisions drop newName, thin drops", async () => {
    const { sanitizeClusters } = await import("./reconcile");
    const { redactor } = await import("./redact");
    const r = redactor(["Ann"]);
    const token = r.redact("Ann");
    const codes = ["a", "b", "c", "d", "outside"].map((name) => ({ name, def: "", excerpts: [] }));
    const out = sanitizeClusters(codes, [
      { survivor: "b", codes: ["a", "b", "ghost"], newName: "", rationale: `${token} said.` },
      { survivor: "x", codes: ["c", "d"], newName: "Outside", rationale: "" }, // bad survivor -> first member; newName collides with 'outside' -> dropped
      { survivor: "d", codes: ["d", "b"], newName: "", rationale: "" },        // d and b already taken -> thin -> drops
    ], r);
    expect(out).toHaveLength(2);
    expect(out[0].survivor).toBe("b");
    expect(out[0].codes).toEqual(["a", "b"]);
    expect(out[0].rationale).toBe("Ann said.");
    expect(out[1].survivor).toBe("c");
    expect(out[1].newName).toBeUndefined();
  });
  it("actions: rename/remove only, clustered codes excluded by the caller contract", async () => {
    const { sanitizeActions } = await import("./reconcile");
    const codes = ["a", "b"].map((name) => ({ name, def: "", excerpts: [] }));
    const out = sanitizeActions(codes, [
      { code: "a", action: "rename", newName: "clearer a", rationale: "" },
      { code: "a", action: "remove", rationale: "" },        // second action -> drops
      { code: "ghost", action: "remove", rationale: "" },    // unknown -> drops
      { code: "b", action: "rename", newName: "b", rationale: "" }, // rename to itself -> drops
    ]);
    expect(out.map((a) => `${a.code}:${a.action}`)).toEqual(["a:rename"]);
  });
  it("scoped rerun replaces pending clusters that intersect the subset", async () => {
    const { mergeScopedClusters } = await import("./reconcile");
    const pending = [
      { survivor: "a", codes: ["a", "b"], rationale: "" },
      { survivor: "x", codes: ["x", "y"], rationale: "" },
    ];
    const out = mergeScopedClusters(pending, new Set(["b", "q"]), [
      { survivor: "q", codes: ["q", "b"], rationale: "" },
    ]);
    expect(out.map((c) => c.survivor)).toEqual(["x", "q"]);
  });
});

describe("focus reconcile boundaries", () => {
  const mk = (names: string[]) => names.map((name) => ({ name, def: "", excerpts: [] }));
  it("focus clusters: context-only drops, bad survivor drops, one cluster per code", async () => {
    const { sanitizeFocusClusters } = await import("./reconcile");
    const all = mk(["f1", "f2", "c1", "c2", "c3"]);
    const focus = new Set(["f1", "f2"]);
    const out = sanitizeFocusClusters(all, focus, [
      { survivor: "c1", codes: ["c1", "c2"], rationale: "" },          // context-only -> drops
      { survivor: "ghost", codes: ["f1", "c1"], rationale: "" },       // survivor not a member -> drops
      { survivor: "c3", codes: ["f1", "c3"], newName: "c2", rationale: "" }, // newName collides outside -> name dropped, cluster kept
      { survivor: "f2", codes: ["f2", "c3"], rationale: "" },          // c3 already taken -> thin -> drops
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].survivor).toBe("c3");
    expect(out[0].newName).toBeUndefined();
  });
  it("landing: pending clusters touching fresh members drop whole", async () => {
    const { mergeFocusResults } = await import("./reconcile");
    const pending = [
      { survivor: "x", codes: ["x", "y"], rationale: "" },   // x touched by fresh -> drops whole
      { survivor: "p", codes: ["p", "q"], rationale: "" },   // untouched -> stays
    ];
    const pendingActions = [
      { code: "f1", action: "rename" as const, newName: "z", rationale: "" }, // focus -> superseded
      { code: "p", action: "rename" as const, newName: "pp", rationale: "" }, // untouched -> stays
    ];
    const fresh = { clusters: [{ survivor: "x", codes: ["f1", "x"], rationale: "" }], actions: [] };
    const out = mergeFocusResults(pending, pendingActions, fresh, new Set(["f1", "f2"]));
    expect(out.clusters.map((c) => c.survivor)).toEqual(["p", "x"]);
    expect(out.actions.map((a) => a.code)).toEqual(["p"]);
    expect(out.replaced).toBe(2);
  });
});
