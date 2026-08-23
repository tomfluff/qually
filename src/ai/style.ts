// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// House style, measured instead of pleaded for. Every name-proposing prompt
// used to say "match the conventions visible in this codebook" and hope the
// model inferred them from the payload; this measures the researcher's actual
// conventions — case, length, phrasing, punctuation — and states them, with
// real examples, so a proposal arrives in their voice instead of the model's.
// Offline, deterministic, and computed at call time from the live book.

const words = (n: string) => n.trim().split(/\s+/).filter(Boolean);

type Case = "all-lowercase" | "Sentence case" | "Title Case" | "ALL CAPS" | "mixed";
function caseOf(name: string): Case {
  // classified on letters only; a name with no letters says nothing
  if (!/[a-zA-Z]/.test(name)) return "mixed";
  if (name === name.toLowerCase()) return "all-lowercase";
  if (name === name.toUpperCase()) return "ALL CAPS";
  const ws = words(name).filter((w) => /[a-zA-Z]/.test(w));
  const capped = ws.filter((w) => /^[A-Z]/.test(w));
  if (capped.length === ws.length && ws.length > 1) return "Title Case";
  if (/^[A-Z]/.test(name) && capped.length === 1) return "Sentence case";
  // "asking AI", "trust in AI": lowercase-led with embedded acronyms still
  // reads as the lowercase convention
  if (/^[a-z]/.test(name) && ws.slice(1).every((w) => w === w.toUpperCase() || w === w.toLowerCase())) {
    return "all-lowercase";
  }
  return "mixed";
}

const dominant = <K extends string>(counts: Map<K, number>, total: number, floor = 0.6): K | null => {
  for (const [k, n] of counts) if (n / total >= floor) return k;
  return null;
};

/** one measured paragraph for a prompt, or null when the book is too small to
    have a style worth asserting (the generic instruction stays either way) */
export function houseStyle(names: string[]): string | null {
  const live = names.filter((n) => n.trim());
  if (live.length < 5) return null;

  const bits: string[] = [];

  const cases = new Map<Case, number>();
  for (const n of live) {
    const c = caseOf(n);
    if (c !== "mixed") cases.set(c, (cases.get(c) ?? 0) + 1);
  }
  const cs = dominant(cases, live.length);
  if (cs) bits.push(`${cs}${cs === "all-lowercase" ? " (acronyms like AI stay capped)" : ""}`);

  const lens = live.map((n) => words(n).length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  bits.push(`typically ${median} word${median === 1 ? "" : "s"} long`);

  const gerunds = live.filter((n) => /^[a-zA-Z]+ing\b/.test(n.trim())).length;
  if (gerunds / live.length >= 0.4) bits.push("often gerund-led (“using…”, “asking…”)");

  const colons = live.filter((n) => n.includes(":")).length;
  if (colons / live.length >= 0.25) bits.push("sometimes prefixed with a colon (“topic: stance”)");

  // examples: median-length names in the dominant case read as the style
  const typical = live
    .filter((n) => Math.abs(words(n).length - median) <= 1 && (!cs || caseOf(n) === cs))
    .slice(0, 3);
  const ex = typical.length >= 2 ? ` Examples from the codebook: ${typical.map((t) => `“${t}”`).join(", ")}.` : "";

  return `MEASURED HOUSE STYLE: this researcher's code names are ${bits.join("; ")}.${ex} Any name you propose must read as one of these.`;
}

/** the measured style as a prompt suffix — "" when the book is too small to
    have one (the generic match-the-codebook instruction still applies) */
export const styleSuffix = (names: string[]): string => {
  const st = houseStyle(names);
  return st ? `\n\n${st}` : "";
};
