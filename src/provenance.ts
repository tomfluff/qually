// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Whose codebook is this? Derived from the decision ledger, never stored on the
// code — a field would go stale the first time a rename slipped past it, and
// the ledger already knows. Replaying it forward also survives the case a
// stored field cannot: a code renamed by hand AFTER an accepted proposal keeps
// the proposal in its history rather than laundering it as the researcher's own.
//
// Three states, and the third is the one a reviewer asks about:
//   untouched — the name you first wrote, never merged into, never renamed
//   you       — you renamed it, or merged something into it yourself
//   ai        — its current identity came through a proposal you accepted
// "ai" is sticky: once a proposal shaped a code, later hand-work does not
// unshape it. Accepting a good proposal is a decision, not a confession — the
// point of the number is that it is visible, not that it is small.
import { AI_PROPOSED_BY_PREFIX, type AiCall, type Decision, type Segment } from "./state/store";
import type { Stretch } from "./stretches";

type Origin = "untouched" | "you" | "ai";

/** current code name -> how it got that way. Only names still in the book. */
export function codeOrigins(ledger: Decision[], codes: string[]): Map<string, Origin> {
  const state = new Map<string, Origin>();
  for (const d of ledger) {
    if (d.undone) continue;
    const mark = (name: string, o: Origin) => {
      if (state.get(name) === "ai") return; // sticky
      state.set(name, o);
    };
    const o: Origin = d.source === "ai" ? "ai" : "you";
    if (d.kind === "rename") {
      const [now, before] = d.codes;
      if (!now) continue;
      // the history follows the name: a code renamed twice keeps the first
      // rename's provenance, so an accepted proposal cannot be renamed away
      if (before && state.get(before) === "ai") state.set(now, "ai");
      else if (before && state.has(before)) state.set(now, state.get(before)!);
      if (before) state.delete(before);
      mark(now, o);
    } else if (d.kind === "merge") {
      // survivor first, then EVERY folded member — a multi-member capsule
      // (applyCluster) writes [kept, ...members], and skipping members 3..n
      // would drop their AI provenance on the floor
      const [survivor, ...from] = d.codes;
      if (!survivor) continue;
      for (const f of from) {
        if (state.get(f) === "ai") state.set(survivor, "ai");
        state.delete(f);
      }
      mark(survivor, o);
    }
  }
  const out = new Map<string, Origin>();
  for (const c of codes) out.set(c, state.get(c) ?? "untouched");
  return out;
}

export interface OriginCounts { untouched: number; you: number; ai: number; total: number }

export function originCounts(ledger: Decision[], codes: string[]): OriginCounts {
  const m = codeOrigins(ledger, codes);
  const out: OriginCounts = { untouched: 0, you: 0, ai: 0, total: codes.length };
  for (const o of m.values()) out[o]++;
  return out;
}

/** every ledger row that names this code, oldest first — the code's own history */
export function historyOf(ledger: Decision[], code: string): Decision[] {
  // walk BACKWARDS through the names this code has had, so a renamed code still
  // shows what happened to it under its old name
  const names = new Set([code]);
  const rows: Decision[] = [];
  for (let i = ledger.length - 1; i >= 0; i--) {
    const d = ledger[i];
    // Section labels share Decision.codes only as an export/display carrier.
    // They are not code identities, even when a code happens to have the same
    // dimension:value spelling.
    if (d.kind === "accept-section" || d.kind === "reject-section" || d.kind === "discard-section") continue;
    if (!d.codes.some((c) => names.has(c))) continue;
    rows.unshift(d);
    if ((d.kind === "rename" || d.kind === "merge") && names.has(d.codes[0])) {
      // a merge may have folded SEVERAL names in — follow all of them
      for (const c of d.codes.slice(1)) names.add(c);
    }
  }
  return rows;
}

const sameCodes = (a: string[], b: string[]) =>
  a.length === b.length && a.every((code, i) => code === b[i]);

const FOLDABLE_DECISIONS = new Set<Decision["kind"]>([
  "accept-coding", "reject-coding", "discard-coding",
  "accept-section", "reject-section", "discard-section",
]);

/** Compact only neighbouring repetitions for reading. The raw ledger remains
    append-only because undo identifies a gesture by the ledger length captured
    before it, and exports need one exact row per decision. */
export function foldDecisions(ledger: Decision[]): Decision[] {
  const folded: Decision[] = [];
  for (const d of ledger) {
    const prev = folded[folded.length - 1];
    if (prev && FOLDABLE_DECISIONS.has(d.kind)
      && prev.kind === d.kind && sameCodes(prev.codes, d.codes)
      && prev.source === d.source && prev.model === d.model
      && prev.now === d.now && prev.blind === d.blind
      && prev.why === d.why
      && !!prev.undone === !!d.undone) {
      folded[folded.length - 1] = {
        ...d,
        moved: (prev.moved ?? 0) + (d.moved ?? 0),
        at: d.at,
      };
    } else {
      folded.push({ ...d });
    }
  }
  return folded;
}

