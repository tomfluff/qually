// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F3 of AI-ASSIST.md: suggest codes from the researcher's OWN codebook. Chunked
// windows of one transcript + the codebook (name, def, a couple of exemplars) →
// proposed line ranges to code with an EXISTING code. Lands as candidate
// segments (proposedBy "AI · <model>") for the researcher to accept or reject —
// the AI never invents a code, and nothing is applied without a verdict.
import type { Line } from "../state/store";
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const SUGGEST_CHUNK = 40;    // transcript lines per request (a window, not the corpus)
export const SUGGEST_EXEMPLARS = 2; // sample coded excerpts sent per code, to anchor its meaning

export interface SuggestCode { name: string; def: string; excerpts: string[] }
export interface SuggestProposal { startLine: number; endLine: number; code: string }

const SYSTEM = `You are a second coder applying an EXISTING codebook to an interview transcript. You are given the codebook (each code with its definition and a couple of example excerpts already coded with it) and a window of numbered transcript lines. Propose which line ranges should carry which code.

Rules:
- Use ONLY codes from the codebook, by their exact name. Never invent a code, theme, or new label — proposing a new code is the researcher's job, not yours.
- A proposal is a contiguous range of line ids (start to end, inclusive) plus one code. Keep ranges tight — the lines that actually carry the code, usually one to three.
- Propose only clear, defensible applications. A window with nothing codeable is a fine answer: return an empty list.
- One line may warrant more than one code (separate proposals); many lines will warrant none.
- Text like [REDACTED_1] is a removed identifier; treat it as an opaque token.`;

// exactly what gets sent for one chunk — codebook first (the lens), then the window
export const renderSuggestChunk = (lines: Line[], codes: SuggestCode[], r: Redaction): string => {
  const book = codes.map((c) => {
    const head = `- ${c.name}${c.def ? `: ${r.redact(c.def)}` : ""}`;
    const ex = c.excerpts.map((e) => `    e.g. ${r.redact(e)}`).join("\n");
    return ex ? `${head}\n${ex}` : head;
  }).join("\n");
  const window = lines.map((l) => `${l.id}\t${r.redact(l.speaker)}\t${r.redact(l.text)}`).join("\n");
  return `CODEBOOK:\n${book}\n\nTRANSCRIPT:\n${window}`;
};

export const estimateSuggestTokens = (lines: Line[], codes: SuggestCode[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderSuggestChunk(lines, codes, r));

export const chunksOf = (lines: Line[]): Line[][] => {
  const out: Line[][] = [];
  for (let i = 0; i < lines.length; i += SUGGEST_CHUNK) out.push(lines.slice(i, i + SUGGEST_CHUNK));
  return out;
};

const SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_start: { type: "integer", description: "first line id of the range (inclusive)" },
          line_end: { type: "integer", description: "last line id of the range (inclusive)" },
          code: { type: "string", description: "exact name of an existing codebook code" },
        },
        required: ["line_start", "line_end", "code"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
} as const;

export async function suggestChunk(opts: {
  key: string; model: string; lines: Line[]; codes: SuggestCode[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ proposals: SuggestProposal[]; usage: Usage }> {
  const { data, usage } = await callJson<{ proposals: { line_start: number; line_end: number; code: string }[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderSuggestChunk(opts.lines, opts.codes, opts.redaction),
    schemaName: "suggest_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return { proposals: sanitizeSuggestReply(opts.codes, opts.lines, data.proposals ?? []), usage };
}

// The trust boundary, testable without the network. A proposal is only usable if
// it names an EXISTING code and both endpoints are real line ids IN THIS WINDOW
// (the model can't code lines it wasn't shown); ranges are normalised low→high and
// identical proposals dedupe. Everything else is dropped rather than guessed at.
export function sanitizeSuggestReply(
  codes: SuggestCode[],
  lines: Line[],
  reply: { line_start: number; line_end: number; code: string }[],
): SuggestProposal[] {
  const known = new Set(codes.map((c) => c.name));
  const ids = new Set(lines.map((l) => l.id));
  const seen = new Set<string>();
  const out: SuggestProposal[] = [];
  for (const p of reply) {
    if (!known.has(p.code)) continue;
    if (!Number.isInteger(p.line_start) || !Number.isInteger(p.line_end)) continue;
    if (!ids.has(p.line_start) || !ids.has(p.line_end)) continue;
    const startLine = Math.min(p.line_start, p.line_end);
    const endLine = Math.max(p.line_start, p.line_end);
    const key = `${startLine}-${endLine}-${p.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ startLine, endLine, code: p.code });
  }
  return out;
}

// A proposal is redundant if any segment ALREADY carries this code over an
// overlapping range — whether accepted (done) or rejected (you said no, don't
// resurface it). Model-independent: keyed on span+code, not who proposed it.
export const overlapsExisting = (
  segments: { pid: string; start: number; end: number; code: string; status: string }[],
  pid: string, p: SuggestProposal,
): boolean =>
  segments.some((s) => s.pid === pid && s.code === p.code
    && s.start <= p.endLine && p.startLine <= s.end);
