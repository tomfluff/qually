// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// OpenAI client — raw fetch, no SDK. Keeps the single-file offline artifact and
// the no-new-deps rule intact; the whole API surface we need is one POST.
//
// Docs checked 2026-07-14 (the GPT-5.6 family shipped 2026-07-09):
//   POST /v1/responses  ·  strict JSON via text.format.type = "json_schema"
//   the raw response has NO `output_text` (that's an SDK convenience) — the
//   output[] array holds a `reasoning` item BEFORE the `message` item, so the
//   text has to be found by type, never by index.

export interface Model {
  id: string;
  name: string;
  blurb: string;
  in: number;  // USD per 1M input tokens
  out: number; // USD per 1M output tokens
}

// Tiers, cheapest first — a transcript is long and most tasks here are shallow,
// so Luna is the sane default and Sol is for when it's actually hard.
export const MODELS: Model[] = [
  { id: "gpt-5.6-luna",  name: "Luna",  blurb: "fast & cheap — fine for spotting typos", in: 1,    out: 6 },
  { id: "gpt-5.6-terra", name: "Terra", blurb: "balanced — the everyday choice",         in: 2.5,  out: 15 },
  { id: "gpt-5.6-sol",   name: "Sol",   blurb: "frontier — for interpretive work",       in: 5,    out: 30 },
];
export const DEFAULT_MODEL = "gpt-5.6-luna";
export const modelOf = (id: string) => MODELS.find((m) => m.id === id) ?? MODELS[0];

// ~4 chars/token for Latin script — but roughly ONE token per character for CJK,
// which is the direction that matters: an under-estimate lets a request through
// a size gate the API then refuses, after the researcher has consented and
// possibly been billed. So CJK characters are counted at 1 and the rest at 1/4.
// Still deliberately rough: it drives a pre-flight estimate the researcher sees
// before approving, and the log records the real usage the API reports back.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
export const estimateTokens = (text: string) => {
  const dense = (text.match(CJK) ?? []).length;
  return Math.ceil(dense + (text.length - dense) / 4);
};

/** What a cached input token costs against an uncached one. Verified against
    OpenAI's prompt-caching guide 2026-08-31: on GPT-5.6 and later a cache READ
    bills at 0.1x the uncached input rate (a cache WRITE bills at 1.25x, which is
    why caching is only worth asking for on a run of more than one request).
    Nothing here asks for caching yet; this is what makes the LOG honest when the
    API reports that some of the input was served from cache. */
export const CACHE_READ_RATE = 0.1;
/** And a cache WRITE bills at 1.25x. Counting it as ordinary input made the
    first request of every cached run read cheaper than it was — the one request
    that always pays the premium. */
export const CACHE_WRITE_RATE = 1.25;

/** `cachedTok` is a SUBSET of inTok, not an addition to it — that is how the API
    reports it, and adding the two would double-count the request. */
export const costOf = (
  m: Model, inTok: number, outTok: number, cachedTok = 0, writeTok = 0,
) => {
  const total = Math.max(inTok, 0);
  const cached = Math.min(Math.max(cachedTok, 0), total);
  const written = Math.min(Math.max(writeTok, 0), total - cached);
  const fresh = total - cached - written;
  return (fresh / 1e6) * m.in
    + (cached / 1e6) * m.in * CACHE_READ_RATE
    + (written / 1e6) * m.in * CACHE_WRITE_RATE
    + (outTok / 1e6) * m.out;
};

export interface Usage {
  inTok: number; outTok: number; cachedTok: number; writeTok: number; costUsd: number;
}

export class AiError extends Error {}

/** A block of text that is IDENTICAL across the requests of one run — a
    codebook, a definition list — which the API can bill at the cache rate
    instead of the full one after the first request.

    Verified against OpenAI's prompt-caching guide (2026-08-31). Two facts shape
    this:
      - A cache entry is a PREFIX, and reuse needs the whole prefix to match. On
        GPT-5.6 the implicit breakpoint lands at the end of the latest eligible
        message, so a request that concatenates a stable codebook and a changing
        window into one user message caches through the changing part and never
        hits. The docs name that exact shape as a gotcha, and it is the shape
        this app was sending: every run got zero reuse.
      - A read bills at 0.1x, a WRITE at 1.25x. So this is only worth asking for
        on a run of more than one request — at N=1 it costs 25% MORE. Callers
        must not pass `cache` for a single-request action.
    `key` groups the run's requests so they reach the same machine; the guide
    warns that above 15 requests a minute they can otherwise be routed apart. */
