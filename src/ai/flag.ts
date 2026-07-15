// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// AI scan: noticing, not coding.
//
// Every lens marks INSTANCES ("this is an emotional expression") and never proposes
// a code, theme, or interpretation — that part belongs to the researcher. Each lens
// maps to an established first-cycle coding method (Saldaña), which is what makes a
// pre-highlight pass defensible in a methods section. Transcription is the odd one
// out: it flags recogniser errors, feeding the double-click line editor.
import type { Line } from "../state/store";
import { callJson, estimateTokens, type Usage } from "./openai";
import type { Redaction } from "./redact";

export const CHUNK = 40; // lines per request — the unit of work is a window, never the corpus

// Cheap content hash (FNV-1a). Spans are stored against the hash of the line they
// were made on, so correcting a line silently invalidates them — no cache
// bookkeeping, and the AI can never point at text that no longer exists.
export function hashLine(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface Flag { quote: string; reason: string; lens: string }

export interface Lens {
  id: string;
  label: string;   // checkbox + tooltip name
  method: string;  // the coding tradition it maps to (shown as the checkbox hint)
  color: string;   // notice underline; transcription keeps its amber error style
  instruction: string;
}

export const LENSES: Lens[] = [
  {
    id: "transcription", label: "Transcription errors", method: "feeds the line editor", color: "#e0a020",
    instruction: `Mark ONLY spans the speech recogniser probably got wrong: non-words and word salad ("two dance" for "too dense"); homophone confusions ("ticket marks" for "tick marks", "guest" for "guessed"); words implausible in context, especially domain terms; garbled proper nouns. Do NOT mark informal speech, filler, false starts, or grammatical errors — real speech is messy, and that is data. note = what it probably should be.`,
  },
  {
    id: "emotion", label: "Emotional expressions", method: "emotion coding", color: "#e0554f",
    instruction: `Mark expressed feelings — frustration, delight, anxiety, relief, embarrassment — whether named ("I was so annoyed") or performed ("ugh, this again"). note = the feeling, stated neutrally.`,
  },
  {
    id: "evaluation", label: "Likes & dislikes", method: "evaluation coding", color: "#3b82c4",
    instruction: `Mark evaluative judgments about the thing being studied — likes, dislikes, praise, complaints ("the legend was useless"). note = what is judged and the valence.`,
  },
  {
    id: "desire", label: "Desires & needs", method: "dramaturgical coding", color: "#8e6bc9",
    instruction: `Mark wishes, wants, needs, and imagined improvements ("I wish it would just tell me"). note = what is wanted.`,
  },
  {
    id: "workaround", label: "Workarounds & strategies", method: "process coding", color: "#3fa860",
    instruction: `Mark described strategies or workarounds for coping with a problem ("so I zoom in and count the gridlines"). note = the strategy in a few words.`,
  },
  {
    id: "tension", label: "Tensions & contradictions", method: "versus coding", color: "#c98a2a",
    instruction: `Mark contradictions or ambivalence within the participant's own account ("it's great… but I never use it"). note = the two sides.`,
  },
  {
    id: "invivo", label: "Quotable phrasing", method: "in-vivo coding", color: "#2fa3a3",
    instruction: `Mark short, vivid, distinctive phrasings in the speaker's own words that would be worth quoting verbatim. note = why it stands out.`,
  },
];
export const lensOf = (id: string) => LENSES.find((l) => l.id === id);
// old persisted spans predate the lens field: they came from the transcription check
export const spanLens = (f: { lens?: string }) => f.lens ?? "transcription";

const PREAMBLE = `You are scanning an automatic speech-recognition transcript of a research interview. Apply ONLY the scans listed below, marking instances for the researcher to review — you never code, interpret, or summarise.

Rules for every scan:
- Each quote MUST be copied exactly, character for character, from its line.
- Mark only what is clearly present. A transcript with few or no marks is a perfectly good answer.
- Text like [REDACTED_1] is a removed identifier. Never mark it.

Scans to apply:`;

export const buildSystem = (lensIds: string[]): string =>
  PREAMBLE + "\n" + LENSES.filter((l) => lensIds.includes(l.id))
    .map((l) => `\n[${l.id}] ${l.instruction}`).join("");

const schemaFor = (lensIds: string[]) => ({
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_id: { type: "integer", description: "the id of the line the instance is in" },
          lens: { type: "string", enum: lensIds, description: "which scan this instance belongs to" },
          quote: { type: "string", description: "the exact substring, copied verbatim" },
          note: { type: "string", description: "the short note that scan asks for" },
        },
        required: ["line_id", "lens", "quote", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["flags"],
  additionalProperties: false,
});

export const chunksOf = (lines: Line[]): Line[][] => {
  const out: Line[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK) out.push(lines.slice(i, i + CHUNK));
  return out;
};

// exactly what gets sent for one chunk — also what the preview shows the user
export const renderChunk = (lines: Line[], r: Redaction): string =>
  lines.map((l) => `${l.id}\t${l.speaker}\t${r.redact(l.text)}`).join("\n");

export const estimateChunkTokens = (lines: Line[], r: Redaction, lensIds: string[]) =>
  estimateTokens(buildSystem(lensIds)) + estimateTokens(renderChunk(lines, r));

export async function scanChunk(opts: {
  key: string; model: string; lines: Line[]; lenses: string[]; redaction: Redaction; signal?: AbortSignal;
}): Promise<{ flags: Record<number, Flag[]>; usage: Usage }> {
  const { data, usage } = await callJson<{ flags: { line_id: number; lens: string; quote: string; note: string }[] }>({
    key: opts.key,
    model: opts.model,
    system: buildSystem(opts.lenses),
    user: renderChunk(opts.lines, opts.redaction),
    schemaName: "scan_instances",
    schema: schemaFor(opts.lenses),
    signal: opts.signal,
  });

  const byId = new Map(opts.lines.map((l) => [l.id, l]));
  const flags: Record<number, Flag[]> = {};
  for (const f of data.flags ?? []) {
    const line = byId.get(f.line_id);
    if (!line) continue;
    if (!opts.lenses.includes(f.lens)) continue; // schema enum should prevent this; belt and braces
    // A mark ON a placeholder is meaningless — the model never saw the real term, so
    // it cannot judge it. Restoring one would highlight the participant's actual name.
    if (opts.redaction.hasPlaceholder(f.quote)) continue;
    // Otherwise map the quote back to the real text and DROP anything that isn't a
    // genuine substring — a hallucinated quote would highlight text that isn't there.
    const quote = opts.redaction.restore(f.quote);
    if (!quote || !line.text.includes(quote)) continue;
    (flags[f.line_id] ??= []).push({ quote, reason: f.note, lens: f.lens });
  }
  return { flags, usage };
}
