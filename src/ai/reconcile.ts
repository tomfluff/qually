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

NAMING CONVENTION: any name you propose ("newName", or a rename's new name) must follow the conventions already visible in this codebook — above all its capitalization (all-lowercase, Sentence case, Title Case, or ALL CAPS), and also its phrasing style (noun phrase vs gerund vs full clause), its length, and its punctuation (hyphens, slashes, ampersands). Match the codes in the cluster you are naming first, then the codebook as a whole. A proposed name that reads as a different style from the researcher's own names is wrong even when its wording is better.

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
  const clusterNames = new Set(clusters.flatMap((c) => (c.newName ? [norm(c.newName)] : [])));
  const actions = sanitizeActions(opts.codes, data.actions ?? [], opts.redaction, clusterNames)
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
    // exact equality only: a case/whitespace variant of the survivor's own
    // name is a legitimate rename, not a no-op
    if (newName === survivor) newName = undefined;
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
// A rename whose target norm-collides with another sent code, a name in
// `avoid` (normed: e.g. context codes, fresh cluster newNames), or an earlier
// rename in the same reply is dropped — applying it would silently become a
// merge, which must always ride an explicit reviewed cluster.
export function sanitizeActions(
  codes: MergeCodeInput[],
  reply: CodeAction[],
  r?: Redaction,
  avoid?: Set<string>,
): CodeAction[] {
  const known = new Set(codes.map((c) => c.name));
  const seen = new Set<string>();
  const grantedNames = new Set<string>();
  const out: CodeAction[] = [];
  for (const a of reply) {
    const code = (a.code ?? "").trim();
    if (!known.has(code) || seen.has(code)) continue;
    const newName = restore(r, (a.newName ?? "").trim());
    const rationale = restore(r, (a.rationale ?? "").trim());
    if (a.action === "rename") {
      if (!newName || newName === code) continue;
      const n = norm(newName);
      if ([...known].some((k) => k !== code && norm(k) === n)) continue;
      if (avoid?.has(n) || grantedNames.has(n)) continue;
      grantedNames.add(n);
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

// ---------------------------------------------------------------------------
// FOCUS reconcile: the researcher selects a handful of codes and asks where
// they belong — against the WHOLE codebook. Asymmetric evidence keeps the
// payload honest per token: focus codes carry up to 8 excerpts, every other
// code rides along as context with its definition and 2 excerpts. Focus and
// context stay in separate, stably-ordered sections (long-context position
// bias). The model must echo every focus code in reviewedFocus so silence is
// never ambiguous.
const FOCUS_SYSTEM = `You are helping a qualitative researcher consolidate a first-cycle inductive codebook. The payload has two sections: FOCUS CODES — the codes under review — and CONTEXT CODEBOOK — every other code, as merge targets and context only.

Propose dispositions ONLY for focus codes. A merge cluster must contain at least one focus code and may include context codes as members or survivor when the evidence shows the SAME concept. "rename" and "remove" apply to focus codes only. Most focus codes should come back unchanged — this is consolidation, not rewriting; when in doubt, keep.

List EVERY focus code exactly once in reviewedFocus, whether or not you propose anything for it. Use the exact code names given. One sentence of rationale naming the evidence for each proposal. A code appears in at most one cluster. "remove" REJECTS a code's excerpts rather than deleting them; propose it sparingly, and never based on thin sampling alone.

NAMING CONVENTION: any name you propose must follow the conventions already visible in this codebook — above all its capitalization (all-lowercase, Sentence case, Title Case, or ALL CAPS), and also its phrasing style, length, and punctuation. Match the codes in the cluster you are naming first, then the codebook as a whole. A proposed name in a different style from the researcher's own names is wrong even when its wording is better.

Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;

export const renderFocusPayload = (
  focus: MergeCodeInput[], context: MergeCodeInput[], r: Redaction,
): string =>
  `FOCUS CODES (propose dispositions for these only):\n\n${renderMergePayload(focus, r)}\n\nCONTEXT CODEBOOK (merge targets and context only):\n\n${renderMergePayload(context, r)}`;

export const estimateFocusTokens = (focus: MergeCodeInput[], context: MergeCodeInput[], r: Redaction) =>
  estimateTokens(FOCUS_SYSTEM) + estimateTokens(renderFocusPayload(focus, context, r));

const FOCUS_SCHEMA = {
  type: "object",
  properties: {
    reviewedFocus: { type: "array", items: { type: "string" }, description: "every focus code name, exactly once" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          survivor: { type: "string" },
          codes: { type: "array", items: { type: "string" } },
          newName: { type: "string" },
          rationale: { type: "string" },
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
          code: { type: "string" },
          action: { type: "string", enum: ["rename", "remove"] },
          newName: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["code", "action", "newName", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviewedFocus", "clusters", "actions"],
  additionalProperties: false,
} as const;

export async function reconcileFocus(opts: {
  key: string; model: string;
  focus: MergeCodeInput[]; context: MergeCodeInput[];
  redaction: Redaction; mode?: ReconcileMode; signal?: AbortSignal;
}): Promise<{ plan: ReconcilePlan; reviewed: string[]; unreviewed: string[]; usage: Usage }> {
  const consolidate = (opts.mode ?? "consolidate") === "consolidate";
  const { data, usage } = await callJson<{ reviewedFocus: string[]; clusters: ClusterProposal[]; actions: CodeAction[] }>({
    key: opts.key,
    model: opts.model,
    system: consolidate ? FOCUS_SYSTEM + CONSOLIDATE_SUFFIX : FOCUS_SYSTEM,
    user: renderFocusPayload(opts.focus, opts.context, opts.redaction),
    schemaName: "reconcile_focus",
    schema: FOCUS_SCHEMA,
    signal: opts.signal,
  });
  const focusNames = new Set(opts.focus.map((c) => c.name));
  const all = [...opts.focus, ...opts.context];
  const clusters = sanitizeFocusClusters(all, focusNames, data.clusters ?? [], opts.redaction);
  const clustered = new Set(clusters.flatMap((c) => c.codes));
  // a rename landing on ANY other code in the book (or a name a fresh cluster
  // claims) would apply as a silent merge — reject at the boundary
  const avoid = new Set([
    ...opts.context.map((c) => norm(c.name)),
    ...clusters.flatMap((c) => (c.newName ? [norm(c.newName)] : [])),
  ]);
  const actions = sanitizeActions(opts.focus, data.actions ?? [], opts.redaction, avoid)
    .filter((a) => focusNames.has(a.code) && !clustered.has(a.code))
    .filter((a) => !consolidate || a.action !== "remove");
  // "exactly once" is the invariant: an omitted OR duplicated echo marks the
  // code unreviewed, and only the exactly-once set may replace pending work
  const echoCounts = new Map<string, number>();
  for (const x of data.reviewedFocus ?? []) {
    const t = (x ?? "").trim();
    echoCounts.set(t, (echoCounts.get(t) ?? 0) + 1);
  }
  const reviewed = [...focusNames].filter((f) => echoCounts.get(f) === 1);
  const unreviewed = [...focusNames].filter((f) => echoCounts.get(f) !== 1);
  return { plan: { clusters, actions }, reviewed, unreviewed, usage };
}

// Focus clusters, the stricter boundary (codex-reviewed rules): members must
// be real codes anywhere in the book; every cluster contains at least one
// focus code (context-only clusters drop); an invalid survivor DROPS the
// cluster — no first-member fallback, which would bias toward destruction;
// one cluster per code globally; a newName colliding with an outside code
// drops the newName.
export function sanitizeFocusClusters(
  all: MergeCodeInput[],
  focus: Set<string>,
  reply: ClusterProposal[],
  r?: Redaction,
): ClusterProposal[] {
  const known = new Set(all.map((c) => c.name));
  const taken = new Set<string>();
  const out: ClusterProposal[] = [];
  for (const c of reply) {
    const members = [...new Set((c.codes ?? []).map((x) => (x ?? "").trim()))]
      .filter((x) => known.has(x) && !taken.has(x));
    if (members.length < 2) continue;
    if (!members.some((m) => focus.has(m))) continue;
    const survivor = (c.survivor ?? "").trim();
    if (!members.includes(survivor)) continue;
    members.forEach((x) => taken.add(x));
    let newName: string | undefined = restore(r, (c.newName ?? "").trim()) || undefined;
    if (newName === survivor) newName = undefined;
    if (newName) {
      const outside = all.map((x) => x.name).filter((n) => !members.includes(n));
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

// Landing a focus run into a pending plan (codex-reviewed): the conflict set
// is the reviewed focus PLUS every code the fresh output touches (cluster
// members AND action targets — a proposal for a code the model forgot to echo
// must still evict the old one, or two live actions land on one code). An
// unreviewed focus code stays OUT of the conflict set so its pending work
// survives the model's oversight. Pending clusters are atomic: they drop
// whole, never lose just a member.
export function mergeFocusResults(
  pendingClusters: ClusterProposal[],
  pendingActions: CodeAction[],
  fresh: ReconcilePlan,
  reviewedFocus: Set<string>,
): { clusters: ClusterProposal[]; actions: CodeAction[]; replaced: number } {
  const freshMembers = new Set([
    ...fresh.clusters.flatMap((c) => c.codes),
    ...fresh.actions.map((a) => a.code),
  ]);
  const conflict = new Set([...reviewedFocus, ...freshMembers]);
  const keptClusters = pendingClusters.filter((c) => !c.codes.some((code) => conflict.has(code)));
  const keptActions = pendingActions.filter((a) => !conflict.has(a.code));
  return {
    clusters: [...keptClusters, ...fresh.clusters],
    actions: [...keptActions, ...fresh.actions],
    replaced: (pendingClusters.length - keptClusters.length) + (pendingActions.length - keptActions.length),
  };
}
