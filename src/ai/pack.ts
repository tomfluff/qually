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
// So: budget on the ESTIMATE, not on characters. estimateTokens counts CJK at
// one token per character against a quarter for Latin, and a byte-count budget
// would make a Japanese window roughly four times its intended size — the exact
// failure that estimator was written to avoid.
//
// Three rules, in the order they win:
//
//   maxItems  — a ceiling on COUNT, because the model echoes line ids back and
//               a very long window invites it to lose track. sanitizeSuggestReply
//               drops ranges it cannot verify SILENTLY, so that drift would read
//               as "found nothing" rather than as an error.
//   minItems  — a floor on COUNT, because for a windowed read the chunk is not
//               only a payload unit, it is the context the model judges from.
//               Pure size-packing gives a dense transcript three-line windows:
//               cheaper requests, worse answers. The floor beats the budget.
//   budget    — the ceiling on estimated tokens for the ITEMS, excluding the
//               fixed system/codebook part, which the caller pays per request
//               whatever this returns.
//
// An item bigger than the whole budget is never dropped — it lands in a chunk of
// its own. Silently discarding it would lose coverage while still rendering as
// coverage, which is the one failure a consent gate cannot describe.

import { estimateTokens } from "./openai";

/** A transcript line as renderChunk and renderSuggestChunk will write it.
    Sized on the RAW text: redaction substitutes names for [REDACTED_n] and can
    move the count either way, but this drives how a run is split, not what the
    consent gate reports — that is estimated from the rendered payload itself. */
export const lineSize = (l: { id: number; speaker: string; text: string }): number =>
  estimateTokens(`${l.id}\t${l.speaker}\t${l.text}`);

export interface PackOpts {
  /** estimated tokens of ITEMS per request (the fixed part rides on top) */
  budget: number;
  /** never close a chunk smaller than this — context for a windowed read */
  minItems: number;
  /** never let a chunk grow past this — ids the model has to track */
  maxItems: number;
}

/** Lines are read as a window: neighbours are the context, so keep a floor. */
export const WINDOW_PACK: PackOpts = { budget: 2500, minItems: 15, maxItems: 200 };

/** Excerpts stand alone — no floor, and a tighter ceiling since each is big. */
export const ITEM_PACK: PackOpts = { budget: 2500, minItems: 1, maxItems: 24 };

export function packChunks<T>(items: readonly T[], size: (x: T) => number, o: PackOpts): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let tok = 0;
  for (const it of items) {
    const t = size(it);
    // `cur.length &&` is what keeps an oversized item: with nothing gathered
    // yet there is no chunk to close, so it goes in alone rather than nowhere.
    if (cur.length && (cur.length >= o.maxItems
      || (cur.length >= o.minItems && tok + t > o.budget))) {
      out.push(cur);
      cur = [];
      tok = 0;
    }
    cur.push(it);
    tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}
