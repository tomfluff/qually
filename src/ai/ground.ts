// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F1 of AI-ASSIST.md: grounding — for each coded excerpt, WHICH words carry the
// code the researcher assigned. Annotates existing coding; proposes nothing.
import { hashLine } from "./flag";
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const GROUND_CHUNK = 12; // excerpts per request — longer than scan lines

// A segment's grounding is valid only while its code AND its excerpt text are
// what the model saw — recode, merge, resize, or a line edit all change the
// hash and the record silently drops out (same trick as the scan marks).
export interface GroundRec { hash: string; quotes: string[] }
export const groundHash = (code: string, excerpt: string) => hashLine(code + "\u0000" + excerpt);

export interface GroundItem { sid: number; code: string; def: string; excerpt: string }

const SYSTEM = `You are reviewing coded excerpts from research transcripts. For each item the researcher assigned the CODE to the EXCERPT. Quote the passage or passages that would lead a qualitative coder to assign that code — the textual evidence FOR the code, copied verbatim as exact substrings of that item's excerpt. A passage is a complete clause or statement that stands on its own as the reason for the code, not isolated keywords: prefer the full evidential stretch over a fragment of it. One to three passages per item. If nothing in the excerpt would specifically lead a coder to that code, return no passages for that item.

Example — excerpt: "I like our current plan, but I do think your first item in terms of the persona evaluation is a good justification for your probe study. So that one still, it's your exploration of the feedback. Right. But when you try to probe people about how to design things, we are thinking about the input adaptation and output adaptation, which justify the two probes you provide really well." with the code "framing the narrative" grounds as: "I do think your first item in terms of the persona evaluation is a good justification for your probe study" and "we are thinking about the input adaptation and output adaptation, which justify the two probes".

Text like [REDACTED_1] is a removed identifier; never include it in a passage.`;

export const chunksOfItems = (items: GroundItem[]): GroundItem[][] => {
  const out: GroundItem[][] = [];
  for (let i = 0; i < items.length; i += GROUND_CHUNK) out.push(items.slice(i, i + GROUND_CHUNK));
  return out;
};

// exactly what gets sent for one chunk — also what the consent preview shows
export const renderGroundChunk = (items: GroundItem[], r: Redaction): string =>
  items.map((it) =>
    `#${it.sid} CODE: ${it.code}${it.def ? ` — ${r.redact(it.def)}` : ""}\n${r.redact(it.excerpt)}`
  ).join("\n\n");

export const estimateGroundTokens = (items: GroundItem[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderGroundChunk(items, r));

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sid: { type: "integer", description: "the #id of the item" },
          quotes: {
            type: "array",
            description: "0-3 evidence passages, each an exact substring of that item's excerpt — complete clauses a coder would point to as the reason for the code",
            items: { type: "string" },
          },
        },
        required: ["sid", "quotes"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

export async function groundChunk(opts: {
  key: string; model: string; items: GroundItem[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ recs: Record<number, GroundRec>; usage: Usage }> {
  const { data, usage } = await callJson<{ items: { sid: number; quotes: string[] }[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderGroundChunk(opts.items, opts.redaction),
    schemaName: "ground_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });

  return { recs: sanitizeGroundReply(opts.items, data.items ?? [], opts.redaction), usage };
}

// The trust boundary, separated so it's testable without the network. EVERY sent
// item gets a record (even an empty one) — like the scan cache, a clean item
// with no record would look unscanned and be re-sent next run.
export function sanitizeGroundReply(
  items: GroundItem[],
  reply: { sid: number; quotes: string[] }[],
  redaction: Redaction,
): Record<number, GroundRec> {
  const bySid = new Map(items.map((it) => [it.sid, it]));
  const recs: Record<number, GroundRec> = {};
  for (const it of items) recs[it.sid] = { hash: groundHash(it.code, it.excerpt), quotes: [] };
  for (const r of reply) {
    const it = bySid.get(r.sid);
    if (!it) continue; // an invented id grounds nothing
    const quotes: string[] = [];
    for (const q0 of r.quotes ?? []) {
      // restore through the redaction map, then DROP anything that isn't a
      // genuine substring or still carries a placeholder — a hallucinated
      // quote would emphasise text that isn't there
      if (redaction.hasPlaceholder(q0)) continue;
      const q = redaction.restore(q0).trim();
      if (!q || !it.excerpt.includes(q)) continue;
      if (!quotes.includes(q)) quotes.push(q);
      if (quotes.length === 3) break;
    }
    recs[it.sid] = { hash: groundHash(it.code, it.excerpt), quotes };
  }
  return recs;
}
