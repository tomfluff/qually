// The parts of the AI path that must not be wrong: redaction (data leaves the
// device), the content hash (stale flags), and the guard against a hallucinated
// quote being rendered over text that doesn't exist.
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "./redact";
import { hashLine, renderChunk, chunksOf, flagChunk, CHUNK } from "./flag";
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

describe("flagChunk — what the model says is not trusted", () => {
  afterEach(() => vi.unstubAllGlobals());

  const lines = [L(1, "So Ann, how do you read a chart?", "R"), L(2, "I lost the ticket marks.")];
  const red = redactor(["Ann"]);
  const run = (flags: unknown[]) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiReply(flags)));
    return flagChunk({ key: "sk-x", model: DEFAULT_MODEL, lines, redaction: red });
  };

  it("keeps a genuine flag", async () => {
    const { flags } = await run([{ line_id: 2, quote: "ticket marks", reason: "tick marks" }]);
    expect(flags[2]).toEqual([{ quote: "ticket marks", reason: "tick marks" }]);
  });

  it("drops a hallucinated quote that isn't in the line", async () => {
    const { flags } = await run([{ line_id: 2, quote: "purple monkey", reason: "invented" }]);
    expect(flags[2]).toBeUndefined();
  });

  it("drops a flag ON a redaction placeholder — the model never saw the real name, so it cannot judge it", async () => {
    const { flags } = await run([{ line_id: 1, quote: "[REDACTED_1]", reason: "looks odd" }]);
    expect(flags[1]).toBeUndefined(); // must NOT underline the participant's real name
  });

  it("drops a flag on a line that wasn't sent", async () => {
    const { flags } = await run([{ line_id: 999, quote: "whatever", reason: "x" }]);
    expect(Object.keys(flags)).toHaveLength(0);
  });

  it("reports real usage from the API, not the estimate", async () => {
    const { usage } = await run([]);
    expect(usage).toMatchObject({ inTok: 100, outTok: 20 });
    expect(usage.costUsd).toBeCloseTo((100 / 1e6) * 1 + (20 / 1e6) * 6, 9); // Luna pricing
  });

  it("sends the redacted text and asks for strict JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiReply([]));
    vi.stubGlobal("fetch", fetchMock);
    await flagChunk({ key: "sk-x", model: "gpt-5.6-sol", lines, redaction: red });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.input[1].content).not.toContain("Ann");
    expect(body.input[1].content).toContain("[REDACTED_1]");
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
