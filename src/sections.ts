// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The study brief, and the closed vocabulary it declares (F7).
//
// A researcher knows the shape of their session before they open the first
// transcript — they designed the study. The brief is where they say so: prose
// about how the session ran, and a bulleted list of the axes a section may be
// labelled with. The model is told that list and may use nothing else.
//
// The parse is the GUARD, not a convenience. Whatever comes out of it is
// exactly what the sanitizer accepts back, so it is done once per run and the
// same result is used twice — in the prompt, and at the trust boundary. Editing
// the brief while the gate is open therefore cannot desync what was promised
// from what is enforced.
//
// Nothing here touches the network; the whole vocabulary contract is testable
// without a key.
import type { Stretch } from "./stretches";

/** The most sections one reply may carry. A session has a shape, not a
    thousand parts — and without a bound the gate's output-cost estimate is a
    guess rather than a ceiling. The JSON schema asks the model for at most this
    many; sanitizeSections is what makes it true, because a boundary that trusts
    the other end of the wire to enforce its own limit is not a boundary. */
export const SECTIONS_MAX = 120;
/** what one section costs to say back, generously: the label, the range, and a
    sentence. Used for the pre-flight estimate, so it must never understate. */
export const SECTION_OUT_TOKENS = 60;
/** A reason is one sentence. It is PERSISTED on the candidate and survives into
    the project file, so an unbounded one is not just a long tooltip — it is
    weight on every save from then on. Generous enough that no honest sentence
    is clipped. */
const WHY_MAX = 600;

/** One axis and the labels allowed within it, in the spelling that will be stored. */
export interface Axis { dim: string; values: string[] }
export interface Vocab {
  axes: Axis[];
  /** the pair key (see pairKey) -> the canonical spelling to store */
  canon: Map<string, { dim: string; value: string }>;
}

// A declaration is a BULLETED line:
//
//     - phase: warm-up, task 1, task 2, debrief
//     * chart type: bar, line
//
// The bullet is what keeps the grammar honest. Without it any prose sentence
// holding a colon ("Note: participants were tired, confused") parses as an axis
// — and a false declaration does not merely misread, it WIDENS the guard, which
// is the one thing this parser exists to prevent. Nobody writes a sentence
// beginning "- word:" by accident, and a bulleted list of axes is what a
// researcher would write anyway. Order is free, and the lines may sit anywhere
// in the brief, so the prose can lead.
const DECL = /^\s*[-*•]\s*([^:\n]+?)\s*:\s*(.+?)\s*$/;

/** The key two spellings of the same label share: NFC (so "é" typed two ways is
    one label), lowercased, inner whitespace collapsed, control characters
    stripped — that last one is what makes pairKey's separator trustworthy, and
    no section label contains a control character anyway.
    NB lowercase, not full case folding: "STRASSE" and "straße" stay different
    keys. That fails SAFE — the pair is not found, so the proposal is dropped —
    which is the only direction this guard is allowed to be wrong in. */
export const canonKey = (s: string) =>
  s.normalize("NFC").replace(/\p{Cc}/gu, "").trim().replace(/\s+/g, " ").toLowerCase();

/** The key an axis:label pair is looked up by. NUL is the separator BECAUSE a
    label may contain spaces: joined with one, "chart type"+"bar" and
    "chart"+"type bar" would be the same key, and a proposal could then arrive
    under a label nobody declared. Written as an escape, never as an invisible
    character in the source.
    A separator only separates if it cannot appear in what it joins, which is
    why canonKey strips control characters: otherwise a declared "a"+"b\u0000c"
    and a reply "a\u0000b"+"c" build the same key, and the reply's undeclared
    pair is handed back the declared pair's spelling. */
const pairKey = (dim: string, value: string) => `${canonKey(dim)}\u0000${canonKey(value)}`;

/** Read the brief. `existing` is the project's stretches: where a label is
    already marked by hand in another spelling, THAT spelling wins — the store's
    own dup-guard, stretchDims and coverageOf all compare dim/value
    case-sensitively, so a declared "phase: warm-up" over a hand-marked
    "Phase: Warm-up" would otherwise fork the project into two gutter columns
    that are the same colour and mean the same thing. */
export function parseBrief(text: string, existing: Pick<Stretch, "dim" | "value">[] = []): Vocab {
  // what the project already calls things, first spelling wins (the list is in
  // marking order, so the earliest mark is the established one). Dims and
  // values keep SEPARATE maps: one shared map let a dim named like some other
  // axis's value borrow that value's spelling (or vice versa), forking the very
  // column this precedence exists to keep whole.
  const knownDims = new Map<string, string>();
  const knownValues = new Map<string, string>();
  for (const s of existing) {
    for (const [map, part] of [[knownDims, s.dim], [knownValues, s.value]] as const) {
      const k = canonKey(part);
      if (k && !map.has(k)) map.set(k, part.trim());
    }
  }
  // the spelling to STORE: the project's own if it already has one, otherwise
  // the declared text tidied the same way canonKey reads it — control
  // characters included, so a stored label can never break pairKey's separator
  const spell = (raw: string, known: Map<string, string>) =>
    known.get(canonKey(raw)) ?? raw.normalize("NFC").replace(/\p{Cc}/gu, "").trim().replace(/\s+/g, " ");

  const byDim = new Map<string, { dim: string; values: Map<string, string> }>();
  for (const line of text.split("\n")) {
    const m = DECL.exec(line);
    if (!m) continue;
    const dim = spell(m[1], knownDims);
    if (!dim) continue;
    const dk = canonKey(dim);
    const axis = byDim.get(dk) ?? { dim, values: new Map<string, string>() };
    // a repeated axis MERGES rather than replacing: two lines naming the same
    // dimension are one researcher adding to their own list, not contradicting it
    for (const raw of m[2].split(",")) {
      const v = spell(raw, knownValues);
      if (!v) continue;
      const vk = canonKey(v);
      if (!axis.values.has(vk)) axis.values.set(vk, v);
    }
    if (axis.values.size) byDim.set(dk, axis);
  }

  const axes = [...byDim.values()].map((a) => ({ dim: a.dim, values: [...a.values.values()] }));
  const canon = new Map<string, { dim: string; value: string }>();
  for (const a of axes)
    for (const v of a.values) canon.set(pairKey(a.dim, v), { dim: a.dim, value: v });
  return { axes, canon };
}

