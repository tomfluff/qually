// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Codebook reconciliation for the Code map: one pass that proposes BOTH the
// similarity islands and a per-code revision plan (rename / merge / remove),
// grounded in second-cycle coding practice — consolidating a first-cycle
// inductive codebook so reflexive thematic analysis can build themes from
// clean, well-evidenced codes. The AI only PROPOSES; every disposition is
// reviewed on the map and applied (or skipped) by the researcher through the
// existing undoable actions. "Remove" never deletes data: it rejects the
// code's excerpts, which stay in the project file.
import { callJson, estimateTokens, type Usage } from "./openai";
import { restore, type Redaction } from "./redact";
import { renderMergePayload, type MergeCodeInput } from "./dedupe";
import { sanitizeClusterReply, type ClusterGroup } from "./cluster";

export interface CodeAction {
  code: string;
  action: "rename" | "merge" | "remove";
  newName?: string;   // rename: the clearer name; merge: optional name for the merged concept
  into?: string;      // merge: the code to fold into
  rationale: string;
}
export interface ReconcilePlan { groups: ClusterGroup[]; actions: CodeAction[] }

const SYSTEM = `You are helping a qualitative researcher consolidate a first-cycle inductive codebook so it is ready for reflexive thematic analysis. Each entry has a code name, an optional definition, and sample excerpts the researcher coded with it. You do two jobs in one pass:

JOB 1 — GROUP by usage similarity. Partition the codes into groups of similar usage: codes that mark the same kind of moment, target the same topic with the same analytic intent, or substantially overlap in application. Aim for HIGH coverage — most codes belong somewhere; leave a code out only when it is genuinely unlike everything else. Groups have 2 to 8 codes, every code in at most one group, names of 2-4 plain words (sentence case), one sentence of rationale each. This is usage grouping, not thematic hierarchy: the excerpts are the strongest evidence, then definitions, then names.

JOB 2 — REVISE. Propose per-code dispositions that reduce noise while keeping every analytic insight reachable:
- "rename": the name misdescribes what the excerpts show, or is too vague/verbose to find again. Give a clearer, specific name (sentence case, concise).
- "merge": the code duplicates or splinters another code's concept. Name the code to keep in "into" (prefer the better-evidenced, better-named side). If the merged concept deserves a clearer name than either, also give "newName".
- "remove": the code carries no analytic value (an artifact, a stray, fully covered elsewhere with nothing of its own). Removal REJECTS the code's excerpts rather than deleting them, but propose it sparingly — a thin code that still says something unique is a keep, not a remove.
- Codes that are fine as they are get NO action. Most codes should get no action; this is consolidation, not rewriting.

Every action needs one sentence of rationale naming the evidence (what the excerpts show). Use the exact code names given. Never chain merges (if A merges into B, give B no action other than possibly "rename").

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

export const estimateReconcileTokens = (codes: MergeCodeInput[], r: Redaction) =>
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
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "exact name of the code this disposition is about" },
          action: { type: "string", enum: ["rename", "merge", "remove"] },
          newName: { type: "string", description: "rename: the clearer name; merge: optional name for the merged concept; else empty" },
          into: { type: "string", description: "merge: exact name of the code to keep; else empty" },
          rationale: { type: "string", description: "one sentence naming the evidence" },
        },
        required: ["code", "action", "newName", "into", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups", "actions"],
  additionalProperties: false,
} as const;

export async function reconcileCodes(opts: {
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ plan: ReconcilePlan; usage: Usage }> {
  const { data, usage } = await callJson<{ groups: ClusterGroup[]; actions: CodeAction[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderMergePayload(opts.codes, opts.redaction),
    schemaName: "reconcile_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  return {
    plan: {
      groups: sanitizeClusterReply(opts.codes, data.groups ?? [], opts.redaction),
      actions: sanitizeActions(opts.codes, data.actions ?? [], opts.redaction),
    },
    usage,
  };
}

// The trust boundary, testable without the network: only codes we sent get
// actions, one action per code, merge targets must be real codes that are not
// themselves merge sources (no chains), renames need a usable new name, and
// redaction placeholders are restored in everything human-facing.
export function sanitizeActions(
  codes: MergeCodeInput[],
  reply: CodeAction[],
  r?: Redaction,
): CodeAction[] {
  const known = new Set(codes.map((c) => c.name));
  const seen = new Set<string>();
  const first: CodeAction[] = [];
  for (const a of reply) {
    const code = (a.code ?? "").trim();
    if (!known.has(code) || seen.has(code)) continue;
    const newName = restore(r, (a.newName ?? "").trim());
    const into = (a.into ?? "").trim();
    const rationale = restore(r, (a.rationale ?? "").trim());
    if (a.action === "rename") {
      if (!newName || newName === code) continue;
      seen.add(code);
      first.push({ code, action: "rename", newName, rationale });
    } else if (a.action === "merge") {
      if (!known.has(into) || into === code) continue;
      seen.add(code);
      first.push({ code, action: "merge", into, ...(newName && newName !== into ? { newName } : {}), rationale });
    } else if (a.action === "remove") {
      seen.add(code);
      first.push({ code, action: "remove", rationale });
    }
  }
  // no chains: a merge target must not itself be a merge source
  const sources = new Set(first.filter((a) => a.action === "merge").map((a) => a.code));
  return first.filter((a) => a.action !== "merge" || !sources.has(a.into!));
}
