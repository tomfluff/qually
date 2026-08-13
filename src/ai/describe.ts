// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Draft codebook definitions from usage. One shot over the codes that have
// accepted segments (name + current definition + sample excerpts each) → a
// drafted definition per code. The AI only DRAFTS; the researcher edits and
// applies each one in the modal (through the existing setDef). Nothing is
// applied here.
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const DESC_EXEMPLARS = 8; // sample coded excerpts sent per code — the evidence a definition is grounded in

// Names stay raw (they're the identifiers drafts map back to); definitions and
// excerpts are redacted — same contract as the merge run.
export interface DescCodeInput { name: string; def: string; excerpts: string[] }
export interface DescDraft { code: string; definition: string }

const SYSTEM = `You are helping a qualitative researcher document their codebook. Each entry has a code name, sometimes an existing definition, and sample excerpts the researcher coded with it.

Write a definition for EVERY code given, grounded in how the code was actually used:
- Say what kind of moment the code marks — the topic, the sentiment or stance, the behaviour — as shown by the excerpts, not by the name alone.
- One or two sentences, plain language, present tense ("Marks moments where…" or an equivalent researcher voice).
- Where a sibling code in this batch is close, add the boundary in one clause (what belongs to this code rather than that one).
- If an existing definition is given, refine it against the evidence rather than discarding it; keep what it gets right.
- Describe only what the excerpts support. Never invent participants, settings, or findings.

Use the exact code names given. Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

// exactly what gets sent — also what the consent preview shows
export const renderDescribePayload = (codes: DescCodeInput[], r: Redaction): string =>
  codes.map((c) => {
    const head = `CODE: ${c.name}${c.def ? ` — current definition: ${r.redact(c.def)}` : ""}`;
    const ex = c.excerpts.map((e) => `  - ${r.redact(e)}`).join("\n");
    return ex ? `${head}\n${ex}` : head;
  }).join("\n\n");

export const estimateDescribeTokens = (codes: DescCodeInput[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderDescribePayload(codes, r));

const SCHEMA = {
  type: "object",
  properties: {
    descriptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "exact name of the code" },
          definition: { type: "string", description: "one or two sentences, grounded in the excerpts" },
        },
        required: ["code", "definition"],
        additionalProperties: false,
      },
    },
  },
  required: ["descriptions"],
  additionalProperties: false,
} as const;

export async function describeCodes(opts: {
  key: string; model: string; codes: DescCodeInput[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ drafts: DescDraft[]; usage: Usage }> {
  const { data, usage } = await callJson<{ descriptions: DescDraft[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderDescribePayload(opts.codes, opts.redaction),
    schemaName: "describe_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return { drafts: sanitizeDescribeReply(opts.codes, data.descriptions ?? []), usage };
}

// The trust boundary, testable without the network: a draft is only usable for
// a code we actually sent (an invented name would write a definition onto
// nothing — or the wrong thing), non-empty, and once per code (first wins).
export function sanitizeDescribeReply(codes: DescCodeInput[], reply: DescDraft[]): DescDraft[] {
  const known = new Set(codes.map((c) => c.name));
  const seen = new Set<string>();
  const out: DescDraft[] = [];
  for (const d of reply) {
    const code = (d.code ?? "").trim(), definition = (d.definition ?? "").trim();
    if (!known.has(code) || !definition || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, definition });
  }
  return out;
}