/** the labels the run promises to accept, said in one line for the gate's echo */
export const vocabSays = (v: Vocab) =>
  v.axes.map((a) => `${a.dim} → ${a.values.join(" / ")}`).join(" · ");

/** Where the stored spelling differs from what was typed, because the project
    already uses that label another way. The gate says this out loud: a
    researcher who typed "Condition: Baseline" and sees "condition → baseline"
    is owed the reason, which is that their project already has a `condition`
    axis and a second one differing only in case would be a separate gutter
    column of the same colour meaning the same thing. */
export function vocabRespelled(text: string, existing: Pick<Stretch, "dim" | "value">[] = []): string[] {
  const bare = parseBrief(text);          // what the brief says on its own
  const real = parseBrief(text, existing); // what the project makes of it
  const out: string[] = [];
  bare.axes.forEach((a, i) => {
    const b = real.axes[i];
    if (!b) return;
    if (a.dim !== b.dim) out.push(`${a.dim} → ${b.dim}`);
    a.values.forEach((v, k) => { if (b.values[k] && v !== b.values[k]) out.push(`${v} → ${b.values[k]}`); });
  });
  return out;
}

/** The prose half: everything that is NOT a declaration, so the brief's
    context reaches the model without the axis list being said twice. */
export const briefProse = (text: string) =>
  text.split("\n").filter((l) => !DECL.test(l)).join("\n").trim();

// A proposal that has been through the trust boundary — and the type system
// says so. The brand is unforgeable outside this module, so `landSections`
// cannot be handed a raw model reply by a future caller who did not know the
// vocabulary check was the point of the whole feature.
declare const CHECKED: unique symbol;
export interface SectionProposal {
  dim: string; value: string; start: number; end: number; why: string;
  readonly [CHECKED]: true;
}

/** The trust boundary, testable without the network (cf. sanitizeSuggestReply).
    A proposal survives only if it names a DECLARED label and lands on real
    lines of THIS transcript. Everything else is dropped, never guessed at.

    `existing` drops two kinds of proposal: one identical to a stretch already
    there (nothing to review), and one the researcher has already REJECTED.
    Rejection memory is exact — same dim, value and both endpoints. F3 suppresses
    any overlapping same-code proposal, which is right for an excerpt and wrong
    here: a section spans hundreds of lines, so overlap-suppression would mean
    that rejecting "phase: task 1" once forbids task 1 anywhere near there ever
    again. "Right label, wrong boundary" is fixed by dragging the grips. */
export function sanitizeSections(
  vocab: Vocab,
  lineIds: number[],
  reply: { dim?: string; value?: string; line_start?: number; line_end?: number; why?: string }[],
  existing: Stretch[] = [],
  pid = "",
  max = SECTIONS_MAX,
): SectionProposal[] {
  const ids = new Set(lineIds);
  const already = new Set(
    existing.filter((s) => s.pid === pid)
      .map((s) => `${pairKey(s.dim, s.value)}\u0000${s.start}\u0000${s.end}`));
  const seen = new Set<string>();
  const out: SectionProposal[] = [];
  for (const p of reply) {
    const hit = vocab.canon.get(pairKey(p.dim ?? "", p.value ?? ""));
    if (!hit) continue; // not a declared label — the whole point
    if (!Number.isInteger(p.line_start) || !Number.isInteger(p.line_end)) continue;
    if (!ids.has(p.line_start!) || !ids.has(p.line_end!)) continue;
    const start = Math.min(p.line_start!, p.line_end!);
    const end = Math.max(p.line_start!, p.line_end!);
    const key = `${pairKey(hit.dim, hit.value)}\u0000${start}\u0000${end}`;
    if (seen.has(key) || already.has(key)) continue;
    seen.add(key);
    // a reason is not optional to us even where the model skipped it: the
    // review dialog reads it aloud, and "" is at least an honest blank
    // the one place the brand is applied: this line IS the trust boundary
    out.push({ dim: hit.dim, value: hit.value, start, end,
      why: (p.why ?? "").trim().slice(0, WHY_MAX) } as SectionProposal);
    // The cap is what the GATE priced and promised, so it has to hold here too,
    // not only in the JSON schema — that schema is enforced by the other end of
    // the wire, and this function's whole job is to not trust that. Both bounds
    // are on what gets PERSISTED: a candidate's `why` outlives the run in the
    // project file, so an unbounded one bloats every save from then on.
    if (out.length >= max) break;
  }
  return out;
}
