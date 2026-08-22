// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Group the codebook by USAGE similarity for the Code map's islands. One shot
// over every code (name + definition + sample excerpts, same payload as the
// merge scan) → named groups with rationales. The AI only PROPOSES a grouping;
// the researcher reshapes it on the map (drag, rename, dissolve) and nothing
// about the codes themselves changes.
import { callJson, estimateTokens, type Usage } from "./openai";
import { restore, type Redaction } from "./redact";
import { renderMergePayload, type MergeCodeInput } from "./dedupe";

export interface ClusterGroup { name: string; codes: string[]; rationale?: string }

const SYSTEM = `You are organizing a qualitative-analysis codebook for revision. Each entry has a code name, an optional definition, and sample excerpts the researcher coded with it. Partition the codes into groups of SIMILAR USAGE — codes that mark the same kind of moment, target the same topic with the same analytic intent, or substantially overlap in what they get applied to.

This is NOT thematic hierarchy building. Group by how the codes are actually used (the excerpts are the strongest evidence, then definitions, then names — two codes can share a word yet do different work). A good group is a set the researcher would review together when consolidating: merge candidates, near-synonyms, splinters of one concept.

Rules:
- Groups have 2 to 8 codes. A code that resembles nothing stays out of every group — do NOT force coverage. Leaving many codes ungrouped is a good answer.
- Every code appears in AT MOST one group.
- Name each group in 2-4 plain words describing the shared usage (sentence case).
- Give each group one sentence of rationale naming the shared usage and the evidence.
- Use the exact code names given.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

// The map's AI-topics VIEW asks a different question. Grouping by usage
// produces merge-sized piles — two or three near-synonyms each — which is the
// right answer for consolidation and the wrong one for finding your way around
// 178 codes. This asks for a handful of broad areas of concern instead: the
// coarse shelves a researcher would use to locate the codes worth regrouping.
const AREAS_SYSTEM = `You are helping a qualitative researcher find their way around a large codebook. Each entry has a code name, an optional definition, and sample excerpts.

Sort the codes into a SMALL number of BROAD areas of concern — the shelves someone would use to locate a code, not merge candidates. Think in terms of what a code is about at a high level: the kinds of thing people say about a system, about the baseline way of doing things, about a tool or an assistant, their opinions and evaluations, their strategies and workarounds, their difficulties, their context and circumstances.

Rules:
- Aim for 5 to 9 areas for a codebook of any size. Fewer, bigger shelves is the goal; a pile of 20 two-code groups is a failure.
- Every code belongs to exactly one area, and put EVERY code somewhere — this is a way of looking at the whole book, so leaving codes out defeats it.
- An area holds as many codes as it needs; 20 or 30 in one area is fine and expected.
- Name each area in 2-5 plain words for what it is about (sentence case), e.g. "Strategies and workarounds", "Opinions about the baseline", "Difficulties reading charts".
- One sentence of rationale per area saying what belongs there.
- Use the exact code names given.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

export type ClusterKind = "usage" | "areas";
const promptFor = (kind: ClusterKind) => (kind === "areas" ? AREAS_SYSTEM : SYSTEM);

export const estimateClusterTokens = (codes: MergeCodeInput[], r: Redaction, kind: ClusterKind = "usage") =>
  estimateTokens(promptFor(kind)) + estimateTokens(renderMergePayload(codes, r));

const SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "short group name, sentence case" },
          codes: { type: "array", items: { type: "string" }, description: "exact code names" },
          rationale: { type: "string", description: "one sentence: the shared usage and the evidence" },
        },
        required: ["name", "codes", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
} as const;

export async function clusterCodes(opts: {
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction;
  kind?: ClusterKind; signal?: AbortSignal;
}): Promise<{ groups: ClusterGroup[]; usage: Usage }> {
  const { data, usage } = await callJson<{ groups: ClusterGroup[] }>({
    key: opts.key,
    model: opts.model,
    system: promptFor(opts.kind ?? "usage"),
    user: renderMergePayload(opts.codes, opts.redaction),
    schemaName: "cluster_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return { groups: sanitizeClusterReply(opts.codes, data.groups ?? [], opts.redaction), usage };
}

// The trust boundary, testable without the network: only codes we actually sent
// count, a code lands in at most one group (first mention wins), groups that end
// up with fewer than 2 real codes drop, and redaction placeholders are restored
// in the human-facing name and rationale.
export function sanitizeClusterReply(
  codes: MergeCodeInput[],
  reply: ClusterGroup[],
  r?: Redaction,
): ClusterGroup[] {
  const known = new Set(codes.map((c) => c.name));
  const taken = new Set<string>();
  const out: ClusterGroup[] = [];
  for (const g of reply) {
    const members = (g.codes ?? [])
      .map((c) => (c ?? "").trim())
      .filter((c) => known.has(c) && !taken.has(c));
    if (members.length < 2) continue;
    members.forEach((c) => taken.add(c));
    out.push({
      name: restore(r, (g.name ?? "").trim()) || `Group ${out.length + 1}`,
      codes: members,
      rationale: restore(r, (g.rationale ?? "").trim()),
    });
  }
  return out;
}