export interface CachePrefix { text: string; key: string }

/** The smallest prefix the API will cache on GPT-5.6 and later. Below it the
    breakpoint is accepted and simply never produces a hit, so asking would pay
    the write premium for nothing. */
export const MIN_CACHEABLE_TOKENS = 1024;

/** Whether asking for caching can pay for itself: a prefix large enough to be
    cached at all, over more than one request. */
export const worthCaching = (prefixText: string, requests: number) =>
  requests > 1 && estimateTokens(prefixText) >= MIN_CACHEABLE_TOKENS;

// One structured-output call. Returns the parsed object plus what it actually cost.
export async function callJson<T>(opts: {
  key: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  /** Omit to send exactly what this app has always sent. */
  cache?: CachePrefix;
  signal?: AbortSignal;
}): Promise<{ data: T; usage: Usage }> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        // Without `cache`, byte-identical to what this app has always sent.
        // With it, the stable block becomes its own message carrying an explicit
        // breakpoint, so the changing part below it cannot spoil the prefix.
        input: opts.cache
          ? [
            { role: "system", content: opts.system },
            {
              role: "developer",
              content: [{
                type: "input_text",
                text: opts.cache.text,
                prompt_cache_breakpoint: { mode: "explicit" },
              }],
            },
            { role: "user", content: opts.user },
          ]
          : [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        ...(opts.cache
          ? {
            prompt_cache_key: opts.cache.key,
            // explicit-only: do not also write the changing suffix, which would
            // pay the 1.25x write premium for a prefix nothing can reuse
            prompt_cache_options: { mode: "explicit" },
          }
          : {}),
        // reasoning tokens bill at the OUTPUT rate; these tasks are shallow, so
        // don't pay for deliberation we don't need
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: opts.schemaName,
            schema: opts.schema,
            strict: true,
          },
        },
      }),
    });
  } catch (e) {
    // A cancelled run is not a failure: every modal tests for AbortError by name
    // to stay silent when the user closes the dialog mid-request, and wrapping it
    // here made all six announce "Couldn't reach the OpenAI API (The user aborted
    // a request)" instead. Let it through untouched.
    if ((e as Error).name === "AbortError") throw e;
    // a browser CORS/offline failure lands here with a useless "Failed to fetch"
    throw new AiError(`Couldn't reach the OpenAI API (${(e as Error).message}). Check your connection.`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `${res.status} ${res.statusText}`;
    try { msg = JSON.parse(body)?.error?.message || msg; } catch { /* keep the status line */ }
    if (res.status === 401) msg = "That API key was rejected. Check it in Settings → AI.";
    if (res.status === 429) msg = "OpenAI rate-limited the request (or you're out of credit). Try again shortly.";
    throw new AiError(msg);
  }

  const json = await res.json();
  // find the message item by TYPE — a reasoning item precedes it
  const msg = (json.output as { type: string; content?: { type: string; text?: string }[] }[] | undefined)
    ?.find((o) => o.type === "message");
  const text = msg?.content?.find((c) => c.type === "output_text")?.text;
  if (!text) throw new AiError("The model returned no content.");

  let data: T;
  try { data = JSON.parse(text) as T; }
  catch { throw new AiError("The model returned malformed JSON."); }

  const u = json.usage ?? {};
  const inTok = u.input_tokens ?? 0, outTok = u.output_tokens ?? 0;
  // How much of the input the API served from its prompt cache. Reported as a
  // subset of input_tokens; absent on older responses and on any model that
  // does not cache, which reads as none rather than as an error.
  const cachedTok = u.input_tokens_details?.cached_tokens ?? 0;
  // Written to the cache on this request, billed at 1.25x. Absent where the
  // model does not cache or the field is not reported, which reads as none —
  // the same discipline as cachedTok above.
  const writeTok = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    data,
    usage: {
      inTok, outTok, cachedTok, writeTok,
      costUsd: costOf(modelOf(opts.model), inTok, outTok, cachedTok, writeTok),
    },
  };
}
