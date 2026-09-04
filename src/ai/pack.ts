// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// How a run is split into requests.
//
// Every chunker here used to count ITEMS — 40 lines, 12 excerpts — which is a
// proxy for size that a real transcript breaks in both directions. Measured on
// a 2400-line transcript of short utterances against a 60-code book, a suggest
// run sent 60 requests of which 97% was the codebook and system prompt: 4.4k
// tokens of overhead to carry 114 tokens of transcript, paid sixty times.
// Packing the same lines to a token budget sends 12 requests instead, for about
// an eighth of the cost and the same words. The other direction is worse than
// expensive: 12 long excerpts is a request several times the size of 12 short
// ones (measured 759 to 4218 tokens for the same chunk rule), and callJson has
// no context preflight, so an oversized request is a failure the researcher has
// already consented to and may be billed for.
//
// Budget on the ESTIMATE, not on characters. estimateTokens counts CJK at one
// token per character against a quarter for Latin, and a byte-count budget
// would make a Japanese window roughly four times its intended size — the exact
// failure that estimator was written to avoid. Size each item as it will
// actually be RENDERED, redaction included: a one-character redaction term
// expands to "[REDACTED_1]" and can triple a chunk between packing it and
// sending it.
//
// Four rules, in the order they win:
//
//   hardCap   — a request this size risks the model's context window, which
//               callJson cannot preflight. Nothing overrides it, not even the
//               floor. An item bigger than the cap ON ITS OWN is still sent
//               rather than dropped, alone, and `oversize` names it so the
//               caller can warn before the researcher consents.
//   maxItems  — a ceiling on COUNT, because the model answers with line ids and
//               a very long window invites it to drift. sanitizeSuggestReply
//               drops ranges it cannot verify, so drift is only safe while the
//               caller REPORTS what was dropped (see suggestChunk's `rejected`).
//   minItems  — a floor on COUNT, because for a windowed read the chunk is not
//               only a payload unit, it is the context the model judges from.
//               Pure size-packing gives a dense transcript three-line windows:
//               cheaper requests, worse answers. The floor beats the budget and
//               nothing else.
//   budget    — the soft target for the ITEMS, excluding the fixed
//               system/codebook part, which the caller pays per request whatever
//               this returns.
//
// An item is never dropped. Silently discarding one would lose coverage while
// still rendering as coverage, which is the one failure a consent gate cannot
// describe.

import { estimateTokens } from "./openai";

/** A transcript line as renderChunk and renderSuggestChunk will write it.
    Takes the same redaction the request will, because packing what is not sent
    is how a chunk lands three times its measured size (a one-character term
    becomes a twelve-character placeholder). `context` reproduces the
    "[context] " speaker prefix that renderSuggestChunk adds. */
export const lineSize = (
  l: { id: number; speaker: string; text: string; coded?: string[] },
  r?: { redact: (s: string) => string },
  context?: Set<string>,
): number => {
  const red = r ? r.redact.bind(r) : (s: string) => s;
  const tag = context?.has(l.speaker.trim()) ? "[context] " : "";
  return estimateTokens(`${l.id}\t${tag}${red(l.speaker)}\t${red(l.text)}${codedField(l)}`);
};

/** The optional fourth field of a transcript line: the codes the researcher has
    already given it. Set only by Find's "coded excerpts only" scope, where the
    lines sent are exactly the coded ones and the model is told what they carry —
    so it can propose what they do NOT yet carry. Code names go plain, as the
    codebook's do. Absent means the field is not rendered at all, so every run
    that does not use it sends the bytes it always sent. */
export const codedField = (l: { coded?: string[] }) =>
  l.coded?.length ? `\t[already coded: ${l.coded.join("; ")}]` : "";

export interface PackOpts {
  /** soft target: estimated tokens of ITEMS per request (the fixed part rides on top) */
  budget: number;
  /** never close a chunk smaller than this — context for a windowed read */
  minItems: number;
  /** never let a chunk grow past this — ids the model has to answer with */
  maxItems: number;
  /** absolute ceiling; beats the floor, because no amount of context is worth a
      request the model cannot read */
  hardCap: number;
}

