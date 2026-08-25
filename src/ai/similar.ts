// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The semantic half of "find similar codes". The offline pass (src/similar.ts)
// already caught everything that shares wording; this exists for the relative
// that shares none — "needs zoom" beside "difficult to see". So the payload is
// deliberately thin: every code's NAME and DEFINITION, plus a few excerpts for
// the one code under the cursor. No excerpts for the rest of the book — that
// depth belongs to focus reconcile, which is the considered pass; this is the
// quick look that costs a fraction of a cent.
import { callJson, estimateTokens, type Usage } from "./openai";
import { restore, type Redaction } from "./redact";
import type { MergeCodeInput } from "./dedupe";
import { norm } from "../contract/segments";

export interface SemanticMatch { name: string; band: "very" | "related"; why: string }

const SYSTEM = `You are helping a qualitative researcher find redundancy in a first-cycle codebook. Given ONE focus code and the rest of the codebook (names and definitions), list the codes that are semantically close to the focus code — the same concept under a different name, a splinter of it, or a code whose excerpts would plausibly carry the focus code's label.

Rank by closeness and put each in a band: "very" (these could be one code) or "related" (adjacent, worth a look, probably not one code). Give one short reason per match naming what they share.

Be strict. A codebook where most codes are distinct is a well-made codebook: returning 3 honest matches is better than 10 padded ones, and returning none is a valid answer. Never list the focus code itself. Use the exact code names given.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

const SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "exact name of the similar code" },
          band: { type: "string", enum: ["very", "related"] },
          why: { type: "string", description: "one short phrase: what they share" },
        },
        required: ["code", "band", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
} as const;

/** One construction for the bytes sent and the substitutions they contain.
    The consent gate and provenance log consume the count beside the rendered
    text, so adding a field to this request cannot leave its accounting behind. */
export const similarPayload = (
  focus: MergeCodeInput, book: { name: string; def: string }[], r: Redaction,
): { text: string; redactions: number } => {
  let redactions = 0;
  const redact = (text: string) => {
    redactions += r.count(text);
    return r.redact(text);
  };
  const ex = focus.excerpts.length
    ? `\nExcerpts:\n${focus.excerpts.map((e) => `- ${redact(e)}`).join("\n")}`
    : "";
  const text = `FOCUS CODE:\n${focus.name}${focus.def ? `\nDefinition: ${redact(focus.def)}` : ""}${ex}\n\n`
    + `CODEBOOK (names and definitions only):\n`
    + book.map((c) => `- ${c.name}${c.def ? `: ${redact(c.def)}` : ""}`).join("\n");
  return { text, redactions };
};

const renderSimilarPayload = (
  focus: MergeCodeInput, book: { name: string; def: string }[], r: Redaction,
): string => similarPayload(focus, book, r).text;

export const estimateSimilarTokens = (
  focus: MergeCodeInput, book: { name: string; def: string }[], r: Redaction,
) => estimateTokens(SYSTEM) + estimateTokens(renderSimilarPayload(focus, book, r));

export async function findSimilarWithAi(opts: {
  key: string; model: string;
  focus: MergeCodeInput; book: { name: string; def: string }[];
  redaction: Redaction; signal?: AbortSignal;
}): Promise<{ matches: SemanticMatch[]; usage: Usage }> {
  const { data, usage } = await callJson<{ matches: { code: string; band: string; why: string }[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: similarPayload(opts.focus, opts.book, opts.redaction).text,
    schemaName: "find_similar",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return {
    matches: sanitizeMatches(opts.focus.name, opts.book.map((c) => c.name), data.matches ?? [], opts.redaction),
    usage,
  };
}

// The trust boundary: only codes we sent, never the focus code itself, one row
// per code, and a band we recognise (anything else reads as the weaker one).
export function sanitizeMatches(
  focus: string,
  known: string[],
  reply: { code: string; band: string; why: string }[],
  r?: Redaction,
): SemanticMatch[] {
  const live = new Set(known);
  const seen = new Set<string>();
  const out: SemanticMatch[] = [];
  for (const m of reply) {
    const name = (m.code ?? "").trim();
    if (!live.has(name) || norm(name) === norm(focus) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      band: m.band === "very" ? "very" : "related",
      why: restore(r, (m.why ?? "").trim()) || "the AI judged these close",
    });
  }
  // "very" first, order within a band as the model ranked it
  return [...out.filter((m) => m.band === "very"), ...out.filter((m) => m.band === "related")];
}
