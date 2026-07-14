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

// ~4 chars/token. Deliberately rough: it drives a *pre-flight estimate* the user
// sees before approving, and the log records the real usage the API reports back.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export const costOf = (m: Model, inTok: number, outTok: number) =>
  (inTok / 1e6) * m.in + (outTok / 1e6) * m.out;

export interface Usage { inTok: number; outTok: number; costUsd: number }

export class AiError extends Error {}

// One structured-output call. Returns the parsed object plus what it actually cost.
export async function callJson<T>(opts: {
  key: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
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
        input: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
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
  return { data, usage: { inTok, outTok, costUsd: costOf(modelOf(opts.model), inTok, outTok) } };
}
