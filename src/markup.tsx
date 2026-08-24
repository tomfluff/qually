// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Substitutions in a transcript line.
//
// Participants say "the first system" and "the second one"; the researcher
// reading the transcript six weeks later has no idea which is which. So they
// replace those words with the system's name — and the convention this app
// takes is SQUARE BRACKETS: `[Beacon]` is not what was said, it is what was
// meant, written in by hand. Find and replace (the search bar) puts them
// there; this module is the other half — making them impossible to mistake
// for the participant's own words wherever a line is rendered.
//
// Bold AND italic AND a colour: this is one of the few marks in the app that
// must survive being skimmed, and colour alone would fail the researcher who
// prints the transcript or reads it with a colour filter on.
import { Fragment, type ReactNode } from "react";

// One bracketed run: no nesting, no newline, and never empty — `[]` is not a
// substitution, and neither is a stray bracket the participant actually said.
const BRACKET = /\[[^[\]\n]+\]/g;

/** Where the bracketed runs are, as [start, end) char offsets. */
export function subSpans(text: string): [number, number][] {
  if (!text.includes("[")) return []; // the overwhelmingly common case, for free
  const out: [number, number][] = [];
  for (const m of text.matchAll(BRACKET)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** A line, or one slice of it, with its substitutions marked up.
    `from`/`spans` exist for callers that have already cut the text into pieces
    for their own reasons (search hits, AI marks): the spans are computed once
    over the WHOLE line and each slice says where it starts, so a substitution
    that straddles a slice boundary is still styled on both sides of it. */
export function withSubs(slice: string, from = 0, spans?: [number, number][]): ReactNode {
  // computed spans are in SLICE space; everything below reasons in line space,
  // so a slice that starts partway into its line shifts them into it
  const all = spans ?? subSpans(slice).map(([a, b]) => [a + from, b + from] as [number, number]);
  if (!all.length) return slice;
  const to = from + slice.length;
  const nodes: ReactNode[] = [];
  let last = from;
  all.forEach(([s, e], k) => {
    const a = Math.max(s, from), b = Math.min(e, to);
    if (a >= b) return; // this run is not in this slice
    if (a > last) nodes.push(slice.slice(last - from, a - from));
    nodes.push(<span key={k} className="subst">{slice.slice(a - from, b - from)}</span>);
    last = b;
  });
  if (last >= to) return nodes;
  nodes.push(slice.slice(last - from));
  return nodes;
}

/** withSubs where the caller needs a keyed child (inside a map). */
export const SubText = ({ text, from, spans }: { text: string; from?: number; spans?: [number, number][] }) =>
  <Fragment>{withSubs(text, from, spans)}</Fragment>;
