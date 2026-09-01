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
// v3 added ledger kinds for verdicts and discards on proposed codings and
// sections. A v2 build reads every AI ledger row as a codebook proposal, so it
// would turn those rows into a false account of codebook consolidation.
export const VERSION = 3;

export interface Project {
  /** What parseProject had to throw away to make this file loadable. Empty for
      every well-formed file. Shown before the researcher commits to opening it,
      because statsOf counts the CLEANED project and would otherwise confirm a
      total that quietly excludes the rows that did not survive. */
  warnings?: string[];
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
  // the decision ledger — codebook changes and verdicts on proposed codings or
  // sections. Optional: absent in files written before it existed.
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
  // one per CORRECTION, not per line: a line whose transcription and its
  // translation were both corrected is two, and a project holding only
  // translation corrections used to report none at all
  const edits = Object.values(p.transcripts)
    .reduce((n, t) => n + t.lines.reduce((m, l) =>
      m + (l.orig !== undefined ? 1 : 0) + (l.enOrig !== undefined ? 1 : 0), 0), 0);
  const notices = Object.values(p.aiFlags ?? {})
    .reduce((n, f) => n + f.spans.filter((s) => (s.lens ?? "transcription") !== "transcription").length, 0);
  return {
    transcripts: Object.keys(p.transcripts).length,
    lines, segments: p.segments.length, codes: Object.keys(p.codebook).length,
    edits, notices, events: (p.markers ?? []).length, savedAt: p.savedAt,
  };
}

// Lines are hand-editable like everything else in this file, and a value of the
// wrong type here does not fail politely: `orig` and `enOrig` reach tinyDiff and
// `text`/`en` reach the excerpt rule, both inside render — and persist rehydrates
// the same value, so the white screen comes back every time the app is opened.
// The same reasoning, and the same cure, as the markers filter below: fix it
// once, at the boundary, rather than guarding every reader.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
function cleanTranscripts(t: Project["transcripts"]): Project["transcripts"] {
  return Object.fromEntries(Object.entries(t).map(([pid, tr]) => [pid, {
    ...tr,
    lines: (Array.isArray(tr?.lines) ? tr.lines : [])
      // a line with no id is not a line: every range, binary search and segment
      // in the project is keyed by it
      .filter((l): l is Line => !!l && Number.isFinite((l as Line).id))
      // SPREAD first, then fix the fields this build knows. A whitelist would
      // delete anything a newer build had written — and the version only bumps
      // on a semantic change, so a same-version file from a slightly newer
      // QuAlly would quietly lose its new field on a load-and-save. An unknown
      // field is inert; a known field of the wrong type is the danger.
      .map((l) => {
        const out: Line = { ...l, id: l.id, ts: str(l.ts) ?? "", speaker: str(l.speaker) ?? "P",
          text: str(l.text) ?? "" };
        // the optional four: absent where the file says something that is not
        // text, rather than carried through to throw inside render
        const end = str(l.end)?.trim();
        if (end) out.end = end; else delete out.end;
        for (const k of ["orig", "en", "enOrig"] as const) {
          const v = str(l[k]);
          if (v === undefined) delete out[k]; else out[k] = v;
        }
        // a pre-correction translation with no translation to be the original OF
        // would make the edit mark diff English against the source
        if (out.en === undefined) delete out.enOrig;
        // `src` is runtime-only: viewLines puts it on a RESOLVED copy to carry
        // the spoken words beside a translation, and the excerpt rule weighs it
        // over `text`. A stored one — which only a hand-edited file can have —
        // would decide which speaker a code quotes, from a field nothing writes.
        delete out.src;
        return out;
      }),
  }]));
}

export class ProjectError extends Error {}

