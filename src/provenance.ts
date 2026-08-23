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
import type { Decision } from "./state/store";

export type Origin = "untouched" | "you" | "ai";

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
      const [survivor, from] = d.codes;
      if (!survivor) continue;
      if (from && state.get(from) === "ai") state.set(survivor, "ai");
      if (from) state.delete(from);
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
    if (!d.codes.some((c) => names.has(c))) continue;
    rows.unshift(d);
    if ((d.kind === "rename" || d.kind === "merge") && names.has(d.codes[0]) && d.codes[1]) {
      names.add(d.codes[1]);
    }
  }
  return rows;
}

// The paragraph a methods section needs, written from the ledger rather than by
// a model: it is a claim about the researcher's own conduct, so nothing else
// may author it. Editable wherever it is shown — this is a first draft of a
// sentence, not an output.
export function methodsParagraph(ledger: Decision[], codes: string[], coder = "The first author"): string {
  const live = ledger.filter((d) => !d.undone);
  const n = (k: Decision["kind"]) => live.filter((d) => d.kind === k).length;
  const fromAi = live.filter((d) => d.source === "ai").length;
  const fromWording = live.filter((d) => d.source === "wording").length;
  const models = [...new Set(live.filter((d) => d.model).map((d) => d.model!))];
  const undone = ledger.filter((d) => d.undone).length;
  const bits: string[] = [];
  bits.push(`${coder} consolidated the codebook to ${codes.length} code${codes.length === 1 ? "" : "s"}.`);
  const acts: string[] = [];
  if (n("merge")) acts.push(`${n("merge")} merge${n("merge") === 1 ? "" : "s"}`);
  if (n("rename")) acts.push(`${n("rename")} rename${n("rename") === 1 ? "" : "s"}`);
  if (n("remove")) acts.push(`${n("remove")} code${n("remove") === 1 ? "" : "s"} withdrawn from the analysis`);
  if (n("delete")) acts.push(`${n("delete")} deletion${n("delete") === 1 ? "" : "s"}`);
  if (n("park")) acts.push(`${n("park")} code${n("park") === 1 ? "" : "s"} set aside`);
  if (acts.length) bits.push(`${acts.join(", ")} were applied.`);
  if (fromWording) {
    bits.push(`${fromWording} of these began as an offline wording match computed on the researcher's machine.`);
  }
  if (fromAi) {
    bits.push(`${fromAi} began as a proposal from a large language model${models.length ? ` (${models.join(", ")})` : ""}, `
      + `run against the researcher's own key; the model applied nothing and every proposal was accepted, edited or rejected by hand.`);
  } else if (live.length) {
    bits.push("No language model proposed any of them.");
  }
  // the number the question "did the model shape your analysis" actually wants
  const blind = live.filter((d) => d.blind);
  if (blind.length) {
    const agreed = blind.filter((d) => d.blind === "agreed").length;
    bits.push(`On ${blind.length} proposal${blind.length === 1 ? "" : "s"} the researcher recorded a verdict `
      + `before seeing the model's, agreeing with it on ${agreed} and differing on ${blind.length - agreed}.`);
  }
  if (undone) bits.push(`A further ${undone} decision${undone === 1 ? " was" : "s were"} made and then reversed.`);
  if (live.length) bits.push("Each decision, its stated reason and the excerpts it rested on are listed in the accompanying decisions file.");
  return bits.join(" ");
}
