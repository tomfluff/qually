// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Offline "find similar codes": the first answer the map gives when you ask
// where a code's relatives are. It runs on the device, costs nothing, needs no
// key, and catches the split that matters most in a first-cycle codebook — the
// same idea typed twice in different words ("difficult to see" / "hard to
// see"). What it CANNOT see is a relative that shares no wording ("needs zoom"
// / "small text"); that is what the AI pass is for, offered as a second step.
//
// Deliberately not a vector model: this is a few hundred short strings, the
// signal is mostly shared wording, and a wrong-but-confident embedding would
// be worse than an honest, explainable overlap score. Every match carries the
// words it matched on, so the researcher can judge it.

export interface SimilarInput { name: string; def?: string }
export interface SimilarMatch {
  name: string;
  score: number;      // 0..1
  why: string;        // what it matched on, in the researcher's own words
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "by", "for",
  "with", "is", "it", "its", "as", "that", "this", "from", "about", "when",
  "how", "what", "not", "but", "they", "them", "their", "you", "your", "i",
]);

// crude, deliberate stemmer: enough to tie "reading"/"reads"/"read" together
// without pulling in a dictionary
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// character bigrams catch near-spellings the token pass misses
// ("colour blind" / "color-blind"), and cost nothing at this scale
const bigrams = (s: string) => {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
};

export function scoreSimilar(source: SimilarInput, other: SimilarInput): { score: number; why: string } {
  const sName = new Set(tokens(source.name));
  const oName = new Set(tokens(other.name));
  const shared = [...sName].filter((w) => oName.has(w));
  const nameJ = jaccard(sName, oName);
  const defJ = source.def && other.def
    ? jaccard(new Set(tokens(source.def)), new Set(tokens(other.def)))
    : 0;
  const spell = dice(bigrams(source.name), bigrams(other.name));
  // one name's words fully inside the other's is a strong split signal:
  // "chart" vs "chart complexity" is one concept splintering
  const contained = sName.size && oName.size
    && ([...sName].every((w) => oName.has(w)) || [...oName].every((w) => sName.has(w)));

  const score = Math.min(1,
    nameJ * 0.5 + spell * 0.25 + defJ * 0.15 + (contained ? 0.2 : 0));

  const why = shared.length
    ? `both about ${shared.slice(0, 3).join(", ")}`
    : spell > 0.5 ? "nearly the same wording"
    : defJ > 0.2 ? "definitions overlap"
    : "similar wording";
  return { score, why };
}

/** Ranked local matches for one code, best first. `cap` bounds the list. */
export function findSimilar(
  source: string,
  book: SimilarInput[],
  opts: { cap?: number; floor?: number } = {},
): SimilarMatch[] {
  const cap = opts.cap ?? 12;
  const floor = opts.floor ?? 0.18;
  const src = book.find((c) => c.name === source);
  if (!src) return [];
  return book
    .filter((c) => c.name !== source)
    .map((c) => ({ name: c.name, ...scoreSimilar(src, c) }))
    .filter((m) => m.score >= floor)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, cap);
}
