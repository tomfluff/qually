// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F2 of AI-ASSIST.md: find near-duplicate codes. One shot over the whole codebook
// (name + definition + a few sample excerpts each) → merge proposals. The AI only
// PROPOSES pairs; the researcher accepts each one, and the merge itself runs
// through the existing (undoable) mergeCode. Nothing is applied here.
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const MERGE_EXEMPLARS = 6; // sample coded excerpts sent per code

// What the model sees for one code. Names stay raw — they're the identifiers the
// proposals map back to, and redacting one would break that link; the definition
// and excerpts (the free text that could carry a participant term) are redacted.
export interface MergeCodeInput { name: string; def: string; excerpts: string[] }
// tier: "duplicate" = merge clearly cleans the codebook; "overlap" = substantial
// overlap in use, offered for the researcher to consider (labelled in the UI)
export interface MergeProposal { from: string; into: string; rationale: string; tier: "duplicate" | "overlap" }

const SYSTEM = `You are reviewing a qualitative-analysis codebook. Each entry has a code name, an optional definition, and sample excerpts the researcher coded with it. Find pairs of codes that could be merged into one.

How to compare a pair — evidence in order of weight:
1. The excerpts: do the two codes mark the same kind of moment? Compare what the quotes are about (topic and target), the sentiment or stance they express (frustration vs. delight vs. neutral description), and the analytic work the code is doing (labelling a feeling, a behaviour, a feature, a problem). Two codes whose excerpts could be swapped without anyone noticing are one concept.
2. The definitions, when present.
3. The names, as the weakest signal — two codes can share a word yet mean different things, and two differently-named codes can do the same work.

Report each candidate pair at one of two tiers:
- "duplicate": the same underlying concept under two labels; the analysis is cleaner as one code.
- "overlap": not identical, but their usage overlaps enough (similar quotes, same sentiment about the same target, one nearly contained in the other) that the researcher should consider a merge.

Be generous with "overlap" — a plausible pair surfaced is a decision for the researcher, a plausible pair omitted is invisible. Stay strict with "duplicate". Never propose pairs that are merely thematically adjacent or hierarchically linked with distinct uses (a sub-type doing its own analytic work is not a merge candidate).

For each pair: "into" is the code to keep, "from" is the one to fold into it. Prefer keeping the code with the clearer definition or the broader, better-supported meaning. Give a one-sentence rationale naming the shared concept and the evidence (quote similarity, shared sentiment, contained usage). Use the exact code names given. If nothing qualifies, return an empty list — that is a good answer.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

// exactly what gets sent — also what the consent preview shows
export const renderMergePayload = (codes: MergeCodeInput[], r: Redaction): string =>
  codes.map((c) => {
    const head = `CODE: ${c.name}${c.def ? ` — ${r.redact(c.def)}` : ""}`;
    const ex = c.excerpts.map((e) => `  - ${r.redact(e)}`).join("\n");
    return ex ? `${head}\n${ex}` : head;
  }).join("\n\n");

export const estimateMergeTokens = (codes: MergeCodeInput[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderMergePayload(codes, r));

const SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string", description: "exact name of the code to fold in (removed after merge)" },
          into: { type: "string", description: "exact name of the code to keep" },
          rationale: { type: "string", description: "one sentence: the shared concept and the evidence" },
          tier: { type: "string", enum: ["duplicate", "overlap"], description: "duplicate = same concept; overlap = worth considering" },
        },
        required: ["from", "into", "rationale", "tier"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
} as const;

export async function dedupeCodes(opts: {
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ proposals: MergeProposal[]; usage: Usage }> {
  const { data, usage } = await callJson<{ proposals: MergeProposal[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderMergePayload(opts.codes, opts.redaction),
    schemaName: "merge_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return { proposals: sanitizeMergeReply(opts.codes, data.proposals ?? []), usage };
}

// The trust boundary, separated so it's testable without the network. A proposal
// is only actionable if BOTH names are real codes we sent and they differ; an
// invented name would merge nothing (or worse, the wrong thing). Unordered-pair
// dedupe so "a→b" and "b→a" (or a repeat) can't queue the same merge twice.
export function sanitizeMergeReply(
  codes: MergeCodeInput[],
  reply: MergeProposal[],
): MergeProposal[] {
  const known = new Set(codes.map((c) => c.name));
  const seen = new Set<string>();
  const out: MergeProposal[] = [];
  for (const p of reply) {
    const from = (p.from ?? "").trim(), into = (p.into ?? "").trim();
    if (!known.has(from) || !known.has(into) || from === into) continue;
    const key = JSON.stringify([from, into].sort()); // unordered: a|b === b|a
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from, into, rationale: (p.rationale ?? "").trim(),
      // an unrecognised tier downgrades to "overlap": mislabelling a proposal
      // as the confident kind is the only harmful direction
      tier: p.tier === "duplicate" ? "duplicate" : "overlap",
    });
  }
  // confident pairs first
  return out.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "duplicate" ? -1 : 1));
}
