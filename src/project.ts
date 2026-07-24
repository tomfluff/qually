// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The project file: everything that IS the research work, in one lossless file you
// can back up, continue on another machine, or hand to a colleague.
//
// Deliberately an explicit mapping, not JSON.stringify(store): the file format must
// not be accidentally coupled to internal state shape, or every refactor becomes a
// migration. What's in it and what's out is a decision, written down here.
//
// OUT, on purpose:
//   - the OpenAI key. It isn't in the store (see ai/key.ts) and must never ride
//     along in a file that gets emailed around.
//   - UI preferences (font size, theme, panel widths). Those are yours, not the
//     project's — a colleague opening your file shouldn't inherit your font size.
//   - the media file. Can't embed a 2GB video (and it isn't persisted today
//     anyway); the offset and filename come along so the dock can ask for it back.
//
// IN, despite living in `ui`: the speaker map. WHICH speaker is the interviewer, and
// what colour each one is, is a fact about the STUDY, not a display preference — a
// colleague opening the file should see the same people marked the same way. Optional,
// so a v1 file written before this existed still loads (openProject re-guesses).
import type { Ai, AiCall, Line, LineFlags, Segment, SpeakerWeight } from "./state/store";
import type { GroundRec } from "./ai/ground";

export const FORMAT = "qually-project";
export const VERSION = 1;

export interface Project {
  format: string;
  version: number;
  savedAt: string;
  transcripts: Record<string, { lines: Line[] }>; // Line carries `orig`, so corrections survive
  segments: Segment[];
  codebook: Record<string, { color: string; def: string; status: string }>;
  extSegRows: Record<string, string>[];
  tabs: string[];
  active: string;
  hotbar: { mode: "auto" | "pinned"; pinned: string[] };
  video: Record<string, { name?: string; offset: number }>;
  ai: Ai;
  aiFlags: Record<string, LineFlags>;
  aiGrounds?: Record<number, GroundRec>; // optional: absent in files written before F1
  aiLog: AiCall[];
  speakers?: { // optional: absent in files written before this existed
    colors: Record<string, string>;
    weight: Record<string, SpeakerWeight>;
  };
}

export interface ProjectStats {
  transcripts: number; lines: number; segments: number; codes: number;
  edits: number; notices: number; savedAt: string;
}

export function statsOf(p: Project): ProjectStats {
  const lines = Object.values(p.transcripts).reduce((n, t) => n + t.lines.length, 0);
  const edits = Object.values(p.transcripts)
    .reduce((n, t) => n + t.lines.filter((l) => l.orig !== undefined).length, 0);
  const notices = Object.values(p.aiFlags ?? {})
    .reduce((n, f) => n + f.spans.filter((s) => (s.lens ?? "transcription") !== "transcription").length, 0);
  return {
    transcripts: Object.keys(p.transcripts).length,
    lines, segments: p.segments.length, codes: Object.keys(p.codebook).length,
    edits, notices, savedAt: p.savedAt,
  };
}

export class ProjectError extends Error {}

// Refuse rather than corrupt: a file from a newer QuAlly may carry state this build
// doesn't understand, and half-loading it would silently lose work.
export function parseProject(text: string): Project {
  let o: unknown;
  try { o = JSON.parse(text); }
  catch { throw new ProjectError("That file isn't valid JSON."); }
  const p = o as Partial<Project>;
  if (p?.format !== FORMAT) throw new ProjectError("That JSON file isn't a QuAlly project.");
  if (typeof p.version !== "number") throw new ProjectError("This project file has no version and can't be read.");
  if (p.version > VERSION) {
    throw new ProjectError(`This project was saved by a newer version of QuAlly (file v${p.version}, this build reads v${VERSION}). Update QuAlly and try again.`);
  }
  if (!p.transcripts || !Array.isArray(p.segments) || !p.codebook) {
    throw new ProjectError("This project file is missing its transcripts, segments, or codebook.");
  }
  // tolerate fields added after v1 being absent
  return {
    format: FORMAT, version: p.version, savedAt: p.savedAt ?? "",
    transcripts: p.transcripts, segments: p.segments, codebook: p.codebook,
    extSegRows: p.extSegRows ?? [],
    tabs: p.tabs ?? Object.keys(p.transcripts),
    active: p.active ?? "browse",
    hotbar: p.hotbar ?? { mode: "auto", pinned: [] },
    video: p.video ?? {},
    ai: p.ai ?? { model: "gpt-5.6-luna", redactTerms: [], lenses: ["transcription"] },
    aiFlags: p.aiFlags ?? {},
    aiGrounds: p.aiGrounds ?? {},
    aiLog: p.aiLog ?? [],
    speakers: p.speakers, // may be absent — openProject re-guesses the interviewer
  };
}