// The three the filters above forgot, and the three that white-screen hardest.
// A project file is hand-editable and nothing else validates it: a wrong-typed
// value that reaches .trim() or .map() INSIDE render throws on every frame, and
// persist then rehydrates the same value, so the app never comes back. Worse
// here than anywhere: openProject has already replaced the workspace by the time
// render throws, so the researcher is left with neither project.
//
// Everything is repaired rather than dropped where a repair is obvious, because
// a segment IS someone's coding — losing it silently is the thing this whole
// module exists to prevent. Only a row with no usable identity goes.
const text = (v: unknown, fallback = "") => str(v) ?? fallback;
// Coerced, not just type-checked: quoting a number is the commonest thing a
// hand-edit does to JSON, and dropping a whole coding over a pair of quotes is
// exactly the silent loss this module exists to prevent. Anything that is not a
// finite whole number still goes.
/** The non-transcript views `active` may name, beside a loaded transcript. */
const VIEWS = new Set(["browse", "summary", "notes", "assist", "map"]);
const STATUSES = new Set(["accepted", "rejected", "candidate"]);
/** The next id nothing else holds. `max + 1` is not enough on its own: one row
    carrying MAX_SAFE_INTEGER makes every later id unsafe, and then consecutive
    additions collide on the same one. */
const nextFree = (taken: Set<number>, from: number) => {
  let n = from + 1;
  while (taken.has(n) || !Number.isSafeInteger(n)) n = Number.isSafeInteger(n) ? n + 1 : 1;
  return n;
};
const int = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

function cleanSegments(v: unknown, note?: (s: string) => void): Segment[] {
  if (!Array.isArray(v)) return [];
  const out: Segment[] = [];
  const sids = new Set<number>();
  let maxSid = 0;
  let dropped = 0;
  for (const r of v) {
    if (!r || typeof r !== "object") { dropped++; continue; }
    const x = r as Record<string, unknown>;
    const start = int(x.start), end = int(x.end), sid = int(x.sid);
    // no span and no id is not a coding anyone can act on or undo
    if (start === null || end === null || sid === null) { dropped++; continue; }
    // the SAME contract importSegments and remapSegment hold: a negative start
    // exports a segment_ref the importer cannot parse, and a span of billions
    // makes remapSegment enumerate every integer in it and hang. Accepting a
    // row here that those two refuse is how a file loads and then breaks later.
    if (Math.min(start, end) < 0 || Math.abs(end - start) > 9999) { dropped++; continue; }
    const pid = text(x.pid);
    if (!pid) { dropped++; continue; }
    // Two rows sharing a sid is the same corruption class as the NaN one:
    // deleteSegment would remove both, setStatus flip both, and every grounding
    // collide on one key. Renumber rather than drop — the second row is still
    // someone's coding.
    const id = sids.has(sid) ? nextFree(sids, maxSid) : sid;
    sids.add(id);
    maxSid = Math.max(maxSid, id);
    out.push({
      // SPREAD FIRST, then fix the known fields — the rule cleanTranscripts
      // states above and this function was breaking: building a fresh object
      // deletes any field a NEWER build of QuAlly wrote, so opening a colleague's
      // file and saving it stripped everything this build does not know about.
      ...(r as object),
      sid: id, pid, start: Math.min(start, end), end: Math.max(start, end),
      code: text(x.code), notes: text(x.notes),
      // the same repair onRehydrateStorage makes: an unsigned row reads as a
      // bug in the intercoder column, never as an empty string
      proposedBy: text(x.proposedBy).trim() || "(default)",
      // Coerced to the set the app draws, like stretches below: TranscriptView
      // gives only an explicit "accepted" the solid bar. An ABSENT status is a
      // file from before the field and means accepted; a PRESENT but unreadable
      // one is not a verdict anyone passed, and promoting it to accepted would
      // add evidence to a code's counts and to the export.
      status: x.status === undefined ? "accepted"
        : STATUSES.has(text(x.status)) ? text(x.status) : "candidate",
    });
  }
  if (dropped) note?.(`${dropped} segment row${dropped === 1 ? "" : "s"} could not be read`);
  return out;
}

