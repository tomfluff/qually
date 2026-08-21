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

export const estimateClusterTokens = (codes: MergeCodeInput[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderMergePayload(codes, r));

const SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "2-4 word group name, sentence case" },
          codes: { type: "array", items: { type: "string" }, description: "exact code names, 2-8 per group" },
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
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ groups: ClusterGroup[]; usage: Usage }> {
  const { data, usage } = await callJson<{ groups: ClusterGroup[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
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