const CODEBOOK_DECISIONS = new Set<Decision["kind"]>([
  "merge", "rename", "remove", "delete", "keep", "park", "unpark", "dismiss", "define",
]);

export interface CurrentDisposition {
  segments: Pick<Segment, "status" | "proposedBy">[];
  stretches: Pick<Stretch, "status" | "proposedBy">[];
}

// Hand-edited project files reach both functions below, and a value of the
// wrong type must read as nothing rather than throw inside render.
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** What became of what a model proposed. Four states, and the fourth is the one
    a corpus count alone cannot see: a discarded proposal is GONE from segments
    and stretches, so only the ledger still knows it was ever offered. */
export interface ProposalCounts {
  accepted: number; rejected: number; waiting: number; discarded: number; total: number;
}

/** The proposals of ONE kind — codings (segments) or sections (stretches) —
    counted from the corpus as it stands now, plus the discards only history
    remembers. The Decisions panel shows these; methodsParagraph writes the same
    numbers into prose, from this one function, so the two cannot drift. */
export function proposalCounts(
  ledger: Decision[],
  items: readonly { status?: string; proposedBy?: string }[],
  discardKind: Decision["kind"],
): ProposalCounts {
  // typeof, not `?.startsWith`: a hand-edited file can put a number here, and
  // `(42)?.startsWith` throws inside render — the permanent-white-screen class.
  const proposed = items.filter((x) => typeof x.proposedBy === "string"
    && x.proposedBy.startsWith(AI_PROPOSED_BY_PREFIX));
  const n = (status: string) => proposed.filter((x) => x.status === status).length;
  // `moved` is how many one gesture cleared; a row written before that field
  // existed cleared one. Undone discards are not discards. num() for the same
  // reason as above: a string "3" here would concatenate into "03" and carry a
  // NaN through every percentage drawn from the total.
  const discarded = ledger
    .filter((d) => !d.undone && d.source === "ai" && d.kind === discardKind)
    .reduce((sum, d) => sum + (d.moved === undefined ? 1 : num(d.moved)), 0);
  const accepted = n("accepted"), rejected = n("rejected"), waiting = n("candidate");
  return { accepted, rejected, waiting, discarded,
    total: accepted + rejected + waiting + discarded };
}

/** What the model has cost, added up from the AI log. Every field is read
    defensively: a project file is hand-editable, and a string where a number
    belongs must read as nothing rather than throw inside render. */
export interface AiSpend {
  calls: number; unfinished: number; inTok: number; outTok: number; costUsd: number;
  /** of inTok, how many the API served from its prompt cache — a subset, and 0
      where no row recorded it (every row written before it was logged) */
  cachedTok: number;
  /** of inTok, how many were written to the cache — billed at 1.25x */
  writeTok: number;
}
export function aiSpend(log: readonly AiCall[]): AiSpend {
  // parseProject fills a missing aiLog with [] but does not check that a
  // present one IS a list; iterating a number throws where the panel renders.
  const rows = Array.isArray(log) ? log : [];
  const out: AiSpend = { calls: rows.length, unfinished: 0, inTok: 0, outTok: 0, cachedTok: 0, writeTok: 0, costUsd: 0 };
  for (const c of rows) {
    // aborted and failed both DISPATCHED — the transcript went out either way,
    // and the API may have charged for it while reporting nothing back
    if (c.outcome === "aborted" || c.outcome === "failed") out.unfinished++;
    out.inTok += num(c.inTok);
    out.outTok += num(c.outTok);
    out.cachedTok += num(c.cachedTok);
    out.writeTok += num(c.writeTok);
    out.costUsd += num(c.costUsd);
  }
  return out;
}

