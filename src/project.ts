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
import type { Ai, AiCall, Answer, Decision, DecisionSource, Line, LineFlags, Segment, SpeakerWeight } from "./state/store";
import type { GroundRec } from "./ai/ground";
import type { Marker } from "./markers";

export const FORMAT = "qually-project";
// v2 added the AI fields on a stretch (F7: status/proposedBy/why). A file is
// only STAMPED v2 when it actually carries a proposal — see exportProject. A v1
// build reading a v2 file refuses it, which is the point: it has no notion of
// status, so it would spread the field through and count an unjudged candidate
// as a section the researcher drew. A project with no proposals in it stays v1
// and stays readable by older builds, because nothing in it can be misread.
export const VERSION = 2;

export interface Project {
  format: string;
  version: number;
  savedAt: string;
  transcripts: Record<string, { lines: Line[] }>; // Line carries `orig`, so corrections survive
  segments: Segment[];
  // colorLock (optional) records that a colour was chosen by hand, so a recolour
  // pass on another machine keeps it too. Absent in files written before it existed.
  // defAi records that a definition is untouched AI output. It has to be DECLARED,
  // not carried by accident: it survives today only because exportProject assigns
  // the live codebook and JSON.stringify keeps unknown keys, so any future
  // normalisation against this type would launder unchecked model text into the
  // file as human-written — the exact failure the def_source column exists to stop.
  // parked (optional) records a code set aside from the working codebook. Its
  // segments are untouched, so a build that does not know the flag simply shows
  // the code again — the safe direction for an unknown field.
  codebook: Record<string, { color: string; def: string; status: string; colorLock?: boolean; defAi?: boolean; parked?: boolean }>;
  extSegRows: Record<string, string>[];
  tabs: string[];
  pinnedTabs?: string[]; // optional: absent in files written before tab pinning
  active: string;
  hotbar: { mode: "auto" | "pinned"; pinned: string[] };
  video: Record<string, { name?: string; offset: number }>;
  ai: Ai;
  aiFlags: Record<string, LineFlags>;
  aiGrounds?: Record<number, GroundRec>; // optional: absent in files written before F1
  aiLog: AiCall[];
  // the decision ledger — what the researcher decided about the codebook and
  // why. Optional: absent in files written before it existed.
  ledger?: Decision[];
  markers?: Marker[]; // optional: absent in files written before session events existed
  // event-type colours, for the same reason the speaker map travels: which colour
  // "BREAK" is, is a fact about the study, not about my screen
  markerColors?: Record<string, string>;
  stretchColors?: Record<string, string>;
  // per-transcript session summaries (Summary tab) — the researcher's own artifact
  summaries?: Record<string, string>;
  // the project memo document (Notes tab) — optional: absent before it existed
  projectNotes?: string;
  projectName?: string;
  codeGroups?: { name: string; codes: string[]; rationale?: string }[];
  // the Code map's AI "areas" view, plus the codebook signature it was worked
  // out from — an AI pass is worth carrying with the project
  codeAreas?: { name: string; codes: string[]; rationale?: string }[];
  codeAreasFp?: string;
  // labelled spans of transcript (dimension:value), e.g. which condition a
  // stretch of a within-subject session came from — study data
  // status/proposedBy/why are set only on a stretch an AI proposed (F7);
  // absent means the researcher marked it themselves, which is what every
  // stretch written before F7 is. Declared rather than left to ride along on an
  // object spread — this file refuses accidental schema coupling on purpose.
  stretches?: {
    pid: string; start: number; end: number; dim: string; value: string;
    status?: "candidate" | "accepted" | "rejected"; proposedBy?: string; why?: string;
  }[];
  /** the F7 study brief: "" is the project default, a pid key overrides it */
  studyBrief?: Record<string, string>;
  codePlan?: { code: string; action: "rename" | "merge" | "remove"; newName?: string; into?: string; rationale: string }[];
  // the full cluster shape, declared: it round-trips verbatim, and a type that
  // lists half the fields tells the next reader the other half is not saved
  codeClusters?: {
    cid?: number; survivor: string; codes: string[]; newName?: string; rationale: string;
    source?: DecisionSource; model?: string;
    desc?: string; descCodes?: string[];
    against?: string; againstWeak?: boolean; againstCodes?: string[];
  }[];
  // answers to questions asked of the coded material, each with the scope and
  // model it came from — optional: absent in files written before Ask existed
  answers?: Answer[];
  speakers?: { // optional: absent in files written before this existed
    colors: Record<string, string>;
    weight: Record<string, SpeakerWeight>;
  };
}

