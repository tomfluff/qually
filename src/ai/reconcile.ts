// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Codebook reconciliation for the Code map: one pass proposes merge-CLUSTERS
// (2+ codes that are ONE concept — survivor plus members, optionally renamed)
// and per-code renames/rejects, grounded in second-cycle coding practice.
// Calibration matters more than coverage: effective codes each do distinct
// analytic work, so consolidation removes redundancy (splinters, near-
// synonyms) and NEVER richness — on a soundly coded book most codes come back
// untouched. The AI only PROPOSES; every disposition is reviewed on the map
// and applied by the researcher through undoable actions. "Remove" rejects a
// code's excerpts; it never deletes data.
import { callJson, estimateTokens, type Usage } from "./openai";
import { restore, type Redaction } from "./redact";
import { renderMergePayload, type MergeCodeInput } from "./dedupe";
import { norm } from "../contract/segments";

export interface CodeAction {
  code: string;
  action: "rename" | "merge" | "remove"; // "merge" is legacy: loaded, never emitted
  newName?: string;
  into?: string;
  rationale: string;
}
export interface ClusterProposal { survivor: string; codes: string[]; newName?: string; rationale: string }
export interface ReconcilePlan { clusters: ClusterProposal[]; actions: CodeAction[] }

const SYSTEM = `You are helping a qualitative researcher consolidate a first-cycle inductive codebook so it is ready for reflexive thematic analysis. Each entry has a code name, an optional definition, and sample excerpts the researcher coded with it. Propose a revision plan in two parts:

PART 1 — MERGE CLUSTERS. A cluster is a set of 2 or more codes that are THE SAME CONCEPT — near-synonyms, splinters of one idea, duplicates under different labels. For each cluster name the "survivor" (the member with the better evidence and clearer name), and give "newName" ONLY when the merged concept deserves a clearer name than the survivor's. One sentence of rationale naming the evidence.
Calibration: this is redundancy detection, NOT thematic grouping. Codes that are merely related, adjacent, or under the same theme are NOT a cluster — a cluster's members' excerpts could swap labels without anyone noticing. Most clusters have 2-3 members; a cluster of 5+ should be rare and obviously justified. On a well-coded book MOST codes belong to no cluster at all — that is the expected, good outcome. When in doubt, do not cluster.

PART 2 — PER-CODE ACTIONS on codes that are in no cluster:
- "rename": the name misdescribes what the excerpts show, or is too vague to find again. Give a clearer, specific name (sentence case, concise).
- "remove": the code carries no analytic value (an artifact, a stray, fully covered elsewhere with nothing of its own). Removal REJECTS the code's excerpts rather than deleting them; propose it sparingly — a thin code that still says something unique is a keep.
- Codes that are fine get NO action. Most codes should get no action.

Every cluster and action needs one sentence of rationale naming the evidence. Use the exact code names given. A code appears in at most one cluster, and a clustered code gets no separate action.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

// the phased pass: consolidation first (merge clusters and renames only, no
// removals), the full revision when the researcher asks for it
export type ReconcileMode = "consolidate" | "full";
const CONSOLIDATE_SUFFIX = `