function cleanCodebook(v: unknown): Project["codebook"] {
  // A NULL-PROTOTYPE map: a code legitimately named "__proto__" assigned into a
  // plain object mutates that object's prototype instead of adding a key, and
  // the code vanishes. Rare, but it is a name someone can type.
  const out = Object.create(null) as Project["codebook"];
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...out };
  for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
    if (!name) continue;
    // A usable KEY with an unusable value is still a code the researcher made,
    // and its segments still name it — dropping the entry would leave those
    // segments pointing at nothing. Repair to defaults instead.
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    out[name] = {
      ...(e && typeof e === "object" ? e : {}),   // keep a newer build's fields
      color: text(x.color) || "#888888",
      def: text(x.def),
      status: text(x.status) || "candidate",
      ...(typeof x.colorLock === "boolean" ? { colorLock: x.colorLock } : {}),
      ...(typeof x.defAi === "boolean" ? { defAi: x.defAi } : {}),
      ...(typeof x.parked === "boolean" ? { parked: x.parked } : {}),
    };
  }
  return { ...out };
}

// Tabs.tsx maps over this every render, so a string here is a white screen.
// Names that no longer have a transcript are dropped rather than kept as a tab
// that cannot open.
function cleanTabs(v: unknown, transcripts: unknown): string[] {
  const have = transcripts && typeof transcripts === "object" ? transcripts as object : {};
  const known = new Set(Object.keys(have));
  if (!Array.isArray(v)) return [...known];
  const seen = new Set<string>();
  return v.filter((t): t is string =>
    typeof t === "string" && known.has(t) && !seen.has(t) && !!seen.add(t));
}

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
  // What the filters above had to throw away. A dropped segment is someone's
  // coding, and statsOf runs on the CLEANED project — so the open dialog would
  // otherwise confirm "480 segments" for a file holding 483 and the researcher
  // would open it, work, and save the loss over their only copy. The file on
  // disk is untouched until they do, which is exactly why they have to be told
  // before they get that far.
  const warnings: string[] = [];
  // tolerate fields added after v1 being absent
  return {
    warnings,
    format: FORMAT, version: p.version, savedAt: p.savedAt ?? "",
    transcripts: cleanTranscripts(p.transcripts),
    segments: cleanSegments(p.segments, (m) => warnings.push(m)),
    codebook: cleanCodebook(p.codebook),
    // rows, not values: exportCSV now unions their KEYS into the header, so a
    // null or a string here is a TypeError inside the export rather than an odd
    // row — and a string would spread its char indices in as columns
    // rows AND their values: exportCSV unions their keys into the header and
    // calls .trim() on proposed_by, so a non-object row or a non-string value is
    // a TypeError inside the export rather than an odd row
    extSegRows: (Array.isArray(p.extSegRows) ? p.extSegRows : [])
      .filter((r) => !!r && typeof r === "object" && !Array.isArray(r))
      .map((r) => Object.fromEntries(Object.entries(r as object)
        .filter(([, v]) => typeof v === "string")) as Record<string, string>),
    tabs: cleanTabs(p.tabs, p.transcripts),
    // written by exportProject and never read back, so pin order died on every
    // save-and-reopen. NOT cleanTabs's fallback though: absent `tabs` means
    // "open them all", while absent `pinnedTabs` means "none pinned" — reusing
    // the fallback pinned every transcript in every older file.
    pinnedTabs: Array.isArray(p.pinnedTabs) ? cleanTabs(p.pinnedTabs, p.transcripts) : [],
    // read as transcripts[active] during render, so an object here throws
    // "Cannot convert object to primitive value" on every frame — and persist
    // rehydrates it, so the white screen never lifts. A name that is neither a
    // reserved view nor a loaded transcript cannot open either.
    active: typeof p.active === "string"
      && (VIEWS.has(p.active) || (!!p.transcripts && p.active in p.transcripts))
      ? p.active : "browse",
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