// The paragraph a methods section needs, written from the record rather than by
// a model: it is a claim about the researcher's own conduct, so nothing else may
// author it. The panel shows this draft read-only for copying elsewhere.
export function methodsParagraph(
  ledger: Decision[], codes: string[], { segments, stretches }: CurrentDisposition,
): string {
  const live = ledger.filter((d) => !d.undone);
  // Coding and section verdicts describe how evidence was settled, not how the
  // codebook was consolidated. Keeping this slice explicit prevents a large AI
  // suggestion run from inflating the code-identity claims below.
  const book = live.filter((d) => CODEBOOK_DECISIONS.has(d.kind));
  const n = (k: Decision["kind"]) => book.filter((d) => d.kind === k).length;
  const fromAi = book.filter((d) => d.source === "ai").length;
  const fromWording = book.filter((d) => d.source === "wording").length;
  const models = [...new Set(book.filter((d) => d.model).map((d) => d.model!))];
  const undone = ledger.filter((d) => d.undone).length;
  // Verdict rows are history and can contain several answers for one proposal.
  // The methods claim is about the corpus now, so a proposal accepted and later
  // deleted rightly drops out: an excerpt absent from the corpus is not accepted
  // or rejected in the analysis as it stands. Discards are the exception the
  // count above cannot see, and proposalCounts folds them back in from history.
  const codings = proposalCounts(ledger, segments, "discard-coding");
  const sections = proposalCounts(ledger, stretches, "discard-section");
  const bits: string[] = [];
  // "consolidated" is a claim about work done to the codebook, and the ledger can
  // only support it when it holds codebook decisions. A book that was never merged
  // or renamed still HAS a size, so state the size and claim nothing about how it
  // got there — a project coded entirely from proposals reaches exactly that case.
  bits.push(book.length
    ? `The first author consolidated the codebook to ${codes.length} code${codes.length === 1 ? "" : "s"}.`
    // "working": the count excludes codes set aside, and with no park decision in
    // the ledger there is no "M set aside" clause below to explain the shortfall.
    : `The working codebook holds ${codes.length} code${codes.length === 1 ? "" : "s"}.`);
  const acts: string[] = [];
  if (n("merge")) acts.push(`${n("merge")} merge${n("merge") === 1 ? "" : "s"}`);
  if (n("rename")) acts.push(`${n("rename")} rename${n("rename") === 1 ? "" : "s"}`);
  if (n("remove")) acts.push(`${n("remove")} code${n("remove") === 1 ? "" : "s"} withdrawn from the analysis`);
  if (n("delete")) acts.push(`${n("delete")} deletion${n("delete") === 1 ? "" : "s"}`);
  if (n("park")) acts.push(`${n("park")} code${n("park") === 1 ? "" : "s"} set aside`);
  // "1 merge were applied" — the verb follows how many decisions there were,
  // not how many kinds of them
  const applied = n("merge") + n("rename") + n("remove") + n("delete") + n("park");
  if (acts.length) bits.push(`${acts.join(", ")} ${applied === 1 ? "was" : "were"} applied.`);
  if (fromWording) {
    bits.push(`${fromWording} of these began as an offline wording match computed on the researcher's machine.`);
  }
  if (fromAi) {
    bits.push(`${fromAi} began as a proposal from a large language model${models.length ? ` (${models.join(", ")})` : ""}, `
      + `run against the researcher's own key; the model applied nothing and every proposal was accepted, edited or rejected by hand.`);
  } else if (book.length) {
    bits.push("No language model proposed any of them.");
  }
  // the number the question "did the model shape your analysis" actually wants
  const blind = book.filter((d) => d.blind);
  if (blind.length) {
    const agreed = blind.filter((d) => d.blind === "agreed").length;
    bits.push(`On ${blind.length} proposal${blind.length === 1 ? "" : "s"} the researcher recorded a verdict `
      + `before seeing the model's, agreeing with it on ${agreed} and differing on ${blind.length - agreed}.`);
  }
  // "accepted 0 codings and rejected 1" is true but reads as filler in a methods
  // section, so a side with nothing on it is left out rather than stated as zero.
  // Both sides present keeps the pair, because there the contrast is the point.
  const standing = (noun: string, d: { accepted: number; rejected: number }) => {
    const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    if (d.accepted && d.rejected) {
      return `In the analysis as it stands, the first author has accepted ${plural(d.accepted)} `
        + `proposed by a language model and rejected ${d.rejected}.`;
    }
    const n = d.accepted || d.rejected;
    return `In the analysis as it stands, the first author has ${d.accepted ? "accepted" : "rejected"} `
      + `${plural(n)} proposed by a language model.`;
  };
  if (codings.accepted || codings.rejected) bits.push(standing("coding", codings));
  if (sections.accepted || sections.rejected) bits.push(standing("section", sections));
  if (codings.discarded) bits.push(`The decision ledger records the first author clearing ${codings.discarded} coding${codings.discarded === 1 ? "" : "s"} proposed by a language model without recording a verdict.`);
  if (sections.discarded) bits.push(`The decision ledger records the first author clearing ${sections.discarded} section${sections.discarded === 1 ? "" : "s"} proposed by a language model without recording a verdict.`);
  if (undone) bits.push(`A further ${undone} decision${undone === 1 ? " was" : "s were"} made and then reversed.`);
  // Name what the file actually carries. It holds one row per decision with its
  // reason, its source and how much it touched — NOT the excerpts themselves, and
  // for a section row not the line range either. Promising excerpts sends a
  // reviewer looking for a column that has never existed.
  if (live.length) bits.push("Each decision, its stated reason, whose idea it was and how much it touched "
    + "are listed in the accompanying decisions file.");
  return bits.join(" ");
}