interface ProjectStats {
  transcripts: number; lines: number; segments: number; codes: number;
  edits: number; notices: number; events: number; savedAt: string;
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
    edits, notices, events: (p.markers ?? []).length, savedAt: p.savedAt,
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
    // hand-editable like the rest of this file; a row with no kind or no code
    // list would break the exporter, so it never gets loaded
    ledger: (Array.isArray(p.ledger) ? p.ledger : []).filter((d): d is Decision =>
      !!d && typeof d.at === "string" && typeof d.kind === "string"
      && Array.isArray(d.codes) && d.codes.every((c: unknown) => typeof c === "string")),
    // hand-editable file: a malformed marker or a non-string summary would
    // throw INSIDE render, and persist would then rehydrate the same value —
    // a permanent white screen. Filter here, once, instead.
    markers: (Array.isArray(p.markers) ? p.markers : []).filter((m): m is Marker =>
      !!m && typeof m.mid === "number" && typeof m.pid === "string"
      && typeof m.event === "string" && typeof m.code === "string"
      && typeof m.label === "string" && typeof m.t === "number")
      // a hand-added row often omits the bookkeeping fields; the events
      // exporter reads raw's KEYS, so an absent one becomes empty, not a throw
      .map((m) => ({ ...m,
        detail: typeof m.detail === "string" ? m.detail : "",
        raw: m.raw && typeof m.raw === "object" && !Array.isArray(m.raw) ? m.raw : {},
      })),
    markerColors: p.markerColors ?? {},
    stretchColors: p.stretchColors ?? {},
    summaries: Object.fromEntries(Object.entries(p.summaries ?? {})
      .filter(([, v]) => typeof v === "string")) as Project["summaries"],
    projectNotes: typeof p.projectNotes === "string" ? p.projectNotes : "",
    projectName: typeof p.projectName === "string" ? p.projectName : "",
    codeGroups: Array.isArray(p.codeGroups)
      ? p.codeGroups.filter((g): g is { name: string; codes: string[]; rationale?: string } =>
          !!g && typeof g.name === "string" && Array.isArray(g.codes) && g.codes.every((c: unknown) => typeof c === "string"))
      : [],
    codeAreas: Array.isArray(p.codeAreas)
      ? p.codeAreas.filter((g): g is { name: string; codes: string[]; rationale?: string } =>
          !!g && typeof g.name === "string" && Array.isArray(g.codes) && g.codes.every((c: unknown) => typeof c === "string"))
      : [],
    codeAreasFp: typeof p.codeAreasFp === "string" ? p.codeAreasFp : "",
    // a stretch must land on lines that exist: an unknown pid is dropped, and
    // an endpoint outside (or between) the transcript's line ids snaps to the
    // nearest real line inside the range — otherwise the gutter and minimap
    // silently skip the stretch while coverage still counts it
    stretches: Array.isArray(p.stretches)
      ? p.stretches.filter((s): s is NonNullable<Project["stretches"]>[number] =>
          !!s && typeof s.pid === "string" && Number.isSafeInteger(s.start)
          && Number.isSafeInteger(s.end) && s.start <= s.end
          && typeof s.dim === "string" && typeof s.value === "string")
        .flatMap((s) => {
          const lines = p.transcripts?.[s.pid]?.lines;
          if (!lines?.length) return [];
          let start: number | undefined, end: number | undefined;
          for (const l of lines) {
            if (l.id >= s.start && l.id <= s.end) {
              if (start === undefined || l.id < start) start = l.id;
              if (end === undefined || l.id > end) end = l.id;
            }
          }
          if (start === undefined || end === undefined) return [];
          // the AI fields are VALIDATED, not spread through: an unknown status
          // would sail past every consumer's checks and be drawn as nothing
          const st: NonNullable<Project["stretches"]>[number] = { ...s, start, end };
          // An UNRECOGNISED status is coerced to "candidate", never deleted:
          // absent means "the researcher marked this themselves", so dropping a
          // typo'd or future status would launder a proposal nobody judged into
          // hand-made evidence that counts. Candidate is the safe reading — it
          // is visible, reviewable, and counts nowhere.
          if (st.status !== undefined && !["candidate", "accepted", "rejected"].includes(st.status))
            st.status = "candidate";
          if (typeof st.proposedBy !== "string") delete st.proposedBy;
          if (typeof st.why !== "string") delete st.why;
          return [st];
        })
      : [],
    // the brief: a flat string map, keys unvalidated on purpose (a pid is
    // whatever the transcripts are called) but values must be strings
    studyBrief: p.studyBrief && typeof p.studyBrief === "object" && !Array.isArray(p.studyBrief)
      ? Object.fromEntries(Object.entries(p.studyBrief).filter(([, v]) => typeof v === "string"))
      : {},
    codePlan: Array.isArray(p.codePlan)
      ? p.codePlan.filter((a): a is NonNullable<Project["codePlan"]>[number] =>
          !!a && typeof a.code === "string" && ["rename", "merge", "remove"].includes(a.action))
      : [],
    codeClusters: Array.isArray(p.codeClusters)
      ? p.codeClusters.filter((c): c is NonNullable<Project["codeClusters"]>[number] =>
          !!c && typeof c.survivor === "string" && Array.isArray(c.codes)
          && c.codes.every((x: unknown) => typeof x === "string") && c.codes.length >= 2)
      : [],
    // hand-editable like everything else here: openProject maps over these and
    // derives nextAid from them, so a malformed entry would crash the load or
    // poison the counter
    answers: (Array.isArray(p.answers) ? p.answers : []).filter((a): a is Answer =>
      !!a && Number.isSafeInteger(a.aid) && typeof a.question === "string"
      && Array.isArray(a.points) && Array.isArray(a.unsupported) && !!a.scope
      && Array.isArray(a.scope.pids) && Array.isArray(a.scope.codes)),
    speakers: p.speakers, // may be absent — openProject re-guesses the interviewer
  };
}
