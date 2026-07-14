// Task 1: flag likely mis-transcriptions.
//
// The lowest-risk thing an LLM can do here — it makes no interpretive claim about
// the data, it just says "that word looks wrong". Output feeds the line editor
// that already exists (double-click to fix against the audio).
import type { Line } from "../state/store";
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const CHUNK = 40; // lines per request — the unit of work is a window, never the corpus

// Cheap content hash (FNV-1a). A flag is stored against the hash of the line it
// was made on, so correcting a line silently invalidates its flags — no cache
// bookkeeping, and the AI can never point at text that no longer exists.
export function hashLine(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface Flag { quote: string; reason: string }

const SYSTEM = `You check automatic speech-recognition transcripts of research interviews for likely transcription errors.

Flag ONLY spans that the recogniser probably got wrong:
- non-words and word salad ("two dance" for "too dense")
- homophone confusions ("ticket marks" for "tick marks", "guest" for "guessed")
- words that are implausible in context, especially domain terms
- garbled proper nouns and product names

Do NOT flag: informal speech, filler words, false starts, repetition, grammatical
errors, dialect, or profanity. Real speech is messy — that is data, not an error.
A quiet transcript with no flags is a perfectly good answer.

Text marked [REDACTED_n] is a removed identifier. Never flag it.

Each quote MUST be copied exactly from that line, character for character.`;

const SCHEMA = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_id: { type: "integer", description: "the id of the line the error is in" },
          quote: { type: "string", description: "the exact substring that looks mis-transcribed" },
          reason: { type: "string", description: "a short note on what it probably should be" },
        },
        required: ["line_id", "quote", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["flags"],
  additionalProperties: false,
} as const;

export const chunksOf = (lines: Line[]): Line[][] => {
  const out: Line[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK) out.push(lines.slice(i, i + CHUNK));
  return out;
};

// exactly what gets sent for one chunk — also what the preview shows the user
export const renderChunk = (lines: Line[], r: Redaction): string =>
  lines.map((l) => `${l.id}\t${l.speaker}\t${r.redact(l.text)}`).join("\n");

export const estimateChunkTokens = (lines: Line[], r: Redaction) =>
  estimateTokens(SYSTEM) + estimateTokens(renderChunk(lines, r));

export async function flagChunk(opts: {
  key: string; model: string; lines: Line[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ flags: Record<number, Flag[]>; usage: Usage }> {
  const { data, usage } = await callJson<{ flags: { line_id: number; quote: string; reason: string }[] }>({
    key: opts.key,
    model: opts.model,
    system: SYSTEM,
    user: renderChunk(opts.lines, opts.redaction),
    schemaName: "transcription_flags",
    schema: SCHEMA,
    signal: opts.signal,
  });

  const byId = new Map(opts.lines.map((l) => [l.id, l]));
  const flags: Record<number, Flag[]> = {};
  for (const f of data.flags ?? []) {
    const line = byId.get(f.line_id);
    if (!line) continue;
    // A flag ON a placeholder is meaningless — the model never saw the real term, so
    // it cannot judge it. Restoring one would underline the participant's actual name
    // as a suspected mis-transcription. Drop it before restoring anything.
    if (opts.redaction.hasPlaceholder(f.quote)) continue;
    // Otherwise map the quote back to the real text and DROP anything that isn't a
    // genuine substring — a hallucinated quote would highlight text that isn't there.
    const quote = opts.redaction.restore(f.quote);
    if (!quote || !line.text.includes(quote)) continue;
    (flags[f.line_id] ??= []).push({ quote, reason: f.reason });
  }
  return { flags, usage };
}