/** Lines are read as a window: neighbours are the context, so keep a floor. */
export const WINDOW_PACK: PackOpts = { budget: 2500, minItems: 15, maxItems: 200, hardCap: 24_000 };

/** Excerpts stand alone — no floor, and a tighter ceiling since each is big. */
export const ITEM_PACK: PackOpts = { budget: 2500, minItems: 1, maxItems: 24, hardCap: 24_000 };

export interface Packed<T> {
  chunks: T[][];
  /** items whose own rendered size exceeds hardCap. They are still sent, each
      alone, because dropping one loses coverage — but the caller has to say so
      before the researcher consents to a request that may not fit. */
  oversize: T[];
}

/** The full result. `packChunks` is the common case that only wants the chunks. */
export function packRun<T>(items: readonly T[], size: (x: T) => number, o: PackOpts): Packed<T> {
  if (!(o.budget > 0) || !(o.hardCap > 0)) throw new Error("pack: budget and hardCap must be positive");
  if (!Number.isInteger(o.minItems) || !Number.isInteger(o.maxItems)
    || o.minItems < 1 || o.maxItems < o.minItems) {
    throw new Error("pack: need 1 <= minItems <= maxItems");
  }
  const chunks: T[][] = [];
  const sizes: number[] = [];          // token total per chunk, for the tail rebalance
  const solo: boolean[] = [];          // chunk holds one item too big to share
  const oversize: T[] = [];
  let cur: T[] = [];
  let tok = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push(cur); sizes.push(tok); solo.push(false);
    cur = []; tok = 0;
  };
  for (const it of items) {
    // A size function that cannot answer must not silently disable the budget:
    // NaN poisons every comparison, so every chunk would grow to maxItems.
    const raw = size(it);
    const t = Number.isFinite(raw) && raw > 0 ? raw : 0;
    // Alone over the cap: it cannot share a request with anything, and it is
    // still sent — the caller warns, this does not drop it.
    if (t > o.hardCap) {
      flush();
      chunks.push([it]); sizes.push(t); solo.push(true);
      oversize.push(it);
      continue;
    }
    if (cur.length && (
      cur.length >= o.maxItems
      || tok + t > o.hardCap                                 // beats the floor
      || (cur.length >= o.minItems && tok + t > o.budget)    // floor beats the budget
    )) flush();
    cur.push(it);
    tok += t;
  }

  // The leftover is the one chunk nothing above bounds. A 2401-line transcript
  // packed 200 at a time ends with a window of ONE line that still carries the
  // whole codebook and system prompt — the 97%-overhead request this module
  // exists to prevent — and hands the model a line with no neighbours, which is
  // what minItems forbids everywhere else.
  //
  // Two ways out, in order, and BOTH may be refused: the previous chunk may be a
  // lone oversized item that can share with nothing, or already be at a ceiling.
  // A short tail is worth less than a request that cannot be read, so when
  // neither is safe the tail simply ships short.
  const prev = chunks.length - 1;
  const canTouch = prev >= 0 && !solo[prev];
  if (cur.length && cur.length < o.minItems && canTouch) {
    const need = o.minItems - cur.length;
    const back = chunks[prev].slice(chunks[prev].length - need);
    const backTok = back.reduce((n, x) => {
      const r = size(x); return n + (Number.isFinite(r) && r > 0 ? r : 0);
    }, 0);
    if (chunks[prev].length - need >= o.minItems && tok + backTok <= o.hardCap) {
      // borrow the tail of the previous chunk, keeping order
      chunks[prev].splice(chunks[prev].length - need, need);
      sizes[prev] -= backTok;
      cur = [...back, ...cur];
      tok += backTok;
    } else if (chunks[prev].length + cur.length <= o.maxItems
      && sizes[prev] + tok <= o.hardCap) {
      chunks[prev].push(...cur);
      sizes[prev] += tok;
      cur = []; tok = 0;
    }
  }
  flush();

  return { chunks, oversize };
}

export const packChunks = <T>(items: readonly T[], size: (x: T) => number, o: PackOpts): T[][] =>
  packRun(items, size, o).chunks;