PHASE: consolidation only. Propose ONLY clusters and "rename" actions — no "remove". Removal decisions come in a later pass.`;

export const estimateReconcileTokens = (codes: MergeCodeInput[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderMergePayload(codes, r));

const SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          survivor: { type: "string", description: "exact name of the member to keep" },
          codes: { type: "array", items: { type: "string" }, description: "exact names of ALL members including the survivor, 2+ per cluster" },
          newName: { type: "string", description: "optional clearer name for the merged concept; empty to keep the survivor's name" },
          rationale: { type: "string", description: "one sentence: the shared concept and the evidence" },
        },
        required: ["survivor", "codes", "newName", "rationale"],
        additionalProperties: false,
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "exact name of the code this disposition is about" },
          action: { type: "string", enum: ["rename", "remove"] },
          newName: { type: "string", description: "rename: the clearer name; else empty" },
          rationale: { type: "string", description: "one sentence naming the evidence" },
        },
        required: ["code", "action", "newName", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["clusters", "actions"],
  additionalProperties: false,
} as const;

export async function reconcileCodes(opts: {
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction;
  mode?: ReconcileMode; signal?: AbortSignal;
}): Promise<{ plan: ReconcilePlan; usage: Usage }> {
  const consolidate = (opts.mode ?? "consolidate") === "consolidate";
  const { data, usage } = await callJson<{ clusters: ClusterProposal[]; actions: CodeAction[] }>({
    key: opts.key,
    model: opts.model,
    system: consolidate ? SYSTEM + CONSOLIDATE_SUFFIX : SYSTEM,
    user: renderMergePayload(opts.codes, opts.redaction),
    schemaName: "reconcile_codes",
    schema: SCHEMA,
    signal: opts.signal,
  });
  const clusters = sanitizeClusters(opts.codes, data.clusters ?? [], opts.redaction);
  const clustered = new Set(clusters.flatMap((c) => c.codes));
  const actions = sanitizeActions(opts.codes, data.actions ?? [], opts.redaction)
    // a clustered code gets no separate action; consolidation never removes
    .filter((a) => !clustered.has(a.code))
    .filter((a) => !consolidate || a.action !== "remove");
  return { plan: { clusters, actions }, usage };
}

// The cluster trust boundary (doc invariants, testable without the network):
// members must be real codes we sent; a code lands in at most one cluster
// (first wins); the survivor must be one of the members (else first member);
// a newName that norm-collides with any surviving code outside the cluster is
// dropped (the cluster keeps the survivor's name); clusters below 2 valid
// members drop; redactions restored in names and rationales.
export function sanitizeClusters(
  codes: MergeCodeInput[],
  reply: ClusterProposal[],
  r?: Redaction,
): ClusterProposal[] {
  const known = new Set(codes.map((c) => c.name));
  const taken = new Set<string>();
  const out: ClusterProposal[] = [];
  for (const c of reply) {
    const members = [...new Set((c.codes ?? []).map((x) => (x ?? "").trim()))]
      .filter((x) => known.has(x) && !taken.has(x));
    if (members.length < 2) continue;
    const survivor = members.includes((c.survivor ?? "").trim()) ? (c.survivor ?? "").trim() : members[0];
    members.forEach((x) => taken.add(x));
    let newName: string | undefined = restore(r, (c.newName ?? "").trim()) || undefined;
    if (newName && norm(newName) === norm(survivor)) newName = undefined;
    // collision with a code that survives OUTSIDE this cluster -> keep survivor's name
    if (newName) {
      const outside = codes.map((x) => x.name).filter((n) => !members.includes(n));
      if (outside.some((n) => norm(n) === norm(newName!))) newName = undefined;
    }
    out.push({
      survivor, codes: members,
      ...(newName ? { newName } : {}),
      rationale: restore(r, (c.rationale ?? "").trim()),
    });
  }
  return out;
}

// Per-code actions: only codes we sent, one action per code, renames need a
// usable new name; "merge" never comes back from the model (legacy loads only).
export function sanitizeActions(
  codes: MergeCodeInput[],
  reply: CodeAction[],
  r?: Redaction,
): CodeAction[] {
  const known = new Set(codes.map((c) => c.name));
  const seen = new Set<string>();
  const out: CodeAction[] = [];
  for (const a of reply) {
    const code = (a.code ?? "").trim();
    if (!known.has(code) || seen.has(code)) continue;
    const newName = restore(r, (a.newName ?? "").trim());
    const rationale = restore(r, (a.rationale ?? "").trim());
    if (a.action === "rename") {
      if (!newName || newName === code) continue;
      seen.add(code);
      out.push({ code, action: "rename", newName, rationale });
    } else if (a.action === "remove") {
      seen.add(code);
      out.push({ code, action: "remove", rationale });
    }
  }
  return out;
}

// Island-scoped reruns merge into the pending state: pending clusters that
// intersect the scoped subset are replaced by the new proposals (doc rule).
export function mergeScopedClusters(
  pending: ClusterProposal[],
  subset: Set<string>,
  fresh: ClusterProposal[],
): ClusterProposal[] {
  return [...pending.filter((c) => !c.codes.some((x) => subset.has(x))), ...fresh];
}

// The halo's "describe this group": one small request, two plain sentences of
// what the group means. Default model, minimal ceremony — the map confirms
// with a one-line cost note instead of the full consent modal (the payload is
// the same shape the reconcile run already discloses).
const GLIMPSE_SYSTEM = `You are helping a qualitative researcher revise a codebook. The codes below are proposed to merge into one. In TWO sentences, plain language: what kind of moment do these codes mark, and what unites their excerpts? This is a glimpse for the researcher deciding the merge — describe the shared usage, do not evaluate the merge. Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;
const GLIMPSE_SCHEMA = {
  type: "object",
  properties: { glimpse: { type: "string", description: "two plain sentences" } },
  required: ["glimpse"], additionalProperties: false,
} as const;

export const estimateGlimpseTokens = (codes: MergeCodeInput[], r: Redaction) =>
  estimateTokens(GLIMPSE_SYSTEM) + estimateTokens(renderMergePayload(codes, r));

export async function glimpseCluster(opts: {
  key: string; model: string; codes: MergeCodeInput[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ glimpse: string; usage: Usage }> {
  const { data, usage } = await callJson<{ glimpse: string }>({
    key: opts.key,
    model: opts.model,
    system: GLIMPSE_SYSTEM,
    user: renderMergePayload(opts.codes, opts.redaction),
    schemaName: "glimpse_group",
    schema: GLIMPSE_SCHEMA,
    signal: opts.signal,
  });
  return { glimpse: restore(opts.redaction, (data.glimpse ?? "").trim()), usage };
}
