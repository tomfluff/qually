// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { markHydrated, projectStorage, setOnSaveResult } from "./persistence";
import { parseCSV, toCSV } from "../contract/csv";
import { collapseRuns, formatSegRef, norm, type CodedLine } from "../contract/segments";
import { excerptOf, RESEARCHER } from "../contract/excerpt";
import { mergeGroups, type Group } from "../merge";
import { replaceAllIn, scopeFilter, type LineScope } from "../search";
import { previewImport, remapSegment, type ImportPreview } from "../align";
import { DEFAULT_MODEL } from "../ai/openai";
import { hashLine, spanLens, type Flag } from "../ai/flag";
import type { GroundRec } from "../ai/ground";
import { FORMAT, VERSION, parseProject, type Project } from "../project";
import type { Stretch, StretchStatus } from "../stretches";
import type { SectionProposal } from "../sections";
import { isMarkerRows, markerIdent, markerKey, markerRows, parseMarkers, type Marker } from "../markers";
import { DEFAULT_ACCENT } from "../palettes";
import { viewLines, type Lang } from "../lineText";
import { forgetScroll, renameScroll } from "../scrollMemory";
import { projectSwapped } from "../sessionReset";
import { PALETTE, pickNewColor, recolorPlan, conflictGraph } from "../codeColors";
import { announce } from "../announce";
// earcons imports this store back, but only reads it inside call bodies — the
// cycle never resolves at module-eval time. Sounding undo HERE covers the
// keyboard and the toolbar buttons at once, instead of at every caller.
import { earcon } from "../earcons";
import { SORTS, type SortBy } from "../codeStats";

// The code palette (codeColors.ts owns it, and the assignment logic with it).
// The colour picker offers exactly what auto-assignment can hand out, so a
// hand-picked colour and a generated one come from one vocabulary.
export const COLORS = PALETTE;

/** the working codebook: everything you have NOT set aside (see `parked`) */
export const liveCodes = (cb: State["codebook"]): string[] =>
  Object.keys(cb).filter((c) => !cb[c].parked);
export const parkedCodes = (cb: State["codebook"]): string[] =>
  Object.keys(cb).filter((c) => cb[c].parked);

// `active` is a transcript pid or one of these reserved view keys (Codebook / Assist).
// Both are non-transcript surfaces, so transcript-only chrome and selection bookkeeping
// gate on isTranscriptView.
const RESERVED_VIEWS = ["browse", "assist", "summary", "notes", "map"] as const;
export const isTranscriptView = (active: string) => !RESERVED_VIEWS.includes(active as typeof RESERVED_VIEWS[number]);

// orig = the imported text, present only while an in-app correction differs from it
// end (optional end_timestamp column) is when the line stops being spoken —
// the pause-merge rule prefers it over estimating from the text's length
interface AnswerPoint { text: string; refs: string[] }
export interface Answer {
  aid: number;
  at: string;               // ISO, and the sort key
  question: string;
  points: AnswerPoint[];
  unsupported: string[];    // what the material could not carry
  scope: { pids: string[]; codes: string[]; events: boolean; excerpts: boolean };
  model: string;
  costUsd: number;
}

// en (optional text_en column) is a translation of `text`. Which of the two a
// surface uses is decided in ONE place — see lineText.ts — never re-derived.
// `src` is never stored or exported — viewLines adds it to a RESOLVED line to
// carry what was spoken alongside the words being shown (see lineText.ts).
export interface Line { id: number; ts: string; speaker: string; text: string; end?: string; orig?: string; en?: string; src?: string; }

/** A transcript's lines in the language the study is being read in.
    Every surface that turns lines into evidence — an excerpt, an export, an AI
    payload — comes through here rather than reaching for `.lines` directly, so
    what a code quotes and what you are reading can never disagree. Hands back
    the stored array untouched when reading the source, which is every project
    that carries no translation. */
export const linesOf = (
  transcripts: Record<string, { lines: Line[] }>, lang: Lang, pid: string,
): Line[] => viewLines(transcripts[pid]?.lines ?? [], lang) as Line[];
// The selection ring's weight is the researcher's call: what reads as clear
// at one pair of eyes and one screen reads as either invisible or shouting at
// another, and this map is navigated by selection.
type MapRingSize = "xs" | "sm" | "md" | "lg" | "xl";
export const MAP_RING_PX: Record<MapRingSize, number> = { xs: 1, sm: 2, md: 4, lg: 6, xl: 8 };

export interface Segment {
  sid: number; pid: string; start: number; end: number; code: string;
  notes: string; proposedBy: string; status: string;
}
// One spelling at every write and read edge: provenance detection must not drift
// from the label the proposal modals persist into project files.
export const AI_PROPOSED_BY_PREFIX = "AI · ";
const isAiProposed = (proposedBy?: string): proposedBy is string =>
  proposedBy?.startsWith(AI_PROPOSED_BY_PREFIX) ?? false;
export interface CodeGroup { name: string; codes: string[]; rationale?: string }
// a pending reconciliation proposal (Code map): reviewed one verdict at a time
interface CodePlanAction {
  code: string; action: "rename" | "merge" | "remove";
  newName?: string; into?: string; rationale: string;
  // where the proposal came from, so the ledger row it eventually writes can
  // say so. Absent on proposals made before this existed, and on hand-made
  // ones, which are the researcher's by definition.
  source?: DecisionSource; model?: string;
}
// a pending merge-CLUSTER: 2+ member codes proposed as ONE concept. survivor is
// one of the members; newName optionally renames the merged concept. Persisted
// as a sibling of codePlan so older app versions simply ignore it.
// Every view that owns hand-placed positions gets its own slot. The AI areas
// view earns one because filing a code there used to write into whichever
// stage was behind it — silently deleting a position the researcher had placed
// in Reconcile or Themes, and burning an undo entry to do it. The bucket views
// deliberately have NO slot: their piles are derived from counts and drift as
// you code, so a remembered spot inside "2-5 excerpts" is garbage the moment a
// code becomes a 6-excerpt code. Those keep a session-only overlay instead.
export type MapStage = "reconcile" | "themes" | "areas";
type StageLayout = Record<MapStage, Record<string, { x: number; y: number }>>;
const emptyLayout = (): StageLayout => ({ reconcile: {}, themes: {}, areas: {} });

interface CodeCluster {
  // A capsule's IDENTITY, and the only stable thing about it. The map keys a
  // hand-placed capsule's position by this, because the list index is not
  // identity: accept or dismiss one proposal and every later capsule would
  // inherit its neighbour's remembered spot. Optional so a project written
  // before it existed still loads — stampCids fills those in on the way in.
  cid?: number;
  survivor: string; codes: string[]; newName?: string; rationale: string;
  // same as CodePlanAction: whose idea this merge was (see Decision)
  source?: DecisionSource; model?: string;
  // an AI-generated glimpse of what this group means (halo menu), persisted,
  // with the membership it described — a drifted membership marks it stale
  desc?: string;
  descCodes?: string[];
  // the case AGAINST this merge, when the researcher asked for one. Kept with
  // the membership it argued about, for the same reason, and with whether the
  // model found no real case — an objection and a shrug must not read alike.
  against?: string;
  againstWeak?: boolean;
  againstCodes?: string[];
}
export interface Selection { pid: string | null; anchor: number | null; head: number | null; lines: Set<number>; }
export interface Ui {
  fontSize: number; sidebarFontSize: number; dark: boolean; zen: boolean;
  sidebarWidth: number; browseLeftWidth: number;
  // the Code map's camera: survives tab switches AND reloads
  mapViewport: { x: number; y: number; zoom: number } | null;
  // earcons on the Code map (multimodal confirmation for low-vision use)
  mapSounds: boolean;
  soundVolume: number; // multiplier on the earcon gains: 1 = designed level, 0..2
  /** stretch gutter: band thickness and the room reserved for labels */
  stretchBand: "xs" | "sm" | "md" | "lg";
  stretchLabel: "sm" | "md" | "lg";
  /** how heavy the Code map's selection ring paints, in SCREEN px at any zoom */
  mapRing: MapRingSize;
  mapMinimap: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  // where popup cards open — the code palette (0) AND the add-event card:
  // "auto" anchors to the lines/dock they are about, "centered" always centers.
  // (Key name predates the event card; kept so persisted states stay valid.)
  palettePos: "auto" | "centered";
  helpSeen: boolean;
  mergeLines: boolean; // merge partial (non-terminated) same-speaker lines into one unit
  mergeGapOn: boolean; // also merge same-speaker lines that start close together
  mergeGap: number;    // "close" = next line starts within this many seconds
  showLineNumbers: boolean;
  accent: string; // primary-color palette id (see palettes.ts)
  speakerNames: "full" | "short"; // transcript speaker column: full label or first 3 chars
  fontFamily: "system" | "serif" | "atkinson"; // reading font for transcript + excerpts
  warnCorner: "left" | "right"; // close-call badge corner
  warnSize: "xs" | "sm" | "md" | "lg"; // close-call badge size
  laneWidth: "xs" | "sm" | "md" | "lg"; // width of the code lane bars
  minimapWidth: number; // transcript minimap width (px)
  minimapDetail: "detailed" | "simplified"; // minimap abstraction level
  showNotices: boolean; // AI noticing highlights visible (hide to read/code blind)
  hiddenLenses: string[]; // noticing lenses filtered out while showNotices is on
  lanePattern: boolean; // give each code a pattern as well as a colour (see patternOf)
  scrollSpeed: number; // wheel distance multiplier for the transcript (1 = device default)
  /** Which text of a line this study is working in. NOT display-only: the
      excerpt a code carries, what an export writes and what a model is shown
      all follow it, so the evidence and what you are reading can never
      disagree. Inert for a transcript with no text_en, where both resolve to
      the same words. */
  lang: Lang;
  loopEdit: boolean; // loop the utterance's audio while its line is being edited
  loopSpeed: number; // playback rate while looping (independent of the dock's rate)
  // isolate one speaker's dialogue, PER TRANSCRIPT (focus is a lens on a study
  // file, not a global): pid -> speaker name; absent = everyone
  speakerFocus: Record<string, string>;
  /** How loudly the section gutter reads: as marked, quieted, or away
      altogether. A display setting sitting beside the focus lenses because it
      answers the same question they do — what am I reading right now — and
      independent of them: quieting the sections has nothing to do with which
      speaker you are following. */
  stretchView: "show" | "dim" | "collapse";
  // which Assist-tab panel is showing — chosen from the tab's own menu
  assistPanel: "observations" | "merge" | "suggest" | "sections" | "summary" | "describe" | "ask" | "decisions" | "tail";
  // what the thin-tail queue counts as thin (1, 2 or 3 excerpts) — the
  // researcher's call, and the map's launcher can set it on the way in
  tailLimit: number;
  /** the thin tail's scope: everything thin, or only the codes you set aside */
  tailScope: "all" | "parked";
  /** the Codebook's set-aside shelf: its height when open (see eventListHeight) */
  parkListHeight: number;
  // the Summary tab's split between the detailed timeline and the summary text:
  // side by side, stacked, or one pane at a time. The split position is a fraction
  // of the container (not px) so it survives both orientations and window resizes.
  summaryLayout: "side" | "stack" | "one";
  summarySplit: number;
  // the sidebar's session-events list: how tall (px, dragged) and how ordered.
  // "type" groups by event/code (what kinds of things happened); "time" is one flat
  // run down the session (what happened next) — the two ways anyone reads a log.
  eventListHeight: number;
  eventSort: "type" | "time";
  // the transcript sidebar's code list order — the same three orders the Assist
  // definitions panel offers, so a list of codes reads the same in both places
  codeSort: SortBy;
  // chosen colours per event type (right-click the type). Unset = the stable hash
  // colour from markers.ts, so this stays empty until someone actually picks one.
  markerColors: Record<string, string>;
  // hand-picked stretch value colours, keyed by lowercased/trimmed value —
  // overriding the hash-derived default (see stretchColorOf)
  stretchColors: Record<string, string>;
  // grounding emphasis in Browse excerpts — independent, combinable (D6)
  groundBold: boolean; groundWash: boolean; groundUnderline: boolean;
  // how the OTHER speakers' rows step back — independent, combinable effects
  focusDim: boolean;      // whole row drops via opacity
  focusCollapse: boolean; // row folds to one ellipsised line
  speakerColors: Record<string, string>; // per-speaker overrides; unset = speakerColor()
  // How loudly each speaker's words are set. "quiet" is usually the interviewer, so the
  // participants carry the page; "bold" is the one you're following. Unset = normal.
  speakerWeight: Record<string, SpeakerWeight>;
  coderName: string; // written as proposed_by on segments created in this browser
}
export type SpeakerWeight = "quiet" | "normal" | "bold";
const DEFAULT_UI: Ui = {
  fontSize: 16, sidebarFontSize: 13, dark: false, zen: false, lang: "source",
  sidebarWidth: 250, browseLeftWidth: 264, mapMinimap: "bottom-right",
  mapViewport: null, mapSounds: true, soundVolume: 1, mapRing: "md",
  palettePos: "auto", helpSeen: false, mergeLines: false, mergeGapOn: false,
  mergeGap: 3, showLineNumbers: false, accent: DEFAULT_ACCENT,
  speakerNames: "full", fontFamily: "system", warnCorner: "right",
  warnSize: "sm", laneWidth: "md", minimapWidth: 66,
  minimapDetail: "detailed", showNotices: true, hiddenLenses: [],
  lanePattern: false, scrollSpeed: 1, loopEdit: true, loopSpeed: 0.75,
  speakerFocus: {}, stretchView: "show", focusDim: true,
  focusCollapse: false, assistPanel: "observations", tailLimit: 1, tailScope: "all", parkListHeight: 160,
  stretchBand: "sm", stretchLabel: "md", eventListHeight: 200,
  eventSort: "type", codeSort: "name", markerColors: {}, stretchColors: {},
  summaryLayout: "side", summarySplit: 0.5, groundBold: true,
  groundWash: true, groundUnderline: false, speakerColors: {},
  speakerWeight: {}, coderName: "",
};

// Persist only keys in today's schema. Deriving the allowlist from the defaults
// means deleting the next Ui field also deletes its stale persisted value.
// A hand-edited or older persisted ui can carry anything here. Anything that is
// not "en" reads as the source everywhere else; clamping it means the export
// cannot grow an excerpt_source column that merely duplicates excerpt.
export const asLang = (v: unknown): Lang => (v === "en" ? "en" : "source");

const currentUi = (ui: Ui): Ui => Object.fromEntries(
  (Object.keys(DEFAULT_UI) as (keyof Ui)[]).map((key) => [key, ui[key] ?? DEFAULT_UI[key]]),
) as unknown as Ui;
// the loop-speed stops (Settings seg + the edit bar's cycler) — one list, two UIs
export const LOOP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const UNDO_CAP = 80; // one cap for BOTH push sites (pushUndo and editLine)
// minimap width bounds — used by the Resizer clamp AND the rehydrate migration
export const clampMinimapWidth = (w: number) =>
  Number.isFinite(w) ? Math.max(64, Math.min(256, w)) : 66; // NaN slips through ?? — catch it here
// events list height bounds — the drag handle and the rehydrate default share them
export const clampEventHeight = (h: number) =>
  Number.isFinite(h) ? Math.max(72, Math.min(720, h)) : 200;
// summary split bounds — neither pane may vanish under the drag
export const clampSummarySplit = (f: number) =>
  Number.isFinite(f) ? Math.max(0.05, Math.min(0.95, f)) : 0.5;
export interface Search extends LineScope {
  open: boolean; query: string; scope: "tab" | "all";
  current: { line: number; occ: number } | null; // the emphasized occurrence
  // speaker/range (from LineScope) narrow WHICH LINES the query is allowed to
  // find — and, when Replace All runs, which lines it is allowed to rewrite.
}
// A closed bar, with nothing left over from the last search — the filter
// included: a speaker or a range still set the next time the bar opens would
// quietly hide hits the researcher never asked to hide.
export const NO_SEARCH: Search = { open: false, query: "", scope: "tab", current: null, speaker: "", range: "" };
// A re-import of an already-coded transcript, held until the user picks what to do.
interface PendingImport {
  pid: string;
  lines: Line[];
  rows: Record<string, string>[]; // kept for the inline `codes` column
  preview: ImportPreview;
}
type ImportChoice = "update" | "replace" | "new" | "cancel";

// A re-imported segment row that would OVERWRITE an existing segment's status or
// notes — held for consent (the transcript re-import modal is the same idea).
export interface SegUpdate {
  sid: number; ref: string; code: string;
  from: { status: string; notes: string };
  to: { status: string; notes: string };
}

// AI settings. The API key is NOT here — the project state is autosaved and exported,
// so the key lives in ai/key.ts (session-only by default). See docs in that file.
export interface Ai {
  model: string;
  redactTerms: string[]; // participant names / orgs / places, pseudonymized before sending
  lenses: string[];      // which scans are ticked in the consent modal (remembered)
}
// Spans are stored against the hash of the line text they were made on, so editing a
// line silently invalidates them — the AI can never point at text that's gone.
// `lenses` records which scans this line has been checked under at that hash: a line
// already scanned under every requested lens isn't re-sent (or re-billed).
export interface LineFlags { hash: string; lenses?: string[]; spans: Flag[] }
// Every call, appended. Exportable as the appendix that lets a reviewer audit what
// the model was actually used for.
export interface AiCall {
  at: string; model: string; task: string; pid: string;
  lines: number; redactions: number; inTok: number; outTok: number; costUsd: number;
  /** How the run ENDED. Absent means it completed — which is what every entry
      written before this field existed was. A request that was dispatched and
      then aborted, or that failed after dispatch, still sent the transcript: the
      disclosure happened, and a provenance log that omits it is claiming to be
      complete while being wrong in the one direction that matters. Token counts
      and cost are what the API reported, so they are 0 when it reported nothing;
      the money may still have been spent. */
  outcome?: "aborted" | "failed";
}

// The DECISION ledger, the other half of the provenance story. aiLog records
// what was ASKED of the model; this records what the researcher DID — changes
// to the codebook and verdicts on proposed codings and sections, with the reason
// and where the idea came from. Undo cannot unwrite history, so an undone
// decision is FLAGGED
// rather than dropped (see snapshot/restore): "I merged these and then thought
// better of it" is itself part of the record, and silently deleting the row
// would make the ledger a story about a researcher who never changed their mind.
type DecisionKind =
  | "merge" | "rename" | "remove" | "delete"   // wired today
  | "keep" | "park" | "unpark" | "dismiss" // the tail queue's outcomes
  | "define" // tell-apart's "that is the difference" — it WRITES definitions
  | "accept-coding" | "reject-coding" | "discard-coding"
  | "accept-section" | "reject-section" | "discard-section";
/** where the idea came from — NOT who performed it. Every decision is the researcher's. */
export type DecisionSource = "you" | "wording" | "ai";
/** decisions that record a judgement without changing anything (see restore) */
const INERT_DECISIONS = new Set<DecisionKind>(["keep"]);
export interface Decision {
  at: string;              // ISO
  kind: DecisionKind;
  codes: string[];         // what it touched; for a merge, survivor first
  why: string;             // the rationale, in whoever's words proposed it
  source: DecisionSource;
  model?: string;          // set when source is "ai"
  undone?: boolean;        // reversed by undo, kept for the record
  // the SIZE of what happened, counted when it happened. A merge of two
  // one-excerpt codes and a merge that folds 30 excerpts into a code are the
  // same row without these, and they are not the same decision — this is also
  // the only place the number survives, since the codes it counted are gone.
  moved?: number;          // codings/sections settled, or excerpts changed/rejected/deleted
  now?: number;            // excerpts the surviving code carries afterwards
  // Set when the researcher recorded a verdict BEFORE seeing the model's (the
  // Consolidate view's blind order). It is the number a methods section can
  // actually use: "the researcher and the model agreed on 34 of 41 proposals".
  blind?: "agreed" | "differed";
}

const decisionSourceOf = (proposedBy?: string): Pick<Decision, "source" | "model"> =>
  isAiProposed(proposedBy)
    ? { source: "ai", model: proposedBy.slice(AI_PROPOSED_BY_PREFIX.length) }
    : { source: "you" };

// A batch names a model only when that attribution is true of the whole gesture.
// Different models still mean the ideas came from AI; erasing that source would
// turn a provenance field into a record of who clicked the button instead.
const batchDecisionSource = (items: { proposedBy?: string }[]): Pick<Decision, "source" | "model"> => {
  const sources = items.map((x) => decisionSourceOf(x.proposedBy));
  if (!sources.length || sources.some((p) => p.source !== "ai")) return { source: "you" };
  const model = sources[0].model;
  return model && sources.every((p) => p.model === model)
    ? { source: "ai", model }
    : { source: "ai" };
};

const distinct = (values: string[]) => [...new Set(values)];

const sectionDecisionLabels = (items: Pick<Stretch, "dim" | "value">[]) =>
  // Decision.codes is also the panel/export's stable list of things touched.
  // Sections have no code identity, so their dimension:value label occupies that
  // field; consumers use the row kind to keep it out of code links and history.
  distinct(items.map((x) => `${x.dim}: ${x.value}`));

export interface State {
  transcripts: Record<string, { lines: Line[] }>;
  segments: Segment[];
  // colorLock marks a colour the researcher chose by hand (the picker), so a
  // recolour pass can be told to keep it and work around it
  // defAi: the definition text is untouched AI output. Any manual input — hand-
  // written, or an AI draft edited before/after apply — clears it, so the UI can
  // mark AI-only definitions apart from ones a person has shaped.
  // parked: set aside from the WORKING codebook without touching a single
  // excerpt. Not a rejection (that says the codings were wrong) and not a
  // deletion (that loses them): it is "not part of my analysis right now", the
  // outcome a thin code needs when neither keeping nor destroying it is honest.
  // Its segments stay exactly as they are; only the lists you code from stop
  // offering it. See parkedOut()/liveCodes() below.
  codebook: Record<string, { color: string; def: string; status: string; colorLock?: boolean; defAi?: boolean; parked?: boolean }>;
  extSegRows: Record<string, string>[];
  tabs: string[];
  pinnedTabs: string[]; // pids pinned to the FRONT of the tab list, in pin order
  active: string;
  hotbar: { mode: "auto" | "pinned"; pinned: string[] };
  hotbarCache: string[];
  video: Record<string, { name?: string; offset: number }>;
  ui: Ui;
  ai: Ai;
  aiFlags: Record<string, LineFlags>; // "pid:lineId" -> flags, valid while the hash matches
  aiGrounds: Record<number, GroundRec>; // sid -> grounding quotes, valid while the hash matches
  aiLog: AiCall[];
  // every decision the researcher made about the codebook (see Decision)
  ledger: Decision[];
  // session event log (see markers.ts): imported per transcript from the tab menu.
  // Positions are derived from the time, never stored — so they follow the video offset.
  markers: Marker[];
  // per-transcript session summary (the Summary tab's text pane): written by the
  // researcher, or AI-drafted and then owned by the researcher. Project data.
  summaries: Record<string, string>;
  // the project memo document (Notes tab): one free-form text, analytic memos +
  // stamped breadcrumbs. Study data — travels with the project file.
  projectNotes: string;
  // the study's name: leads every exported filename. Study data, travels with the file.
  projectName: string;
  // similarity groupings on the Code map (AI-proposed, then user-edited).
  // Analysis metadata, travels with the project file.
  codeGroups: CodeGroup[];
  // The Code map's AI "areas" view: a coarse shelf per code, worked out by one
  // AI pass. It costs a request, so it lives in the project rather than the
  // session — and carries the codebook signature it was computed from, so the
  // map can say when it has drifted.
  codeAreas: CodeGroup[];
  codeAreasFp: string;
  /** labelled spans of transcript — "these lines are the baseline condition";
      dimension:value pairs, overlapping freely (see stretches.ts) */
  stretches: Stretch[];
  /** The study brief, per F7: prose about how the session ran plus the bulleted
      axes a section may be labelled with (see sections.ts). `""` holds the
      project default; a pid key overrides it for that transcript alone. Study
      data — it describes the study, so it travels with the project file.
      An override is REMOVED by deleting its key: storing "" would read as a
      deliberate empty override and suppress the default. */
  studyBrief: Record<string, string>;
  // the pending revision plan from the last reconcile run — study data too:
  // the review can continue in a later session
  codePlan: CodePlanAction[];
  codeClusters: CodeCluster[];
  // Code map layout positions (session-only: ride the undo history, never the
  // project file). Keys: chip name or island/orbit node id.
  // Reconcile and Themes are different stages showing different structures
  // (merge capsules vs theme islands), so they keep SEPARATE layouts: laying
  // one out, tidying it, or resetting it must never disturb the other.
  mapPositions: StageLayout;
  mapIslandPos: StageLayout;
  // the transcript you were last ON (session-only): the Notes stamp and other
  // "what was I just doing" readers need it after you switch to a reserved view
  lastPid: string;

  // Answers to questions asked of the coded material (Assist -> Ask). Study
  // artifacts, not chat: each carries the scope and model it came from, because
  // an answer whose corpus can't be reconstructed is evidence of nothing.
  answers: Answer[];
  nextAid: number;
  // transient (not persisted)
  selection: Selection;
  savedSelections: Record<string, Selection>; // each tab's parked selection, restored on return
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  selRun: boolean; // top undo entry already captures the state before this run of selection-only changes
  nextSid: number;
  nextMid: number;
  jump: { pid: string; line: number } | null;
  paletteOpen: boolean;
  // an add-event card asked for from OUTSIDE the transcript rows — the video dock's
  // mark button, or E with nothing selected. Transcript-clock seconds, so it goes
  // into the card the same way a right-clicked line's time does. Session-only.
  eventAt: number | null;
  formatOpen: boolean;
  search: Search;
  pendingImports: PendingImport[]; // re-imports awaiting a user decision
  pendingProject: Project | null;  // a loaded project awaiting the replace confirmation
  pendingSegUpdates: SegUpdate[];  // status/notes overwrites awaiting consent
  pendingImportSign: { sids: number[] } | null; // just-imported (default) rows: "whose are these?"
  pendingCoderAsk: boolean; // a transcript is loaded but the coder is still (default): "who's coding?"
  saveFailed: boolean; // browser persistence write failed — autosave is NOT happening

  importFiles: (files: FileList | File[]) => Promise<void>;
  newProject: () => void;
  resolveImport: (choice: ImportChoice) => void;
  resolveSegUpdates: (apply: boolean) => void;
  resolveImportSign: (name: string | null) => void;
  resolveCoderAsk: (name: string | null) => void;
  ensureCode: (code: string) => string;
  /** returns false when the span was already coded that way (a dedup) */
  addSegment: (pid: string, start: number, end: number, code: string,
    proposedBy?: string, status?: string, notes?: string) => boolean;
  applyCode: (code: string) => void;
  selectLine: (id: number, opts?: { extend?: boolean; toggle?: boolean }) => void;
  moveSelection: (dir: -1 | 1, extend: boolean) => void;
  startSelection: (id: number) => void;
  clearSelection: () => void;
  setActive: (pid: string) => void;
  closeTab: (pid: string) => void;
  // Forget a transcript entirely: its lines, coding, events, summary and marks.
  // Not undoable (snapshots don't carry transcripts), so the caller confirms.
  deleteTranscript: (pid: string) => void;
  // reopen a loaded transcript whose tab was closed (the data never left)
  openTab: (pid: string) => void;
  togglePinTab: (pid: string) => void;
  // drag-reorder a tab to index `to`, clamped inside its own group (pinned tabs
  // keep the front; the boundary is crossed by pinning, not dragging)
  moveTab: (pid: string, to: number) => void;
  // rename a transcript file (remaps every pid-keyed slice); returns an error
  // message for the rename form, or null on success
  renameTranscript: (from: string, to: string) => string | null;
  // rename a speaker everywhere (every loaded transcript + the speaker map);
  // returns an error message for the form, or null on success
  renameSpeaker: (from: string, to: string) => string | null;
  jumpTo: (pid: string, line: number) => void;
  clearJump: () => void;
  scrollToLine: (line: number) => void;
  setPalette: (v: boolean) => void;
  setEventAt: (t: number | null) => void;
  setFormatOpen: (v: boolean) => void;
  openSearch: () => void;
  closeSearch: () => void;
  setSearch: (patch: Partial<Search>) => void;
  editLine: (pid: string, id: number, text: string) => void;
  /** Find-and-replace across ONE transcript: every occurrence in every line,
      as one undoable gesture. Returns how many occurrences went. */
  replaceInTranscript: (pid: string, find: string, repl: string, only?: LineScope) => number;
  exportEdits: () => string;
  setAi: (patch: Partial<Ai>) => void;
  addFlags: (pid: string, flags: Record<number, Flag[]>, lines: Line[], scanned: string[]) => void;
  addGrounds: (recs: Record<number, GroundRec>) => void;
  dismissNotice: (pid: string, id: number, lens: string, quote: string) => void;
  applyFix: (pid: string, id: number, quote: string, fix: string) => void;
  logAiCall: (call: AiCall) => void;
  /** A run that reached OpenAI and did not come back — aborted, or failed after
      dispatch. The transcript went either way, so the log records it. */
  logAiIncomplete: (e: unknown, c: Pick<AiCall, "model" | "task" | "pid" | "lines" | "redactions">) => void;
  exportAiLog: () => string;
  logDecision: (d: Omit<Decision, "at" | "undone"> & { at?: string }) => void;
  exportLedger: () => string;
  exportSections: () => string;
  exportCodebook: () => string;
  exportTranscript: (pid: string) => string;
  // events: imported against ONE transcript (the tab you right-clicked), never guessed
  importMarkers: (pid: string, rows: Record<string, string>[]) => { added: number; skipped: number };
  editMarker: (mid: number, label: string) => void;
  // hand-added event (the add-event modal); t is on the VIDEO clock, like imports
  addMarker: (pid: string, m: { t: number; code: string; label: string }) => void;
  // full edit through the same modal (time/type/text); t on the VIDEO clock
  updateMarker: (mid: number, m: { t: number; code: string; label: string }) => void;
  // rename a whole type: every event whose key is `from` gets code `to`
  renameMarkerType: (from: string, to: string) => void;
  setMarkerColor: (key: string, color: string) => void;
  deleteMarker: (mid: number) => void;
  // drop every event of one transcript; returns how many went (undoable)
  clearMarkers: (pid: string) => number;
  exportMarkers: () => string;
  // the Summary tab's text pane (per keystroke — no undo entry, like setNotes)
  setSummary: (pid: string, text: string) => void;
  setProjectNotes: (text: string) => void; // per keystroke — no undo entry, like setSummary
  setProjectName: (name: string) => void;
  setCodeGroups: (groups: CodeGroup[]) => void;
  setCodeAreas: (areas: CodeGroup[], fp: string) => void;
  markStretch: (st: Stretch) => void;
  unmarkStretch: (i: number) => void;
  editStretch: (i: number, dim: string, value: string) => void;
  setStudyBrief: (pid: string, text: string) => void;
  clearStudyBrief: (pid: string) => void;
  /** a whole run's proposals, as ONE undoable gesture. Returns how many landed. */
  landSections: (pid: string, proposals: SectionProposal[], proposedBy: string) => number;
  setStretchStatus: (i: number, status: StretchStatus) => void;
  /** every candidate on this transcript accepted at once — one gesture */
  acceptSections: (pid: string) => number;
  /** the way out of a run nobody wanted (cf. deleteSegmentsBy). Deleting a
      REJECTED stretch also forgets it, so a re-run may propose it again. */
  deleteStretchesBy: (opts: { pid?: string; status: StretchStatus }) => number;
  setStretchColor: (value: string, color: string) => void;
  setCodePlan: (plan: CodePlanAction[]) => void;
  setCodeClusters: (clusters: CodeCluster[]) => void;
  /** turn a merge proposal down — the record wants the noes as much as the yeses */
  dismissCluster: (ci: number) => void;
  // a whole-map nudge (Adjust to zoom): every moved thing, ONE entry
  applyMapLayout: (chips: Record<string, { x: number; y: number }>,
    islands: Record<string, { x: number; y: number }>, moved: number, stage: MapStage) => void;
  // a drop that moved SEVERAL things at once (a multi-selection drag): every
  // position and every membership change, ONE undoable entry
  applyMapDrop: (d: {
    stage: MapStage;
    /**
     * Codes whose hand position is FORGOTTEN, so the packer places them: a
     * code that joined a container (it is appended after the members) or one
     * dropped on the catch-all pile. Everything else keeps the spot it was
     * dropped at — position and membership never both carry meaning.
     */
    tidy?: string[];
    chips?: Record<string, { x: number; y: number }>;
    islands?: Record<string, { x: number; y: number }>;
    reconcile?: { code: string; ci: number | null }[];
    themes?: { code: string; gi: number }[];
    // the AI areas view: ai = index into codeAreas, -1 = unassigned
    areas?: { code: string; ai: number }[];
  }) => void;
  reconcileDrop: (code: string, pos: { x: number; y: number }, targetCi: number | null,
    /** false when a caller batches several drops under its own ONE pushUndo */
    undoable?: boolean) => void;
  // Themes-stage drop: position + island membership, ONE entry. gi -1 = no island.
  // a reconcile run landing: clusters + actions + fresh layout, ONE entry
  applyReconcilePlan: (clusters: CodeCluster[], actions: CodePlanAction[], resetLayout: boolean,
    source?: DecisionSource, model?: string) => void;
  // a Themes grouping run landing: islands + fresh layout, ONE entry
  applyThemeGroups: (groups: CodeGroup[]) => void;
  // wipe every hand-placed position: the packer lays the stage out fresh (one entry)
  resetMapLayout: (stage: MapStage) => boolean;
  // the whole cluster is applied as ONE undoable step
  applyCluster: (ci: number) => void;
  setLastPid: (pid: string) => void;
  addAnswer: (a: Omit<Answer, "aid" | "at">) => void;
  deleteAnswer: (aid: number) => void;
  exportAnswers: () => string;
  exportNotices: () => string;
  exportProject: () => string;
  openProject: (p: Project) => void;
  setPendingProject: (p: Project | null) => void;
  setSegmentRange: (sid: number, start: number, end: number) => void;
  /** per drag-move like setSegmentRange: the caller owns the one pushUndo */
  setStretchRange: (i: number, start: number, end: number) => void;
  deleteSegment: (sid: number) => void;
  // Bulk cleanup of a status across one transcript or all of them. Returns how
  // many went, so the caller can say it out loud.
  deleteSegmentsBy: (opts: { pid?: string; status: Segment["status"] }) => number;
  setStatus: (sid: number, status: string) => void;
  // reconciliation's "remove": every accepted segment of the code is rejected in
  // one undoable step — the data stays in the file, the code goes quiet
  rejectCode: (code: string, why?: string, source?: DecisionSource, model?: string) => void;
  setNotes: (sid: number, notes: string) => void;
  setColor: (code: string, color: string) => void;
  // recolour every code so co-occurring codes differ; keepManual pins the
  // colours picked by hand. Returns how many colours changed.
  recolorCodes: (keepManual: boolean) => number;
  togglePin: (code: string) => void;
  refreshHotbar: () => void;
  pushUndo: () => void;
  pushSelUndo: () => void;
  endSelGesture: () => void;
  undo: () => void;
  redo: () => void;
  renameCode: (code: string, newName: string, why?: string, source?: DecisionSource, model?: string,
    /** false when the caller batches this under its own pushUndo (tell-apart's merge-then-rename) */
    undoable?: boolean) => void;
  normalizeCodeCase: (style: "lower" | "capital") => string;
  deleteCode: (code: string, why?: string) => void;
  mergeCode: (from: string, into: string, why?: string, source?: DecisionSource, model?: string) => void;
  /** set a code aside (or bring it back) without touching its excerpts */
  setParked: (code: string, parked: boolean, why?: string) => void;
  /** the tail queue's verdict that changes nothing: I read this code and it stands */
  noteVerdict: (code: string, why?: string) => void;
  /** take one of those back — they changed nothing, so the history stack has nothing to give */
  retractVerdict: (at: number) => void;
  /** the distinguishing sentence: it defines BOTH codes, in one step */
  defineBoth: (a: string, b: string, def: string, source?: DecisionSource, model?: string) => void;
  setDef: (code: string, def: string, ai?: boolean) => void;
  // returns the codes it actually wrote — a draft that echoes what is already
  // stored changes nothing, and the receipt must not claim it did
  applyDrafts: (drafts: { code: string; def: string }[]) => string[];
  setFontSize: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setUi: (patch: Partial<Ui>) => void;
  claimUnattributed: () => void;
  toggleTheme: () => void;
  setHotbarMode: (mode: "auto" | "pinned") => void;
  setZen: (v: boolean) => void;
  exportCSV: () => string;
}

const emptySel = (): Selection => ({ pid: null, anchor: null, head: null, lines: new Set() });

// Display units for the active transcript. When mergeLines is off these are
// one-line singletons, so the group-aware selection below reduces to per-line.
// anchor/head are the startId of the anchor/head group.
// One-entry cache: selectLine calls this per mousemove during a drag-select,
// and re-merging a 1000-line transcript per pixel was real time. The inputs
// are all replaced copy-on-write, so identity comparison is exact.
let groupsCache: { lines: Line[]; merge: boolean; gap: number | null; groups: Group[] } | null = null;
function groupsOf(s: State): Group[] {
  const t = s.transcripts[s.active];
  if (!t) return [];
  const gap = s.ui.mergeGapOn ? s.ui.mergeGap : null;
  if (groupsCache && groupsCache.lines === t.lines && groupsCache.merge === s.ui.mergeLines && groupsCache.gap === gap)
    return groupsCache.groups;
  const groups = mergeGroups(t.lines, s.ui.mergeLines, gap);
  groupsCache = { lines: t.lines, merge: s.ui.mergeLines, gap, groups };
  return groups;
}
const groupIdxOf = (gs: Group[], lineId: number) => gs.findIndex((g) => lineId >= g.startId && lineId <= g.endId);
function idsBetween(gs: Group[], i: number, j: number): number[] {
  const [lo, hi] = i < j ? [i, j] : [j, i];
  const out: number[] = [];
  for (let k = lo; k <= hi; k++) out.push(...gs[k].ids);
  return out;
}

// The selection rides in the snapshot too: undoing a code also puts back the lines it was
// applied to, and a selection change is itself undoable. `active` rides along as well --
// WITHOUT it, tab identity had to be inferred from selection.pid, which is null for an
// EMPTY selection. Undo could then follow a selection INTO a tab but never restore "no
// selection" BACK to one: the entry was consumed, nothing changed on screen, and
// savedSelections still held the selection it was supposed to remove -- which then
// resurrected itself the next time you opened that tab, with no undo left to kill it.
// The selection's Set is copied to an array (it's the one thing callers mutate a
// copy of); everything else is held BY REFERENCE — every store action already
// replaces these slices copy-on-write, so a snapshot is structural sharing, not a
// serialization. (The stacks used to hold JSON strings: at a few thousand
// segments that was ~half a megabyte of stringify per click, times a cap of 80.)
interface Snap {
  kind?: undefined;
  segments: Segment[]; codebook: State["codebook"]; hotbar: State["hotbar"];
  active: string; markers: Marker[]; aiGrounds: Record<number, GroundRec>;
  markerColors: Record<string, string>;
  codeGroups: CodeGroup[]; codeAreas: CodeGroup[]; codeAreasFp: string;
  codePlan: CodePlanAction[]; codeClusters: CodeCluster[];
  mapPositions: StageLayout; mapIslandPos: StageLayout; stretches: Stretch[];
  ledgerLen: number; ledgerUndone?: boolean[];
  sel: { pid: string | null; anchor: number | null; head: number | null; lines: number[] };
}
interface LineSnap { kind: "line"; pid: string; id: number; line: Line; flags: LineFlags | null }
// A gesture that rewrote SEVERAL lines at once (find-and-replace across a
// transcript) is ONE thing the researcher did, so it is one thing to undo.
// Same payload as a line entry, a list of them — the full snapshot cannot
// serve here, because it deliberately does not carry transcripts.
interface LinesSnap { kind: "lines"; pid: string; entries: LineSnap[] }
type UndoEntry = Snap | LineSnap | LinesSnap;
function snapshot(s: State): Snap {
  return {
    segments: s.segments, codebook: s.codebook, hotbar: s.hotbar, active: s.active,
    markers: s.markers,
    // grounding rides with the segments it belongs to: deleting a segment drops
    // its grounding, and an undo that brought the segment back without it made
    // the researcher pay for the same AI call twice
    aiGrounds: s.aiGrounds, markerColors: s.ui.markerColors,
    // the Code map's state rides too: undoing a verdict must put the proposal
    // back on the canvas, and a layout move is as undoable as anything else
    // (positions are session-only data, but they share this one history)
    codeGroups: s.codeGroups, codeAreas: s.codeAreas, codeAreasFp: s.codeAreasFp,
    codePlan: s.codePlan, codeClusters: s.codeClusters,
    mapPositions: s.mapPositions, mapIslandPos: s.mapIslandPos,
    stretches: s.stretches,
    // not the ledger rows themselves — their length and reversal flags. Length
    // tells restore which later rows did not exist yet; the flags are necessary
    // because a redo snapshot can contain a reversed row between live ones.
    ledgerLen: s.ledger.length,
    ledgerUndone: s.ledger.map((d) => !!d.undone),
    sel: { pid: s.selection.pid, anchor: s.selection.anchor, head: s.selection.head, lines: [...s.selection.lines] },
  };
}
// Text edits get a TARGETED undo entry (kind:"line") instead of a full snapshot:
// the snapshot above deliberately omits transcripts/aiFlags, and 80 copies of a
// whole transcript would not be a stack, it would be a memory leak. The entry
// holds the one line (with its orig) and the line's AI-flag record, so undoing
// an applyFix brings back both the wording and the mark it consumed.
function lineEntry(s: State, pid: string, id: number): LineSnap | null {
  const line = s.transcripts[pid]?.lines.find((l) => l.id === id);
  if (!line) return null;
  return { kind: "line", pid, id, line, flags: s.aiFlags[`${pid}:${id}`] ?? null };
}
function restoreLine(get: () => State, set: (p: Partial<State>) => void,
  o: { pid: string; id: number; line: Line; flags: LineFlags | null }) {
  const t = get().transcripts[o.pid];
  // the whole restore is gated on the line still existing — a half-restore that
  // skipped the text but wrote the flags would persist an orphan aiFlags record
  // keyed to a transcript that's gone
  if (!t || !t.lines.some((l) => l.id === o.id)) return;
  set({ transcripts: { ...get().transcripts, [o.pid]: { lines: t.lines.map((l) => l.id === o.id ? o.line : l) } } });
  const flags = { ...get().aiFlags };
  const key = `${o.pid}:${o.id}`;
  if (o.flags) flags[key] = o.flags; else delete flags[key];
  set({ aiFlags: flags });
  // a line entry doesn't snapshot `active` the way full snapshots do — navigate
  // to the edited transcript so the undo is never a silent off-screen change.
  // A CLOSED tab is the sharper case: the transcript is still loaded (closeTab
  // keeps the data), so the text does change — off-screen, with nothing but
  // "Undone" said about it. Put its tab back and go there; the whole promise of
  // this line is that you SEE what the undo did.
  if (get().active === o.pid) return;
  if (get().tabs.includes(o.pid)) set({ active: o.pid });
  else get().openTab(o.pid);
}
// The two halves of a history step, for all three entry kinds: what the CURRENT
// state would have to be restored to (the entry that goes on the other stack),
// and putting an entry's state back.
function inverse(s: State, o: UndoEntry): UndoEntry {
  if (o.kind === "line") return lineEntry(s, o.pid, o.id) ?? o;
  if (o.kind === "lines") {
    return { kind: "lines", pid: o.pid, entries: o.entries.map((e) => lineEntry(s, e.pid, e.id) ?? e) };
  }
  return snapshot(s);
}
function applyEntry(get: () => State, set: (p: Partial<State>) => void, o: UndoEntry) {
  if (o.kind === "line") restoreLine(get, set, o);
  else if (o.kind === "lines") for (const e of o.entries) restoreLine(get, set, e);
  else restore(get, set, o);
}

// The survivor auto-picks itself: the member with the most accepted excerpts
// (the name still comes from the halo title / newName; this only chooses the
// merge target and the fallback display name). A `preferred` survivor wins
// when it is a member — the AI's focus answer and a persisted plan both carry
// a deliberate choice of merge DIRECTION that evidence-count must not invert.
export function bestSurvivor(s: State, codes: string[], preferred?: string): string {
  if (preferred && codes.includes(preferred)) return preferred;
  let best = codes[0], bestN = -1;
  for (const c of codes) {
    const n = s.segments.filter((x) => norm(x.code) === norm(c) && x.status === "accepted").length;
    if (n > bestN) { best = c; bestN = n; }
  }
  return best;
}

// Every cluster that enters the store from OUTSIDE a live gesture (project
// open, persisted-session rehydration, migration) passes through here: dead
// members drop, thin clusters drop, and the survivor policy applies with the
// persisted choice preserved when still valid.
// Session-scoped and monotonic: ids only have to be unique among the clusters
// alive at one time, and they are never exported as a promise to anything else.
// Seeded past whatever a loaded project already carries.
let nextCid = 1;
export function stampCids(clusters: CodeCluster[], opts: { fromFile?: boolean } = {}): CodeCluster[] {
  for (const c of clusters) if (c.cid !== undefined && c.cid >= nextCid) nextCid = c.cid + 1;
  // A whole set arriving FROM A FILE with no ids at all is a pre-cid layout,
  // and its hand-placed capsule positions are keyed by INDEX ("halo:0"…).
  // Those clusters take their index as their id, so every capsule keeps the
  // spot it was given — fresh monotonic ids here would shear the arrangement
  // one last time on the way in, which is the very bug ids exist to end.
  // Only for file loads: a mid-session set with no ids is new proposals, and
  // those must never take an index that a stale stored position still names.
  if (opts.fromFile && clusters.length && clusters.every((c) => c.cid === undefined)) {
    if (clusters.length > nextCid) nextCid = clusters.length;
    return clusters.map((c, i) => ({ ...c, cid: i }));
  }
  return clusters.map((c) => (c.cid === undefined ? { ...c, cid: nextCid++ } : c));
}

export function normalizeClusters(s: State, clusters: CodeCluster[]): CodeCluster[] {
  return clusters
    .map((c) => ({ ...c, codes: c.codes.filter((k) => !!s.codebook[k]) }))
    .filter((c) => c.codes.length >= 2)
    .map((c) => ({ ...c, survivor: bestSurvivor(s, c.codes, c.survivor) }));
}

// Code-keyed side tables (map placements) follow their code through a rename:
// the map's hand-placed spots are the researcher's own work, and a rename that
// orphans them throws that work away silently.
// apply a transform to EVERY view's layout, so adding a view cannot silently
// drop its positions from a rename or a casing sweep
const mapLayouts = (l: StageLayout, f: (rec: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>): StageLayout =>
  Object.fromEntries(Object.entries(l).map(([k, rec]) => [k, f(rec)])) as StageLayout;

const renameKey = <T,>(rec: Record<string, T>, from: string, to: string): Record<string, T> =>
  from in rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k === from ? to : k, v])) : rec;

const dropKey = <T,>(rec: Record<string, T>, k: string): Record<string, T> =>
  k in rec ? Object.fromEntries(Object.entries(rec).filter(([x]) => x !== k)) : rec;

// The merge itself, silent: no pushUndo, no announce — mergeCode wraps it for
// the single-pair path, applyCluster composes several under ONE history entry.
function mergeInto(get: () => State, set: (p: Partial<State>) => void, from: string, into: string) {
  if (norm(from) === norm(into)) return;
  const s = get();
  if (!s.codebook[from] || !s.codebook[into]) return;
  const seen = new Set<string>();
  const merged = s.segments
    .map((x) => norm(x.code) === norm(from) ? { ...x, code: into } : x)
    .filter((x) => {
      const key = `${x.pid}|${x.start}|${x.end}|${norm(x.code)}|${x.proposedBy}|${x.status}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  const cb = { ...s.codebook }; delete cb[from];
  if (!cb[into].def && s.codebook[from].def)
    cb[into] = { ...cb[into], def: s.codebook[from].def, defAi: s.codebook[from].defAi };
  set({
    codebook: cb,
    segments: merged,
    hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.filter((c) => c !== from) },
    codeAreas: s.codeAreas.map((g) => ({ ...g, codes: g.codes.filter((c) => c !== from) }))
      .filter((g) => g.codes.length > 0),
    codeGroups: s.codeGroups.map((g) => ({ ...g, codes: g.codes.filter((c) => c !== from) }))
      .filter((g) => g.codes.length > 0),
    codePlan: s.codePlan.filter((a) => a.code !== from && a.into !== from),
    codeClusters: s.codeClusters
      .map((c) => ({ ...c, codes: c.codes.filter((x) => x !== from) }))
      .filter((c) => c.survivor !== from && c.codes.length >= 2),
    // the dead name's hand-placed spot goes too, or a future code that happens
    // to reuse the name inherits a position nobody gave it
    mapPositions: mapLayouts(s.mapPositions, (rec) => dropKey(rec, from)),
  });
}

// The rename itself, silent: no pushUndo, no ledger row — renameCode wraps it,
// applyCluster composes it under the capsule's ONE history entry. EVERY slice
// that speaks code names moves together; a partial copy of this list is how a
// renamed survivor fell off its area shelf and lost its hand position.
function renameInto(get: () => State, set: (p: Partial<State>) => void, code: string, name: string) {
  const s = get();
  const cb: State["codebook"] = {};
  for (const k of Object.keys(s.codebook)) cb[k === code ? name : k] = s.codebook[k];
  set({
    codebook: cb,
    segments: s.segments.map((x) => norm(x.code) === norm(code) ? { ...x, code: name } : x),
    hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.map((c) => c === code ? name : c) },
    codeGroups: s.codeGroups.map((g) => ({ ...g, codes: g.codes.map((c) => c === code ? name : c) })),
    codeAreas: s.codeAreas.map((g) => ({ ...g, codes: g.codes.map((c) => c === code ? name : c) })),
    codePlan: s.codePlan.map((a) => ({ ...a,
      code: a.code === code ? name : a.code,
      ...(a.into === code ? { into: name } : {}) })),
    codeClusters: s.codeClusters.map((c) => ({ ...c,
      survivor: c.survivor === code ? name : c.survivor,
      codes: c.codes.map((x) => x === code ? name : x),
      // the glimpse still describes the same members under a new name
      ...(c.descCodes ? { descCodes: c.descCodes.map((x) => x === code ? name : x) } : {}),
      ...(c.againstCodes ? { againstCodes: c.againstCodes.map((x) => x === code ? name : x) } : {}) })),
    // the map's hand-placed spots are keyed by code name: miss this and
    // a rename silently throws the researcher's layout away
    // map over the slots, never list them: a new view's layout would
    // otherwise be thrown away on the next rename, exactly as this
    // comment's older twin warned
    mapPositions: mapLayouts(s.mapPositions, (rec) => renameKey(rec, code, name)),
  });
}

function restore(get: () => State, set: (p: Partial<State>) => void, o: Snap) {
  const cur = get();
  const next = { ...cur, segments: o.segments, codebook: o.codebook, hotbar: o.hotbar };
  let sel: Selection = o.sel
    ? { pid: o.sel.pid, anchor: o.sel.anchor, head: o.sel.head, lines: new Set<number>(o.sel.lines) }
    : cur.selection; // a snapshot from before selections were tracked

  // The tab may have been CLOSED since the snapshot. Drop a selection that points into it:
  // applyCode trusts selection.pid and the digit hotkeys only check lines.size, so a live
  // selection on a closed tab writes segments onto a transcript that isn't on screen.
  if (sel.pid && !cur.tabs.includes(sel.pid)) sel = emptySel();
  const active = o.active && (!isTranscriptView(o.active) || cur.tabs.includes(o.active))
    ? o.active : cur.active;

  // Crossing tabs here bypasses setActive(), which is what stashes the outgoing tab's
  // selection and parks the incoming one. Do its bookkeeping by hand, or the parked copy
  // goes stale and reappears next time you visit that tab.
  const saved = { ...cur.savedSelections };
  if (active !== cur.active) saved[cur.active] = cur.selection; // park what we leave
  if (isTranscriptView(active)) saved[active] = sel;            // and what we restore, EMPTY OR NOT

  set({
    segments: o.segments, codebook: o.codebook, hotbar: o.hotbar,
    // a snapshot from before events existed carries none — keep what's on screen
    // rather than wiping the transcript's markers on an old undo entry
    markers: o.markers ?? cur.markers,
    // both added after snapshots existed — an older entry carries neither, and
    // wiping live data on an old undo entry is worse than not restoring it
    aiGrounds: o.aiGrounds ?? cur.aiGrounds,
    // map data joined the snapshot later still — same old-entry guard
    codeGroups: o.codeGroups ?? cur.codeGroups,
    codeAreas: o.codeAreas ?? cur.codeAreas,
    codeAreasFp: o.codeAreasFp ?? cur.codeAreasFp,
    stretches: o.stretches ?? cur.stretches,
    codePlan: o.codePlan ?? cur.codePlan,
    codeClusters: o.codeClusters ?? cur.codeClusters,
    mapPositions: o.mapPositions ?? cur.mapPositions,
    mapIslandPos: o.mapIslandPos ?? cur.mapIslandPos,
    // Decisions logged after this snapshot are marked undone, not deleted. For
    // rows that already existed, the exact flags matter: a redo can restore a
    // live row followed by a reversed one. The length-only branch keeps an old
    // in-memory snapshot usable; one from before the ledger leaves it alone.
    ledger: typeof o.ledgerLen === "number"
      ? cur.ledger.map((d, i) => {
          // "kept" and "to code more" changed no state — they are a record of
          // having LOOKED, and no undo of some other action reverses that
          if (INERT_DECISIONS.has(d.kind)) return d;
          const undone = i >= o.ledgerLen
            ? true
            : o.ledgerUndone?.[i] ?? false;
          return !!d.undone === undone ? d : { ...d, undone };
        })
      : cur.ledger,
    ui: o.markerColors ? { ...cur.ui, markerColors: o.markerColors } : cur.ui,
    hotbarCache: hotbarCodes(next), selection: sel, active, savedSelections: saved,
    // One cache must own the scroll after a tab change, or the tab's remembered anchor
    // (restored in a rAF) races the selection-follow (synchronous) and wins -- landing you
    // nowhere near what you just undid. `jump` is that ownership token; the positioning
    // effect defers to it.
    jump: active !== cur.active && sel.pid && sel.head !== null
      ? { pid: sel.pid, line: sel.head } : cur.jump,
  });
}

// Grounding is keyed by sid, and three paths (delete a code, merge codes, claim
// unattributed work) drop segments wholesale. Left alone those records sit in
// localStorage forever, keyed to segments nobody can reach — and the store
// already has a quota-failure banner. Call after any bulk segment removal.
function pruneGrounds(s: State): Partial<State> {
  const live = new Set(s.segments.map((x) => String(x.sid)));
  const kept = Object.entries(s.aiGrounds).filter(([sid]) => live.has(sid));
  return kept.length === Object.keys(s.aiGrounds).length ? {} : { aiGrounds: Object.fromEntries(kept) };
}

// Where a tab GOES when it (re)appears. Appending was wrong for a pinned
// transcript: closing one keeps the pin, so reopening it showed a pin icon on a
// tab sitting after every unpinned tab. The pinned group owns the front, in pin
// order — the same invariant togglePinTab and moveTab maintain.
function placeTab(s: State, pid: string): string[] {
  if (s.tabs.includes(pid)) return s.tabs;
  if (!s.pinnedTabs.includes(pid)) return [...s.tabs, pid];
  const front = s.pinnedTabs.filter((p) => p === pid || s.tabs.includes(p));
  return [...front, ...s.tabs.filter((t) => !front.includes(t))];
}

// a citation ref is "<pid>:2-3" or "<pid>@0:12:30" — rewrite only the pid part,
// and only on an exact match, so a transcript whose name is a prefix of another's
// is left alone
const renameRef = (ref: string, from: string, to: string) =>
  ref.startsWith(`${from}:`) || ref.startsWith(`${from}@`) ? to + ref.slice(from.length) : ref;

/** how many codings a code carries right now, any status — the size of a decision */
const countCode = (s: State, code: string) =>
  s.segments.filter((x) => norm(x.code) === norm(code)).length;

function hotbarCodes(s: State): string[] {
  // a pinned parked code stays pinned (unparking must not cost you the pin) but
  // never reaches the hotbar, or a digit key would apply a code you set aside
  if (s.hotbar.mode === "pinned") return s.hotbar.pinned.filter((c) => !s.codebook[c]?.parked).slice(0, 9);
  const count: Record<string, number> = {};
  s.segments.filter((x) => x.status === "accepted").forEach((x) => { count[x.code] = (count[x.code] || 0) + 1; });
  return liveCodes(s.codebook).sort((a, b) => (count[b] || 0) - (count[a] || 0)).slice(0, 9);
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      transcripts: {}, segments: [], codebook: {}, extSegRows: [],
      tabs: [], pinnedTabs: [], active: "browse",
      hotbar: { mode: "auto", pinned: [] }, hotbarCache: [],
      video: {}, ui: { ...DEFAULT_UI },
      ai: { model: DEFAULT_MODEL, redactTerms: [], lenses: ["transcription"] }, aiFlags: {}, aiGrounds: {}, aiLog: [], ledger: [], markers: [], summaries: {}, projectNotes: "", projectName: "", codeGroups: [], codeAreas: [], codeAreasFp: "", stretches: [], studyBrief: {}, codePlan: [], codeClusters: [], mapPositions: emptyLayout(), mapIslandPos: emptyLayout(), lastPid: "",
      selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [], selRun: false, nextSid: 1, nextMid: 1, jump: null, paletteOpen: false, eventAt: null, formatOpen: false,
      answers: [], nextAid: 1,
      search: NO_SEARCH,
      pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false, saveFailed: false,

      // wipe the workspace, keep the person: ui prefs (coder name, theme, fonts)
      // and AI settings survive; everything project-shaped resets — including the
      // speaker map, which belongs to the study (see exportProject): a lingering
      // "P is quiet" from study A would silently apply to study B's "P"
      newProject: () => {
        set({
          transcripts: {}, segments: [], codebook: {}, extSegRows: [], tabs: [], pinnedTabs: [],
          active: "browse", hotbar: { mode: get().hotbar.mode, pinned: [] }, hotbarCache: [],
          video: {}, aiFlags: {}, aiGrounds: {}, aiLog: [], ledger: [], markers: [], summaries: {}, projectNotes: "", projectName: "", codeGroups: [], codeAreas: [], codeAreasFp: "", stretches: [], studyBrief: {}, codePlan: [], codeClusters: [], mapPositions: emptyLayout(), mapIslandPos: emptyLayout(), lastPid: "",
          answers: [], nextAid: 1,
          // speakerFocus cleared with them: a stale focus name matching a speaker in
          // the NEXT study would silently dim everyone else there
          ui: { ...get().ui, speakerColors: {}, speakerWeight: {}, speakerFocus: {}, markerColors: {}, stretchColors: {} },
          selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [], selRun: false,
          jump: null, search: NO_SEARCH,
          pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false,
          nextSid: 1, nextMid: 1,
        });
        forgetScroll();
        projectSwapped();
      },

      importFiles: async (files) => {
        const skipped: string[] = [];
        // sids present before this batch, so we can tell rows that just arrived from the
        // user's own — the only way to attribute imported (default) rows without a flag
        const before = new Set(get().segments.map((s) => s.sid));
        const tBefore = Object.keys(get().transcripts).length;
        // Imports mutate snapshotted state (segments/codebook), so they must go on the
        // undo stack like any other edit: one entry for the whole batch, pushed before
        // the first mutation. pushUndo also clears redoStack — a stale redo snapshot
        // would otherwise overwrite the import and silently delete the imported data.
        let marked = false;
        const mark = () => { if (!marked) { marked = true; get().pushUndo(); } };
        for (const f of Array.from(files)) {
          try {
            // a project file goes through the same one entry point; the modal confirms
            // before it replaces the workspace
            if (/\.json$/i.test(f.name)) {
              set({ pendingProject: parseProject(await f.text()) });
              continue;
            }
            const rows = parseCSV(await f.text());
            const cols = rows.length ? Object.keys(rows[0]) : [];
            if (cols.includes("segment_ref")) { mark(); importSegments(get, set, rows); }
            else if (cols.includes("short_def") || (cols.includes("code") && cols.includes("status"))) {
              mark(); importCodebook(get, set, rows);
            } else if (cols.includes("line_id") && cols.includes("text")) {
              // Blank line_id coerces to 0 and non-numeric ones vanish row-by-row —
              // a hand-edited CSV must be rejected loudly, not imported corrupted.
              const bad = badLineIds(rows);
              if (bad) { skipped.push(`${f.name} ${bad}`); continue; }
              const pid = f.name.replace(/\.csv$/i, "");
              const s = get();
              const old = s.transcripts[pid];
              const segs = s.segments.filter((x) => x.pid === pid);
              // Re-importing over existing work would silently move every segment onto
              // whatever line now holds that number — and wipe in-app transcription
              // corrections (`orig`), which undo cannot bring back: ask first.
              // Stretches are line-id work too: without this, a re-import over a
              // stretch-only transcript would leave the labels on the old ids.
              if (old && (segs.length || s.stretches.some((x) => x.pid === pid)
                || s.answers.some((a) => a.points.some((pt) => pt.refs.some((r) => r.startsWith(`${pid}:`))))
                || old.lines.some((l) => l.orig !== undefined))) {
                const lines = rowsToLines(rows);
                const { map: _m, ...preview } = previewImport(segs, old.lines, lines,
                  s.stretches.filter((x) => x.pid === pid));
                set({ pendingImports: [...get().pendingImports, { pid, lines, rows, preview }] });
              } else {
                mark(); importTranscript(get, set, pid, rows);
              }
            } else if (isMarkerRows(rows)) {
              // Events belong to ONE transcript and this entry point can't know which:
              // send the user to the door that does, rather than calling their file
              // unrecognized when we recognized it perfectly well.
              skipped.push(`${f.name} is a session events file — load it from the transcript tab's right-click menu (Load events…), so it attaches to the right participant`);
            } else {
              // an unrecognized file must say so, not vanish without a trace
              skipped.push(rows.length
                ? `${f.name} doesn't match any QuAlly format — a transcript CSV needs "line_id" and "text" columns (see File format)`
                : `${f.name} is empty`);
            }
          } catch (err) {
            // one malformed file must not abort the rest of the batch
            skipped.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        set({ hotbarCache: hotbarCodes(get()) });
        // A batch that CREATED a transcript can't be undone honestly: snapshot()
        // covers segments/codebook but not transcripts, tabs or the guessed
        // speaker weights, so Ctrl+Z deleted the coding that came in with the
        // file and left the transcript standing — data loss wearing the costume
        // of a revert. The replace path already clears both stacks for the same
        // reason; say "not undoable" rather than half-undo it.
        if (Object.keys(get().transcripts).length > tBefore) set({ undoStack: [], redoStack: [] });
        // someone else's codes arrived unsigned? offer to attribute just those rows
        const fresh = get().segments.filter((s) => !before.has(s.sid) && s.proposedBy === "(default)").map((s) => s.sid);
        if (fresh.length) set({ pendingImportSign: { sids: fresh } });
        // your FIRST transcript just loaded into an empty workspace and you haven't said
        // who you are? ask. Only the empty->first moment — later transcripts don't re-ask.
        const nm = get().ui.coderName.trim();
        if (tBefore === 0 && Object.keys(get().transcripts).length > 0 && (!nm || nm === "(default)")) {
          set({ pendingCoderAsk: true });
        }
        if (skipped.length) throw new Error(skipped.join("; "));
      },

      resolveSegUpdates: (apply) => {
        const updates = get().pendingSegUpdates;
        set({ pendingSegUpdates: [] });
        if (!apply || !updates.length) return;
        const by = new Map(updates.map((u) => [u.sid, u.to]));
        get().pushUndo();
        set({ segments: get().segments.map((x) => by.has(x.sid) ? { ...x, ...by.get(x.sid)! } : x) });
      },

      // The "who's coding?" ask, raised when a transcript loads with no coder set. name
      // set => become that coder (and claimUnattributed signs the work done so far);
      // null/blank => dismiss and keep coding as (default) until the next transcript loads.
      resolveCoderAsk: (name) => {
        set({ pendingCoderAsk: false });
        const by = (name || "").trim();
        if (!by || by === "(default)") return;
        get().setUi({ coderName: by });
        get().claimUnattributed();
      },

      // Attribute the (default) rows a colleague's file just brought in — but ONLY those
      // sids, never the user's own (default) work. name null / blank / "(default)" = keep
      // them as (default). Dedup: the new name can collide a row onto an existing one.
      resolveImportSign: (name) => {
        const p = get().pendingImportSign;
        set({ pendingImportSign: null });
        const by = (name || "").trim();
        if (!p || !by || by === "(default)") return;
        const target = new Set(p.sids);
        get().pushUndo();
        const seen = new Set<string>();
        const segments = get().segments
          .map((s) => (target.has(s.sid) ? { ...s, proposedBy: by } : s))
          .filter((s) => {
            const k = `${s.pid}|${s.start}|${s.end}|${norm(s.code)}|${s.proposedBy}`;
            return seen.has(k) ? false : (seen.add(k), true);
          });
        set({ segments });
        set(pruneGrounds(get())); // the dedup above deletes rows
      },

      resolveImport: (choice) => {
        const [p, ...rest] = get().pendingImports;
        if (!p) return;
        set({ pendingImports: rest });
        if (choice === "cancel") return;

        if (choice === "new") {
          // A new transcript can't be undone honestly (snapshot() covers segments
          // but not transcripts or tabs), so clear the stacks rather than leave an
          // entry that deletes the imported coding and leaves the transcript --
          // the same rule importFiles applies to a first import.
          set({ undoStack: [], redoStack: [] });
          importTranscript(get, set, uniquePid(get(), p.pid), p.rows);
        } else {
          const s = get();
          const segs = s.segments.filter((x) => x.pid === p.pid);
          let kept: Segment[] = []; // "replace": the transcript's coding goes with it
          // stretches point at the same line ids the segments do, so they ride
          // the same remap: "update" carries the survivors, "replace" drops them
          let keptStretches: typeof s.stretches = [];
          let lineMap: Map<number, number> | null = null;
          if (choice === "update") {
            const { map } = previewImport(segs, s.transcripts[p.pid].lines, p.lines);
            kept = segs.flatMap((seg) => {
              const r = remapSegment(seg, map);
              return r ? [{ ...seg, start: r.start, end: r.end }] : [];
            });
            keptStretches = s.stretches
              .filter((x) => x.pid === p.pid)
              .flatMap((st) => {
                const r = remapSegment(st, map);
                return r ? [{ ...st, start: r.start, end: r.end }] : [];
              });
            lineMap = map;
          }
          const saved = { ...s.savedSelections };
          delete saved[p.pid]; // a stashed selection points at the old line ids
          // saved answers cite "<pid>:a-b" line refs; those follow the same
          // remap ("update") or go ("replace") — a citation button must never
          // open unrelated text that merely reuses the line number. "@time"
          // refs point at the video clock and survive either way.
          const remapRef = (r: string): string[] => {
            if (!r.startsWith(`${p.pid}:`)) return [r];
            const m = /^(\d+)(?:-(\d+))?$/.exec(r.slice(p.pid.length + 1));
            if (!m || !lineMap) return [];
            const to = remapSegment({ start: +m[1], end: +(m[2] ?? m[1]) }, lineMap);
            return to ? [`${p.pid}:${to.start === to.end ? to.start : `${to.start}-${to.end}`}`] : [];
          };
          set({
            segments: [...s.segments.filter((x) => x.pid !== p.pid), ...kept],
            stretches: [...s.stretches.filter((x) => x.pid !== p.pid), ...keptStretches],
            answers: s.answers.map((a) => ({
              ...a,
              points: a.points.map((pt) => ({ ...pt, refs: pt.refs.flatMap(remapRef) })),
            })),
            // The undo stack snapshots segments but not transcripts, so replaying it
            // after a re-import would restore segments pointing at the old line ids.
            // The modal's preview is the safety net instead.
            undoStack: [], redoStack: [],
            selection: s.selection.pid === p.pid ? emptySel() : s.selection,
            savedSelections: saved,
          });
          importTranscript(get, set, p.pid, p.rows);
        }
        // "replace" drops every segment on the transcript and "update" drops the
        // ones that no longer map: their grounding goes with them
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
      },

      ensureCode: (code) => ensureCode(get, set, code),

      addSegment: (pid, start, end, code, proposedBy, status = "accepted", notes = "") => {
        const s = get();
        // Unset name => "(default)", the visible marker for "coded, nobody signed".
        // Never empty: proposed_by is the column that tells two coders apart, and an
        // empty field reads as a bug. claimUnattributed sweeps these into a real name
        // once you commit one; export nudges you before it ships.
        const by = proposedBy ?? (s.ui.coderName.trim() || "(default)");
        // dedup is per coder: two coders holding the same span+code is agreement data, not a dupe
        if (s.segments.some((x) => x.pid === pid && x.start === start && x.end === end && norm(x.code) === norm(code) && x.proposedBy === by)) return false;
        set({ segments: [...s.segments, { sid: s.nextSid, pid, start, end, code, notes, proposedBy: by, status }], nextSid: s.nextSid + 1 });
        return true;
      },

      applyCode: (code) => {
        const s = get();
        if (!s.selection.pid || !s.selection.lines.size) return;
        // the WHOLE history, not just the segments: pushUndo also clears the
        // redo stack and, at the cap, shifts the oldest entry off — so undoing
        // it by popping one entry would quietly eat both
        const before = { segments: s.segments, undoStack: s.undoStack, redoStack: s.redoStack, selRun: s.selRun };
        s.pushUndo();
        const ids = [...s.selection.lines].sort((a, b) => a - b);
        let start = ids[0], prev = ids[0], wrote = 0;
        for (let i = 1; i <= ids.length; i++) {
          if (i === ids.length || ids[i] !== prev + 1) {
            if (get().addSegment(s.selection.pid, start, prev, code)) wrote++;
            start = ids[i];
          }
          prev = ids[i];
        }
        // Pressing the same hotkey twice on the same selection dedups to
        // nothing. Confirming it anyway — in sound AND in words — says a write
        // happened that did not, and the undo entry we pushed would then eat a
        // real edit instead. Take both back.
        if (!wrote) {
          set(before);
          announce(`Already coded as ${code}`);
          return;
        }
        // the visual confirmation is a lane bar appearing; these are its
        // audible twins — the most frequent act in the app, so the mark is one
        // short note rather than an interval
        earcon.code();
        announce(ids.length === 1 ? `Coded line ${ids[0]} as ${code}` : `Coded lines ${ids[0]} to ${ids[ids.length - 1]} as ${code}`);
      },

      // clicking a line selects its whole merged unit (a singleton when merge is off)
      selectLine: (id, opts = {}) => {
        const s = get();
        const gs = groupsOf(s);
        const gi = groupIdxOf(gs, id);
        if (gi < 0) return;
        const g = gs[gi];
        const cur = s.selection.pid === s.active ? s.selection : emptySel();
        if (opts.extend && cur.anchor !== null) {
          const base = Math.max(0, groupIdxOf(gs, cur.anchor));
          set({ selection: { pid: s.active, anchor: gs[base].startId, head: g.startId, lines: new Set(idsBetween(gs, base, gi)) } });
        } else if (opts.toggle) {
          const lines = new Set(cur.lines);
          const allIn = g.ids.every((x) => lines.has(x));
          for (const x of g.ids) allIn ? lines.delete(x) : lines.add(x);
          set({ selection: { pid: s.active, anchor: g.startId, head: g.startId, lines } });
        } else if (g.ids.every((x) => cur.lines.has(x)) && cur.lines.size === g.ids.length) {
          set({ selection: emptySel() }); // re-click the sole unit clears
        } else {
          set({ selection: { pid: s.active, anchor: g.startId, head: g.startId, lines: new Set(g.ids) } });
        }
      },
      // shift+arrow moves the head unit; plain arrow jumps to the adjacent unit
      moveSelection: (dir, extend) => {
        const s = get();
        const gs = groupsOf(s);
        if (!gs.length || s.selection.pid !== s.active || !s.selection.lines.size) return;
        // the undo entry goes in only once the move is known to happen: an arrow press
        // against the transcript's edge must not eat the redo stack for a no-op
        if (extend) {
          const anchorGi = s.selection.anchor !== null ? groupIdxOf(gs, s.selection.anchor) : -1;
          const headGi = s.selection.head !== null ? groupIdxOf(gs, s.selection.head) : anchorGi;
          const ni = Math.max(0, Math.min(gs.length - 1, (headGi < 0 ? anchorGi : headGi) + dir));
          if (ni === headGi) return;
          s.pushSelUndo(); // a run of arrow presses collapses into one entry
          const base = anchorGi < 0 ? ni : anchorGi;
          set({ selection: { pid: s.active, anchor: gs[base].startId, head: gs[ni].startId, lines: new Set(idsBetween(gs, base, ni)) } });
        } else {
          const ids = [...s.selection.lines];
          const edgeGi = groupIdxOf(gs, dir > 0 ? Math.max(...ids) : Math.min(...ids));
          const ni = edgeGi + dir;
          if (ni < 0 || ni >= gs.length) return;
          s.pushSelUndo();
          const g = gs[ni];
          set({ selection: { pid: s.active, anchor: g.startId, head: g.startId, lines: new Set(g.ids) } });
        }
      },

      startSelection: (id) => {
        const s = get();
        const gs = groupsOf(s);
        const gi = groupIdxOf(gs, id);
        if (gi < 0) return;
        const g = gs[gi];
        set({ selection: { pid: s.active, anchor: g.startId, head: g.startId, lines: new Set(g.ids) } });
      },
      clearSelection: () => {
        const s = get();
        if (!s.selection.lines.size) return; // nothing to clear, nothing to undo
        s.pushSelUndo();
        set({ selection: emptySel() });
      },
      // Tab switches stash the outgoing tab's selection and restore the incoming
      // tab's, so returning to a tab finds the lines still selected. Every consumer
      // already guards on selection.pid === active, so a restored selection only
      // acts on its own tab.
      setActive: (pid) => {
        const s = get();
        if (pid === s.active) return; // same-tab: stashing live over saved would wipe a cleared selection
        const saved = { ...s.savedSelections, [s.active]: s.selection };
        set({ active: pid, selection: saved[pid] ?? emptySel(), savedSelections: saved });
      },
      jumpTo: (pid, line) => {
        const s = get();
        if (pid === s.active) { set({ jump: { pid, line } }); return; } // same-tab jump: don't touch selection
        const saved = { ...s.savedSelections, [s.active]: s.selection };
        // Browse and all-transcripts search offer every LOADED transcript, tab or no
        // tab. Landing on a closed one must reopen its tab: active∉tabs is otherwise a
        // ghost state — no tab highlighted, no ×, and undo refuses to restore it.
        const tabs = isTranscriptView(pid) && s.transcripts[pid] ? placeTab(s, pid) : s.tabs;
        set({ active: pid, tabs, selection: saved[pid] ?? emptySel(), savedSelections: saved, jump: { pid, line } });
      },
      clearJump: () => set({ jump: null }),
      scrollToLine: (line) => set({ jump: { pid: get().active, line } }), // same-tab scroll, no selection change
      setPalette: (v) => {
        if (v && !get().paletteOpen) earcon.open(); // the window itself is an event
        set({ paletteOpen: v });
      },
      setEventAt: (t) => set({ eventAt: t }),
      setFormatOpen: (v) => set({ formatOpen: v }),
      openSearch: () => set({ search: { ...get().search, open: true } }),
      closeSearch: () => set({ search: NO_SEARCH }),
      setSearch: (patch) => set({ search: { ...get().search, ...patch } }),
      closeTab: (pid) => {
        const s = get();
        const tabs = s.tabs.filter((p) => p !== pid);
        const saved = { ...s.savedSelections };
        delete saved[pid]; // a closed tab's selection dies with it...
        forgetScroll(pid); // ...and so does its scroll anchor. The two caches had different
                           // lifetimes at one call site -- the shape of the bug already fixed.
        if (s.active !== pid) { set({ tabs, savedSelections: saved }); return; }
        const next = tabs[0] || "browse";
        set({ tabs, active: next, selection: saved[next] ?? emptySel(), savedSelections: saved });
      },

      // The opposite of closeTab: closing hid a transcript, this FORGETS it —
      // lines, coding, events, summary, AI marks and grounding, the lot. The undo
      // stacks go too: snapshot() carries segments but not transcripts, so an undo
      // afterwards would put the coding back pointing at a transcript that no
      // longer exists. The caller confirms; there is no way back from here.
      deleteTranscript: (pid) => {
        const s = get();
        if (!s.transcripts[pid]) return;
        const transcripts = { ...s.transcripts }; delete transcripts[pid];
        const dead = new Set(s.segments.filter((x) => x.pid === pid).map((x) => String(x.sid)));
        const saved = { ...s.savedSelections }; delete saved[pid];
        const video = { ...s.video }; delete video[pid];
        const summaries = { ...s.summaries }; delete summaries[pid];
        // the per-transcript brief override goes too: left behind, a LATER
        // transcript imported under this name would silently inherit a brief
        // written for the deleted one
        const studyBrief = { ...s.studyBrief }; delete studyBrief[pid];
        const speakerFocus = { ...s.ui.speakerFocus }; delete speakerFocus[pid];
        const tabs = s.tabs.filter((p) => p !== pid);
        const active = s.active === pid ? (tabs[0] || "browse") : s.active;
        set({
          transcripts,
          segments: s.segments.filter((x) => x.pid !== pid),
          markers: s.markers.filter((m) => m.pid !== pid),
          stretches: s.stretches.filter((x) => x.pid !== pid),
          lastPid: s.lastPid === pid ? "" : s.lastPid, // Escape must not walk into a deleted transcript
          // answers keep their prose, but citations into the deleted
          // transcript go: a claim button that opens nothing is a lie in the
          // record, and the pid leaves the answer's stated scope with it
          answers: s.answers.map((a) => ({
            ...a,
            points: a.points.map((pt) => ({ ...pt,
              refs: pt.refs.filter((r) => !r.startsWith(`${pid}:`) && !r.startsWith(`${pid}@`)) })),
            scope: { ...a.scope, pids: a.scope.pids.filter((x) => x !== pid) },
          })),
          extSegRows: s.extSegRows.filter((r) => r.pid !== pid),
          aiFlags: Object.fromEntries(Object.entries(s.aiFlags).filter(([k]) => !k.startsWith(`${pid}:`))),
          aiGrounds: Object.fromEntries(Object.entries(s.aiGrounds).filter(([sid]) => !dead.has(sid))),
          summaries, studyBrief, video, savedSelections: saved,
          tabs, pinnedTabs: s.pinnedTabs.filter((p) => p !== pid),
          active,
          selection: s.selection.pid === pid ? emptySel() : (saved[active] ?? s.selection),
          ui: { ...s.ui, speakerFocus },
          undoStack: [], redoStack: [],
        });
        set({ hotbarCache: hotbarCodes(get()) });
        forgetScroll(pid);
        announce(`${pid} deleted`);
      },

      // Put a closed transcript back on the bar. Closing a tab only ever hid the
      // transcript — its lines, coding, events and summary were never touched —
      // so reopening is a view change, not a recovery.
      openTab: (pid) => {
        const s = get();
        if (!s.transcripts[pid] || !isTranscriptView(pid)) return;
        const tabs = placeTab(s, pid);
        const saved = { ...s.savedSelections, [s.active]: s.selection };
        set({ tabs, active: pid, selection: saved[pid] ?? emptySel(), savedSelections: saved });
      },

      moveTab: (pid, to) => {
        const s = get();
        const from = s.tabs.indexOf(pid);
        if (from < 0) return;
        // the pinned group occupies the front (togglePinTab's invariant); clamp
        // the target into the group the tab belongs to
        const nPin = s.tabs.filter((p) => s.pinnedTabs.includes(p)).length;
        const isPin = s.pinnedTabs.includes(pid);
        const t = Math.max(isPin ? 0 : nPin, Math.min(to, isPin ? nPin - 1 : s.tabs.length - 1));
        if (t === from) return;
        const tabs = [...s.tabs];
        tabs.splice(from, 1);
        tabs.splice(t, 0, pid);
        set({
          tabs,
          // pin order = display order; keep the two lists agreeing after a drag
          pinnedTabs: isPin ? tabs.filter((p) => s.pinnedTabs.includes(p)) : s.pinnedTabs,
        });
      },

      togglePinTab: (pid) => {
        const s = get();
        if (s.pinnedTabs.includes(pid)) {
          // Unpinning moves the tab OUT of the pinned block, to the first
          // unpinned slot — leaving it sitting among the pins without a pin icon
          // read as a bug, and "pinned tabs occupy the front" is the invariant
          // moveTab clamps against, so a tab that isn't pinned must not be there.
          const pinnedTabs = s.pinnedTabs.filter((p) => p !== pid);
          const front = s.tabs.filter((t) => pinnedTabs.includes(t));
          const rest = s.tabs.filter((t) => t !== pid && !pinnedTabs.includes(t));
          set({ pinnedTabs, tabs: [...front, pid, ...rest] });
        } else {
          const pinnedTabs = [...s.pinnedTabs, pid];
          const front = pinnedTabs.filter((p) => s.tabs.includes(p));
          set({ pinnedTabs, tabs: [...front, ...s.tabs.filter((t) => !front.includes(t))] });
        }
      },

      // The pid is the KEY everywhere — remap every slice that carries it. Undo
      // stacks are cleared: their snapshots and line entries hold the old pid and
      // replaying them would resurrect it. (Loaded media in the video dock is
      // keyed by pid too and component-local; it drops on rename — re-pick it.)
      // The speaker label is data — it sits on every line and is what the excerpt
      // rule, the speaker map and the exports all key on — so renaming rewrites
      // the lines rather than storing a display alias. Project-wide, matching the
      // Speakers panel it's driven from: one map of colours and weights covers
      // every transcript, so one "P" renamed there is every "P".
      //
      // Renaming ONTO an existing speaker merges the two (the fix for a corpus
      // labelled "P" in one file and "P1" in another). The surviving name keeps
      // its own colour and weight — the merged-away one's settings would
      // otherwise silently redecorate a speaker the researcher already styled.
      renameSpeaker: (fromRaw, toRaw) => {
        const s = get();
        const from = fromRaw.trim(), to = toRaw.trim();
        if (!from) return "unknown speaker";
        if (!to) return "the name can't be empty";
        if (to === from) return null;
        const transcripts = { ...s.transcripts };
        let touched = 0;
        for (const [pid, t] of Object.entries(s.transcripts)) {
          if (!t.lines.some((l) => l.speaker.trim() === from)) continue;
          transcripts[pid] = { lines: t.lines.map((l) => l.speaker.trim() === from ? { ...l, speaker: to } : l) };
          touched++;
        }
        if (!touched) return "no lines carry that speaker";
        // A MERGE (the name already belongs to someone) keeps the survivor's own
        // styling — including its defaults, so folding a quiet interviewer into a
        // participant doesn't quietly dim the participant. A plain rename carries
        // the settings across; they describe the same person under a new label.
        const merging = Object.values(s.transcripts)
          .some((t) => t.lines.some((l) => l.speaker.trim() === to));
        const move = <T,>(m: Record<string, T>): Record<string, T> => {
          if (!(from in m)) return m;
          const n = { ...m };
          if (!merging) n[to] = n[from];
          delete n[from];
          return n;
        };
        // speakerFocus is pid -> speaker NAME, so the name lives in the value
        const speakerFocus = Object.fromEntries(
          Object.entries(s.ui.speakerFocus).map(([pid, sp]) => [pid, sp === from ? to : sp]));
        // Undo entries for text edits carry the whole Line, speaker included, so
        // an untouched stack would put the old name back on one line the next time
        // someone undid an edit. Rewrite them instead of clearing the history.
        const fixSpeaker = (o: LineSnap) =>
          o.line.speaker.trim() === from ? { ...o, line: { ...o.line, speaker: to } } : o;
        const fixStack = (stack: UndoEntry[]) => stack.map((o) =>
          o.kind === "line" ? fixSpeaker(o)
            : o.kind === "lines" ? { ...o, entries: o.entries.map(fixSpeaker) } : o);
        set({
          transcripts,
          ui: { ...s.ui, speakerColors: move(s.ui.speakerColors), speakerWeight: move(s.ui.speakerWeight), speakerFocus },
          undoStack: fixStack(s.undoStack), redoStack: fixStack(s.redoStack),
        });
        return null;
      },

      renameTranscript: (from, toRaw) => {
        const s = get();
        const to = toRaw.trim();
        if (!s.transcripts[from]) return "unknown transcript";
        if (!to) return "the name can't be empty";
        if (to === from) return null;
        if (!isTranscriptView(to)) return "that name is reserved";
        if (to.includes(":")) return "no “:” — segment refs use it (P01:2-4)";
        if (s.transcripts[to]) return "a transcript with that name already exists";
        const transcripts = { ...s.transcripts, [to]: s.transcripts[from] };
        delete transcripts[from];
        const aiFlags: typeof s.aiFlags = {};
        for (const [k, v] of Object.entries(s.aiFlags))
          aiFlags[k.startsWith(`${from}:`) ? `${to}:${k.slice(from.length + 1)}` : k] = v;
        const saved: typeof s.savedSelections = {};
        for (const [k, v] of Object.entries(s.savedSelections))
          saved[k === from ? to : k] = k === from ? { ...v, pid: to } : v;
        const video = { ...s.video };
        if (from in video) { video[to] = video[from]; delete video[from]; }
        const speakerFocus = { ...s.ui.speakerFocus };
        if (from in speakerFocus) { speakerFocus[to] = speakerFocus[from]; delete speakerFocus[from]; }
        const summaries = { ...s.summaries };
        if (from in summaries) { summaries[to] = summaries[from]; delete summaries[from]; }
        // the per-transcript brief override follows its transcript — left keyed
        // to the old name it would silently fall back to the study default
        const studyBrief = { ...s.studyBrief };
        if (from in studyBrief) { studyBrief[to] = studyBrief[from]; delete studyBrief[from]; }
        set({
          transcripts,
          segments: s.segments.map((x) => x.pid === from ? { ...x, pid: to } : x),
          markers: s.markers.map((x) => x.pid === from ? { ...x, pid: to } : x),
          stretches: s.stretches.map((x) => x.pid === from ? { ...x, pid: to } : x),
          lastPid: s.lastPid === from ? to : s.lastPid,
          summaries, studyBrief,
          extSegRows: s.extSegRows.map((r) => r.pid === from
            ? { ...r, pid: to, segment_ref: r.segment_ref.startsWith(`${from}:`) ? to + r.segment_ref.slice(from.length) : r.segment_ref }
            : r),
          // saved answers cite refs that begin with the pid, and their scope
          // names it — a rename that skipped them would leave every citation on
          // this transcript pointing at a name that no longer exists
          answers: s.answers.map((a) => ({
            ...a,
            points: a.points.map((pt) => ({ ...pt, refs: pt.refs.map((r) => renameRef(r, from, to)) })),
            scope: { ...a.scope, pids: a.scope.pids.map((x) => x === from ? to : x) },
          })),
          tabs: s.tabs.map((x) => x === from ? to : x),
          pinnedTabs: s.pinnedTabs.map((x) => x === from ? to : x),
          active: s.active === from ? to : s.active,
          selection: s.selection.pid === from ? { ...s.selection, pid: to } : s.selection,
          savedSelections: saved,
          aiFlags, video,
          ui: { ...s.ui, speakerFocus },
          undoStack: [], redoStack: [],
        });
        renameScroll(from, to); // same transcript, new name — keep the reader's place
        return null;
      },

      // In-app transcription fix. The imported text is kept in `orig` (first edit
      // wins) so the correction is a recorded, revertible fact, not a silent change;
      // editing back to the original clears the flag. Line ids never change, so
      // segments are untouched. On the undo stack as a targeted line entry (see
      // lineEntry) — `orig` stays the RECORD of the change, Ctrl+Z steps it back.
      replaceInTranscript: (pid, find, repl, only) => {
        const s = get();
        const t = s.transcripts[pid];
        // the sweep is bounded by the SAME filter the bar was counting with:
        // "replace every one of these" means every one it was showing, not
        // every one in the file (see LineScope)
        const inScope = only ? scopeFilter(only) : () => true;
        // NOT `find === repl`: matching is case-insensitive, so replacing
        // "System" with "system" is a real edit. Whether anything changed is
        // decided per line, below, where the answer is actually knowable.
        if (!t || !find) return 0;
        let n = 0;
        const entries: LineSnap[] = [];
        const lines = t.lines.map((l) => {
          if (!inScope(l)) return l;
          const { text, n: k } = replaceAllIn(l.text, find, repl);
          if (!k || text === l.text) return l;
          n += k;
          entries.push(lineEntry(s, pid, l.id)!);
          // provenance exactly as a hand edit leaves it (see editLine): the
          // words as transcribed stay recoverable on every line touched, and a
          // replace that lands back on the original text drops the mark
          const orig = l.orig ?? l.text;
          const { orig: _drop, ...rest } = l;
          return orig === text ? { ...rest, text } : { ...rest, orig, text };
        });
        if (!n) return 0;
        // ONE entry for the whole sweep — the same rule every multi-item
        // gesture in this store follows
        const stack = [...s.undoStack, { kind: "lines" as const, pid, entries }];
        if (stack.length > UNDO_CAP) stack.shift();
        set({ undoStack: stack, redoStack: [], selRun: false });
        set({ transcripts: { ...get().transcripts, [pid]: { lines } } });
        return n;
      },
      editLine: (pid, id, text) => {
        const s = get();
        const t = s.transcripts[pid];
        const cur = t?.lines.find((l) => l.id === id);
        if (!t || !cur || cur.text === text) return; // no change, no undo entry
        const entry = lineEntry(s, pid, id)!;
        const stack = [...s.undoStack, entry];
        if (stack.length > UNDO_CAP) stack.shift();
        set({ undoStack: stack, redoStack: [], selRun: false }); // same contract as pushUndo
        const lines = t.lines.map((l) => {
          if (l.id !== id || l.text === text) return l;
          const orig = l.orig ?? l.text;
          const { orig: _drop, ...rest } = l;
          return orig === text ? { ...rest, text } : { ...rest, orig, text };
        });
        set({ transcripts: { ...get().transcripts, [pid]: { lines } } });
      },

      setAi: (patch) => set({ ai: { ...get().ai, ...patch } }),

      // Record EVERY line that was scanned, not just the marked ones: a clean line
      // with no record would look unscanned and be re-sent (and re-billed) next run.
      // A line re-scanned under new lenses keeps its spans from lenses NOT in this
      // scan (they weren't re-evaluated) and accumulates the scanned-lens set.
      addFlags: (pid, flags, lines, scanned) => {
        const next = { ...get().aiFlags };
        for (const l of lines) {
          const key = `${pid}:${l.id}`;
          const hash = hashLine(l.text);
          const prev = next[key];
          const fresh = flags[l.id] ?? [];
          if (prev && prev.hash === hash) {
            const kept = prev.spans.filter((s) => !scanned.includes(s.lens ?? "transcription"));
            next[key] = { hash, lenses: [...new Set([...(prev.lenses ?? ["transcription"]), ...scanned])], spans: [...kept, ...fresh] };
          } else {
            next[key] = { hash, lenses: scanned, spans: fresh };
          }
        }
        set({ aiFlags: next, redoStack: [] }); // line-entry redo snapshots hold flags — invalidate
      },
      // grounding results merge in; a deleted segment's record goes with it (below)
      addGrounds: (recs) => set({ aiGrounds: { ...get().aiGrounds, ...recs } }),
      // "I disagree with this mark": the span goes, but the line stays recorded as
      // scanned under that lens, so dismissing doesn't cause a re-fetch of the same mark.
      dismissNotice: (pid, id, lens, quote) => {
        const key = `${pid}:${id}`;
        const cur = get().aiFlags[key];
        if (!cur) return;
        // redoStack cleared too: redoing an older line edit would restore the flag
        // snapshot from before this dismissal — the dismissed mark would come back
        set({ aiFlags: { ...get().aiFlags, [key]: { ...cur, spans: cur.spans.filter((s) => !((s.lens ?? "transcription") === lens && s.quote === quote)) } }, redoStack: [] });
      },
      // One-click transcription repair from a mark's popover. Rides editLine (so
      // `orig` tracking, the ✱ diff and exports behave exactly like a manual
      // repair), then re-hashes the flag record against the corrected text with
      // only the applied span removed — an edit normally invalidates every mark
      // on the line, which would strand a second error until a re-scan.
      applyFix: (pid, id, quote, fix) => {
        const l = get().transcripts[pid]?.lines.find((x) => x.id === id);
        if (!l || !l.text.includes(quote)) return;
        // replacer FUNCTION, not the string: in String.replace a string replacement
        // interprets $-sequences ($&, $', $`), so a fix containing them would write
        // something other than what the Apply button showed
        const text = l.text.replace(quote, () => fix); // first occurrence — the one the mark underlines
        get().editLine(pid, id, text);
        const key = `${pid}:${id}`;
        const cur = get().aiFlags[key];
        if (!cur) return;
        // drop the applied span, and any span whose quote the repair broke (it can
        // never render again, but would still be read out by the line announcement)
        const spans = cur.spans.filter((s) =>
          !(spanLens(s) === "transcription" && s.quote === quote) && text.includes(s.quote));
        set({ aiFlags: { ...get().aiFlags, [key]: { ...cur, hash: hashLine(text), spans } } });
      },

      logAiCall: (call) => set({ aiLog: [...get().aiLog, call] }),
      // One helper for every run's catch block, so "every AI request made" is
      // true of ai-provenance.csv rather than nearly true. Usage is zero because
      // the API reported none — the money may still have been spent, and the
      // data certainly left. An AbortError is a cancelled run, not a failure,
      // and the two are worth telling apart in an appendix.
      logAiIncomplete: (e, c) => get().logAiCall({
        at: new Date().toISOString(), ...c, inTok: 0, outTok: 0, costUsd: 0,
        outcome: (e as Error)?.name === "AbortError" ? "aborted" : "failed",
      }),

      // Append-only, and deliberately NOT undoable: see Decision. Called from
      // inside the codebook actions themselves rather than from every caller,
      // so a merge made from the sidebar, the map or a modal all land the same
      // row — the caller only has to supply the reason when it has one.
      logDecision: (d) => set({ ledger: [...get().ledger, { ...d, at: d.at ?? new Date().toISOString() }] }),
      // Appendix B: what was decided, why, and whose idea it was.
      exportLedger: () => toCSV(
        get().ledger.map((d) => ({
          at: d.at, kind: d.kind, codes: d.codes.join(" | "), why: d.why,
          source: d.source, model: d.model ?? "",
          count: d.moved ?? "", excerpts_after: d.now ?? "",
          blind: d.blind ?? "", undone: d.undone ? "yes" : "",
        })),
        ["at", "kind", "codes", "why", "source", "model", "count", "excerpts_after", "blind", "undone"]
      ),
      // Sections had no CSV of their own until F7 gave the AI a way to propose
      // them — which also gave the bundle a way to be wrong: it calls itself
      // "the whole bundle", and a co-author reading it would have found every
      // section missing. Rejected rows go too: they are the memory a re-run
      // consults, and an appendix that says which boundaries were turned down
      // is saying something about how the analysis was made.
      exportSections: () => toCSV(
        [...get().stretches]
          .sort((a, b) => a.pid.localeCompare(b.pid) || a.start - b.start || a.end - b.end
            || a.dim.localeCompare(b.dim) || a.value.localeCompare(b.value))
          .map((x) => ({
            pid: x.pid, line_start: x.start, line_end: x.end, dim: x.dim, value: x.value,
            // blank means the researcher marked it themselves — the same thing
            // an absent status has always meant in the store (see Stretch)
            status: x.status ?? "", proposed_by: x.proposedBy ?? "", why: x.why ?? "",
          })) as unknown as Record<string, unknown>[],
        ["pid", "line_start", "line_end", "dim", "value", "status", "proposed_by", "why"]
      ),
      exportAiLog: () => toCSV(
        get().aiLog as unknown as Record<string, unknown>[],
        // outcome: blank for a run that completed, which is what every row
        // written before the field existed was (see AiCall)
        ["at", "model", "task", "pid", "lines", "redactions", "inTok", "outTok", "costUsd", "outcome"]
      ),

      // The other half of the CSV interchange story: importCodebook has always
      // existed with no exporter, so colors and definitions could only ever be lost.
      exportCodebook: () => {
        const cb = get().codebook;
        // def_source travels with the definition: without it, re-importing this
        // file into a fresh workspace would relabel untouched AI text as
        // human-written — the one direction of that error that matters, since it
        // launders a draft nobody has checked as a researcher's own words.
        const rows = Object.keys(cb).sort().map((code) => ({
          code, color: cb[code].color, short_def: cb[code].def, status: cb[code].status,
          def_source: cb[code].def ? (cb[code].defAi ? "ai" : "human") : "",
          // which codes you set aside belongs in an appendix as much as which
          // you kept: a codebook of 90 codes reads differently when 30 more
          // are sitting beside it, unrejected
          set_aside: cb[code].parked ? "yes" : "",
        }));
        return toCSV(rows, ["code", "color", "short_def", "status", "def_source", "set_aside"]);
      },

      // Re-importable transcript, carrying the CORRECTED text. `original` is the
      // pre-correction text (informational; the importer ignores unknown columns).
      exportTranscript: (pid) => {
        const t = get().transcripts[pid];
        if (!t) return "";
        const rows = t.lines.map((l) => ({
          line_id: String(l.id), timestamp: l.ts, end_timestamp: l.end ?? "",
          speaker: l.speaker, text: l.text, text_en: l.en ?? "", original: l.orig ?? "",
        }));
        // Each optional column earns its place only when the data has one.
        // text_en is written BESIDE text, never instead of it: an export is the
        // evidence trail, and one that carried only the translation would leave
        // no way back to what was actually said.
        const cols = ["line_id", "timestamp",
          ...(t.lines.some((l) => l.end) ? ["end_timestamp"] : []),
          "speaker", "text",
          ...(t.lines.some((l) => l.en) ? ["text_en"] : []),
          "original"];
        return toCSV(rows, cols);
      },

      // Events for ONE transcript, from that tab's own "Load events…". Additive and
      // idempotent: a row already held (same time, event, code, text) is skipped, so
      // re-dropping the same file is a no-op while a second file merges in. Rows with
      // no readable time are counted as skipped, not silently lost.
      importMarkers: (pid, rows) => {
        const s = get();
        const parsed = parseMarkers(rows, pid, s.nextMid);
        const seen = new Set(s.markers.map(markerIdent));
        const fresh = parsed.filter((m) => !seen.has(markerIdent(m)));
        if (fresh.length) {
          get().pushUndo(); // an import is an edit: undoable, and it invalidates redo
          // re-number from nextMid: the parse numbered every row, dupes included
          const added = fresh.map((m, i) => ({ ...m, mid: s.nextMid + i }));
          set({ markers: [...get().markers, ...added], nextMid: s.nextMid + added.length });
          earcon.mark(); // one mark for the batch, not one per row
        }
        return { added: fresh.length, skipped: rows.length - fresh.length };
      },
      editMarker: (mid, label) => {
        const cur = get().markers.find((m) => m.mid === mid);
        if (!cur || cur.label === label) return; // no change, no undo entry
        get().pushUndo();
        set({ markers: get().markers.map((m) => m.mid === mid ? { ...m, label } : m) });
        earcon.mark();
      },
      // An event written IN the app (add-event modal), not from a file. event:"marker"
      // and an empty raw: the export writes the canonical columns for it, so it
      // round-trips like any recorded one. Same identity dedup as the importer —
      // adding the exact same event twice is a no-op, not a duplicate.
      addMarker: (pid, m) => {
        const s = get();
        const marker: Marker = { mid: s.nextMid, pid, event: "marker",
          code: m.code.trim(), label: m.label.trim(), t: m.t, detail: "", raw: {} };
        if (s.markers.some((x) => markerIdent(x) === markerIdent(marker))) {
          announce("Already marked — an identical event exists at this time.");
          return;
        }
        get().pushUndo();
        set({ markers: [...s.markers, marker], nextMid: s.nextMid + 1 });
        earcon.mark();
        announce("Event added");
      },

      updateMarker: (mid, m) => {
        const cur = get().markers.find((x) => x.mid === mid);
        if (!cur) return;
        const next = { ...cur, t: m.t, code: m.code.trim(), label: m.label.trim() };
        if (next.t === cur.t && next.code === cur.code && next.label === cur.label) return; // no change, no undo entry
        get().pushUndo();
        set({ markers: get().markers.map((x) => x.mid === mid ? next : x) });
        earcon.mark();
        announce("Event updated");
      },

      // Rename every event of one type — the codebook's renameCode, for events.
      // Writes the new name into `code` even where the key came from `event`
      // (recording_start & co), which is exactly what markerKey prefers; the chosen
      // colour follows the name so the type doesn't visually reset.
      renameMarkerType: (from, to) => {
        const name = to.trim();
        if (!name || name === from) return;
        get().pushUndo();
        const s = get();
        set({ markers: s.markers.map((x) => markerKey(x) === from ? { ...x, code: name } : x) });
        const colors = { ...get().ui.markerColors };
        if (from in colors && !(name in colors)) { colors[name] = colors[from]; }
        delete colors[from];
        set({ ui: { ...get().ui, markerColors: colors } });
      },

      // Recolour one event type. Like setColor for a code: no undo entry (it's a
      // display choice, not coding), but redo must go — a stale redo snapshot
      // would otherwise walk back over it.
      setMarkerColor: (key, color) =>
        set({ ui: { ...get().ui, markerColors: { ...get().ui.markerColors, [key]: color } }, redoStack: [] }),

      deleteMarker: (mid) => {
        if (!get().markers.some((m) => m.mid === mid)) return;
        get().pushUndo();
        set({ markers: get().markers.filter((m) => m.mid !== mid) });
        earcon.unmark();
        announce("Event deleted");
      },
      // Clear one transcript's event log — the way back out of a wrong events CSV,
      // which otherwise had to be undone one row at a time. Markers ride in the
      // snapshot, so this is a single undoable step.
      clearMarkers: (pid) => {
        const s = get();
        const rest = s.markers.filter((m) => m.pid !== pid);
        const n = s.markers.length - rest.length;
        if (!n) return 0;
        get().pushUndo();
        set({ markers: rest });
        announce(`${n} event${n === 1 ? "" : "s"} removed from ${pid}`);
        return n;
      },
      // Round-trip: every column the source file carried, edits applied. Ordered by
      // transcript then time, so a multi-session export reads like the sessions ran.
      exportMarkers: () => {
        const s = get();
        const order = [...s.tabs, ...Object.keys(s.transcripts).filter((p) => !s.tabs.includes(p))];
        const rank = (pid: string) => { const i = order.indexOf(pid); return i < 0 ? order.length : i; };
        const sorted = [...s.markers].sort((a, b) => rank(a.pid) - rank(b.pid) || a.t - b.t);
        const { rows, fields } = markerRows(sorted);
        return toCSV(rows, fields);
      },

      exportNotices: () => {
        const s = get();
        const rows: Record<string, string>[] = [];
        // every loaded transcript, not just open tabs — a closed tab's noticings are
        // still project data; tabs first to keep the familiar row order
        const pids = [...s.tabs, ...Object.keys(s.transcripts).filter((p) => !s.tabs.includes(p))];
        for (const pid of pids) {
          const t = s.transcripts[pid];
          if (!t) continue;
          for (const l of t.lines) {
            const f = s.aiFlags[`${pid}:${l.id}`];
            if (!f || f.hash !== hashLine(l.text)) continue;
            for (const sp of f.spans) {
              const lens = sp.lens ?? "transcription";
              if (lens === "transcription") continue;
              rows.push({ pid, line_id: String(l.id), speaker: l.speaker, lens, quote: sp.quote, note: sp.reason, line: l.text });
            }
          }
        }
        return toCSV(rows, ["pid", "line_id", "speaker", "lens", "quote", "note", "line"]);
      },

      exportProject: () => {
        const s = get();
        const p: Project = {
          format: FORMAT,
          // Stamped for what the file CONTAINS, not for the build that wrote
          // it: a project holding nothing an older build could get wrong stays
          // v1 and stays openable there.
          // Two things make it v2. A stretch with a status, because a v1 build
          // has no notion of one and would count an unjudged candidate as a
          // section the researcher drew. And a study brief, because a v1 build
          // does not carry the field at all — it would open the file, not know
          // studyBrief exists, and drop it on the next save. A brief survives a
          // run that proposed nothing and a run whose proposals were discarded,
          // so "has a statused stretch" was never the whole test.
          // Verdict and discard rows make it v3: a v2 build treats every AI row
          // as a codebook proposal and would inflate the consolidation account
          // with codings and sections that never changed a code's identity.
          version: s.ledger.some((d) =>
            d.kind === "accept-coding" || d.kind === "reject-coding" || d.kind === "discard-coding"
            || d.kind === "accept-section" || d.kind === "reject-section" || d.kind === "discard-section")
            ? VERSION
            : s.stretches.some((x) => x.status)
              || Object.values(s.studyBrief).some((t) => t.trim()) ? 2 : 1,
          savedAt: new Date().toISOString(),
          transcripts: s.transcripts, segments: s.segments, codebook: s.codebook,
          extSegRows: s.extSegRows, tabs: s.tabs, pinnedTabs: s.pinnedTabs, active: s.active,
          hotbar: s.hotbar, video: s.video,
          ai: s.ai, aiFlags: s.aiFlags, aiGrounds: s.aiGrounds, aiLog: s.aiLog,
          ledger: s.ledger,   // what was decided, and why — the methods appendix
          markers: s.markers, // session events + field notes: study data, not a preference
          markerColors: s.ui.markerColors,
          stretchColors: s.ui.stretchColors,
          summaries: s.summaries, // session summaries: the researcher's artifact, study data
          projectNotes: s.projectNotes, // the project memo document — ditto
          projectName: s.projectName,     // the study's name — ditto
          codeGroups: s.codeGroups,       // Code map groupings — ditto
          codeAreas: s.codeAreas,         // the AI areas view — an AI pass, worth keeping
          codeAreasFp: s.codeAreasFp,
          stretches: s.stretches,         // what each span of talk belongs to — study data
          studyBrief: s.studyBrief,       // the study's shape, in the researcher's words — study data
          codePlan: s.codePlan,           // pending reconciliation verdicts — ditto
          codeClusters: s.codeClusters,   // pending merge-clusters — ditto
          answers: s.answers,     // …and so are the questions asked of the material
          // the speaker map rides along even though it lives in `ui`: who the
          // interviewer is belongs to the study, not to my font size (see project.ts)
          speakers: { colors: s.ui.speakerColors, weight: s.ui.speakerWeight },
          // NB: no API key (not in the store), no other UI prefs, no media — see project.ts
        };
        return JSON.stringify(p, null, 2);
      },

      setPendingProject: (p) => set({ pendingProject: p }),

      // Replaces the workspace wholesale. Merging would mean sid collisions and
      // code-name conflicts for no benefit; the modal confirms before we get here.
      openProject: (p) => {
        const s = get();
        // A file written before the speaker map existed carries none — re-guess the
        // interviewer from its own speakers, so an old project still opens with the
        // researcher quieted rather than everyone flat.
        const speakers = p.speakers ?? {
          colors: {},
          weight: Object.fromEntries(
            guessQuiet(speakersOf({ transcripts: p.transcripts, tabs: p.tabs }))
              .map((sp) => [sp, "quiet" as SpeakerWeight])),
        };
        set({
          // speakerFocus doesn't travel between studies — a stale name matching a
          // speaker in the loaded project would silently dim everyone else
          ui: { ...s.ui, speakerColors: speakers.colors, speakerWeight: speakers.weight, speakerFocus: {},
            markerColors: p.markerColors ?? {},
            stretchColors: p.stretchColors ?? {} },
          // ascending line ids are an invariant everything downstream leans on
          // (binary searches, rowsToLines) — rehydrate enforces it, and a
          // hand-edited project file must not be the one path that skips it
          transcripts: Object.fromEntries(Object.entries(p.transcripts).map(([pid, t]) =>
            [pid, t.lines.some((l, i) => i > 0 && l.id < t.lines[i - 1].id)
              ? { ...t, lines: [...t.lines].sort((a, b) => a.id - b.id) } : t])),
          segments: p.segments, codebook: p.codebook,
          extSegRows: p.extSegRows, tabs: p.tabs, pinnedTabs: p.pinnedTabs ?? [], active: p.active,
          hotbar: p.hotbar, video: p.video, ai: p.ai, aiFlags: p.aiFlags, aiGrounds: p.aiGrounds ?? {}, aiLog: p.aiLog,
          ledger: p.ledger ?? [],
          markers: p.markers ?? [],
          summaries: p.summaries ?? {},
          projectNotes: p.projectNotes ?? "",
          projectName: p.projectName ?? "",
          codeGroups: p.codeGroups ?? [],
          codeAreas: p.codeAreas ?? [],
          stretches: p.stretches ?? [],
          studyBrief: p.studyBrief ?? {},
          codeAreasFp: p.codeAreasFp ?? "",
          codePlan: (p.codePlan ?? []).filter((a) => a.action !== "merge"),
          // emit-never, load-always: pairwise merges from older files become
          // 2-member clusters, so saved plans keep working
          codeClusters: stampCids([
            ...(p.codeClusters ?? []),
            ...(p.codePlan ?? []).filter((a) => a.action === "merge" && a.into).map((a) => ({
              survivor: a.into!, codes: [a.code, a.into!],
              ...(a.newName ? { newName: a.newName } : {}), rationale: a.rationale,
            })),
          ], { fromFile: true }),
          answers: p.answers ?? [],
          // transient state belongs to the old workspace, not the loaded one —
          // the map layouts included: they are keyed by this project's code
          // names and cluster ids, and the next project reuses both with
          // different meanings, so its capsules would materialize on the spots
          // someone arranged for a different study
          mapPositions: emptyLayout(), mapIslandPos: emptyLayout(),
          selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [],
          jump: null, search: NO_SEARCH,
          pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false,
          nextSid: p.segments.reduce((m, x) => Math.max(m, x.sid), 0) + 1, // reduce, not spread: spreading throws past ~65k elements
          nextMid: (p.markers ?? []).reduce((m, x) => Math.max(m, x.mid), 0) + 1,
          nextAid: (p.answers ?? []).reduce((m, x) => Math.max(m, x.aid), 0) + 1,
        });
        set({
          hotbarCache: hotbarCodes(get()),
          codeClusters: stampCids(normalizeClusters(get(), get().codeClusters)),
        });
        forgetScroll(); // every pid in the new project is a different transcript
        projectSwapped(); // ...and view session state keyed by code names goes too
      },

      exportEdits: () => {
        const s = get();
        const rows: Record<string, string>[] = [];
        for (const [pid, t] of Object.entries(s.transcripts))
          for (const l of t.lines)
            if (l.orig !== undefined)
              rows.push({ pid, line_id: String(l.id), timestamp: l.ts, speaker: l.speaker, original: l.orig, corrected: l.text });
        return toCSV(rows, ["pid", "line_id", "timestamp", "speaker", "original", "corrected"]);
      },

      // These three mutate snapshotted state without an undo entry (notes are per-
      // keystroke; colors/defs are minor), but they MUST invalidate redo: a stale
      // redo snapshot would otherwise overwrite the edit and resurrect undone coding.
      setStretchRange: (i, start, end) =>
        set({ stretches: get().stretches.map((x, k) => k === i ? { ...x, start, end } : x), redoStack: [] }),
      setSegmentRange: (sid, start, end) =>
        set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, start, end } : x), redoStack: [] }),
      deleteSegment: (sid) => {
        const seg = get().segments.find((x) => x.sid === sid);
        get().pushUndo();
        const grounds = { ...get().aiGrounds };
        delete grounds[sid]; // its grounding dies with it
        set({ segments: get().segments.filter((x) => x.sid !== sid), aiGrounds: grounds });
        // A candidate removed through its own popover made the same decision as
        // Clear candidates. The row must survive the proposal it explains; once
        // the segment is gone, no current-state field can recover that it left
        // without a verdict.
        if (seg?.status === "candidate" && isAiProposed(seg.proposedBy)) {
          get().logDecision({ kind: "discard-coding", codes: [seg.code],
            ...decisionSourceOf(seg.proposedBy), moved: 1,
            // A discard row's kind and count already say what happened and to how many.
            // Restating that as the reason prints it twice in the panel and fills the
            // export's `why` column with something the researcher never wrote.
            why: "No reason recorded" });
        }
        earcon.uncode();
        announce("Segment deleted");
      },
      // The way out of a suggestion run you didn't want: rejecting each candidate
      // one at a time is the same work twice over. Undoable in one step — this can
      // remove a lot at once, and the accepted case removes actual analysis.
      deleteSegmentsBy: ({ pid, status }) => {
        const s = get();
        const doomed = s.segments.filter((x) => x.status === status && (!pid || x.pid === pid));
        if (!doomed.length) return 0;
        get().pushUndo();
        const gone = new Set(doomed.map((x) => x.sid));
        set({ segments: s.segments.filter((x) => !gone.has(x.sid)) });
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
        // Only a candidate batch records a new disposition. Clearing settled
        // codings is housekeeping: their verdict is already a row, while a
        // candidate batch leaves without ever acquiring one.
        // ...and only for the PROPOSALS in it. A hand-marked candidate is not a
        // proposal, so counting it here would put the researcher's own work into
        // a row about what a model suggested — and attributing the whole batch to
        // the researcher because one member was theirs would hide the AI discards
        // from the methods paragraph entirely (it counts source "ai" rows).
        const proposed = doomed.filter((x) => isAiProposed(x.proposedBy));
        if (status === "candidate" && proposed.length) {
          get().logDecision({ kind: "discard-coding", codes: distinct(proposed.map((x) => x.code)),
            ...batchDecisionSource(proposed), moved: proposed.length,
            // A discard row's kind and count already say what happened and to how many.
            // Restating that as the reason prints it twice in the panel and fills the
            // export's `why` column with something the researcher never wrote.
            why: "No reason recorded" });
        }
        announce(`${doomed.length} ${status} coding${doomed.length === 1 ? "" : "s"} deleted`);
        return doomed.length;
      },
      setStatus: (sid, status) => {
        const s = get();
        const seg = s.segments.find((x) => x.sid === sid);
        get().pushUndo();
        set({ segments: s.segments.map((x) => x.sid === sid ? { ...x, status } : x) });
        // The ledger is history, so changing an earlier verdict is a new row,
        // not an edit to the first one. Restricting this to the persisted AI
        // prefix keeps ordinary hand-marked status changes out of provenance.
        //
        // resolveSegUpdates deliberately sits outside this boundary: importing a
        // CSV is one act of accepting a FILE, not a verdict passed on each row it
        // carries, and writing a decision per imported status would claim the
        // researcher judged excerpts they never saw. The imported provenance
        // travels in the file's own status/proposed_by columns, and the paragraph
        // stays correct either way because it counts current state, not rows.
        if (seg && isAiProposed(seg.proposedBy)
          && seg.status !== status && (status === "accepted" || status === "rejected")) {
          get().logDecision({ kind: status === "accepted" ? "accept-coding" : "reject-coding",
            codes: [seg.code], ...decisionSourceOf(seg.proposedBy), moved: 1,
            // Grounding says which words carry a code, not why the researcher
            // accepted it; it can also be stale unless its hash is revalidated.
            // "No reason recorded", as dismissCluster does: a fallback that
            // restates the verdict would read in the export as a rationale the
            // researcher gave, and they gave none
            why: seg.notes.trim() || "No reason recorded" });
        }
        // the audible twin of the status flip — Accept/Reject buttons in the
        // popover and the Assist queue had no mark at all
        if (status === "accepted") earcon.accept();
        else if (status === "rejected") earcon.reject();
        announce(`Segment ${status}`);
      },
      rejectCode: (code, why, source, model) => {
        get().pushUndo();
        let n = 0;
        set({ segments: get().segments.map((x) =>
          norm(x.code) === norm(code) && x.status === "accepted" ? (n++, { ...x, status: "rejected" }) : x) });
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
        get().logDecision({ kind: "remove", codes: [code], source: source ?? "you",
          why: why || `Rejected all ${n} excerpt${n === 1 ? "" : "s"} of this code`, ...(model ? { model } : {}),
          moved: n, now: 0 });
        announce(`${n} excerpt${n === 1 ? "" : "s"} of ${code} rejected`);
      },
      setNotes: (sid, notes) => set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, notes } : x), redoStack: [] }),
      // per keystroke, like notes. Summaries aren't in the undo snapshot, so no
      // redo invalidation is needed — undo/redo never touch them.
      setSummary: (pid, text) => set({ summaries: { ...get().summaries, [pid]: text } }),
      setProjectNotes: (text) => set({ projectNotes: text }),
      setProjectName: (name) => set({ projectName: name }),
      // every map mutation is one undoable history entry (design premise 7)
      setCodeGroups: (groups) => { get().pushUndo(); set({ codeGroups: groups.filter((g) => g.codes.length > 0) }); },
      // the areas view: stored with the signature of the codebook it read, so
      // the map can offer a re-run once the book has moved on
      setCodeAreas: (areas, fp) => {
        get().pushUndo();
        set({ codeAreas: areas.filter((g) => g.codes.length > 0), codeAreasFp: fp });
      },
      markStretch: (st) => {
        // an exact duplicate is a full no-op: no state change, no history entry.
        // Overlaps are allowed on purpose (dims, and re-marking).
        const cur = get().stretches;
        if (cur.some((x) => x.pid === st.pid && x.start === st.start && x.end === st.end
          && x.dim === st.dim && x.value === st.value)) return;
        get().pushUndo();
        set({ stretches: [...cur, st] });
      },
      // The brief is not project-shaped state that a run may quietly rewrite:
      // it is something the researcher wrote. Only these two, both behind an
      // explicit button, change it.
      setStudyBrief: (pid, text) => set({ studyBrief: { ...get().studyBrief, [pid]: text } }),
      clearStudyBrief: (pid) => {
        const next = { ...get().studyBrief };
        delete next[pid]; // DELETE, not "": an empty string is a real override
        set({ studyBrief: next });
      },

      // A run's proposals land in ONE store gesture. markStretch owns its own
      // pushUndo, so looping it over thirty proposals would leave thirty undo
      // entries and thirty presses of Ctrl+Z to take a run back — F3 settled
      // this shape already (one push per run; addSegment pushes nothing).
      landSections: (pid, proposals, proposedBy) => {
        if (!proposals.length) return 0;
        get().pushUndo();
        set({ stretches: [...get().stretches, ...proposals.map((p) => ({
          pid, start: p.start, end: p.end, dim: p.dim, value: p.value,
          status: "candidate" as const, proposedBy, why: p.why,
        }))] });
        return proposals.length;
      },
      setStretchStatus: (i, status) => {
        const cur = get().stretches;
        const stretch = cur[i];
        if (!stretch || stretch.status === status) return;
        get().pushUndo();
        set({ stretches: cur.map((x, k) => k === i ? { ...x, status } : x) });
        // A later change of mind is another decision in the history. Hand-drawn
        // sections have no AI prefix and remain ordinary edits rather than
        // model-proposal verdicts.
        if (isAiProposed(stretch.proposedBy) && status !== "candidate") {
          get().logDecision({ kind: status === "accepted" ? "accept-section" : "reject-section",
            codes: sectionDecisionLabels([stretch]), ...decisionSourceOf(stretch.proposedBy), moved: 1,
            // `stretch.why` is the model's pitch and remains on the stretch for
            // the review UI. Copying it here would attribute the model's words
            // to the researcher as the reason for their verdict.
            why: "No reason recorded" });
        }
        if (status === "accepted") earcon.accept();
        else if (status === "rejected") earcon.reject();
        announce(`Section ${status}`);
      },
      acceptSections: (pid) => {
        const cur = get().stretches;
        const candidates = cur.filter((x) => x.pid === pid && x.status === "candidate");
        const n = candidates.length;
        if (!n) return 0;
        get().pushUndo();
        set({ stretches: cur.map((x) =>
          x.pid === pid && x.status === "candidate" ? { ...x, status: "accepted" as const } : x) });
        const proposed = candidates.filter((x) => isAiProposed(x.proposedBy));
        if (proposed.length) {
          get().logDecision({ kind: "accept-section", codes: sectionDecisionLabels(proposed),
            ...batchDecisionSource(proposed), moved: proposed.length,
            // The batch control records no researcher-authored note. Its model
            // pitches remain on the stretches, but none may impersonate the
            // researcher's reason in the decision export.
            why: "No reason recorded" });
        }
        earcon.accept();
        announce(`${n} section${n === 1 ? "" : "s"} accepted`);
        return n;
      },
      // Discarding is not rejecting: a rejected stretch is KEPT as memory so a
      // re-run does not propose it again, while a deleted one is forgotten and
      // may come back. Both are offered; the buttons say which is which.
      deleteStretchesBy: ({ pid, status }) => {
        const cur = get().stretches;
        const doomed = cur.filter((x) => x.status === status && (!pid || x.pid === pid));
        if (!doomed.length) return 0;
        get().pushUndo();
        const gone = new Set(doomed);
        set({ stretches: cur.filter((x) => !gone.has(x)) });
        // Same rule as deleteSegmentsBy: a settled section already has its verdict,
        // and of the candidates only the PROPOSED ones leave a row — a section the
        // researcher drew by hand and then cleared is their own work being undone,
        // not a proposal they declined to judge.
        const proposed = doomed.filter((x) => isAiProposed(x.proposedBy));
        if (status === "candidate" && proposed.length) {
          get().logDecision({ kind: "discard-section", codes: sectionDecisionLabels(proposed),
            ...batchDecisionSource(proposed), moved: proposed.length,
            // A discard row's kind and count already say what happened and to how many.
            // Restating that as the reason prints it twice in the panel and fills the
            // export's `why` column with something the researcher never wrote.
            why: "No reason recorded" });
        }
        announce(`${doomed.length} ${status} section${doomed.length === 1 ? "" : "s"} discarded`);
        return doomed.length;
      },
      unmarkStretch: (i) => {
        get().pushUndo();
        set({ stretches: get().stretches.filter((_, k) => k !== i) });
      },
      // re-label ONE stretch in place (the pill's right-click edit): same
      // dup-guard as markStretch, one undo entry
      editStretch: (i, dim, value) => {
        const cur = get().stretches;
        const st = cur[i];
        const d = dim.trim(), v = value.trim();
        if (!st || !d || !v || (st.dim === d && st.value === v)) return;
        if (cur.some((x, k) => k !== i && x.pid === st.pid && x.start === st.start
          && x.end === st.end && x.dim === d && x.value === v)) return;
        get().pushUndo();
        set({ stretches: cur.map((x, k) => (k === i ? { ...x, dim: d, value: v } : x)) });
      },
      setStretchColor: (value, color) =>
        set({ ui: { ...get().ui, stretchColors: { ...get().ui.stretchColors, [value.toLowerCase().trim()]: color } },
          redoStack: [] }),
      setCodePlan: (plan) => { get().pushUndo(); set({ codePlan: plan }); },
      resetMapLayout: (stage) => {
        const s = get();
        if (!Object.keys(s.mapPositions[stage]).length && !Object.keys(s.mapIslandPos[stage]).length) {
          announce("The map is already in its packed layout"); return false;
        }
        get().pushUndo();
        // only THIS stage: the other one's layout is a different piece of work
        set({
          mapPositions: { ...s.mapPositions, [stage]: {} },
          mapIslandPos: { ...s.mapIslandPos, [stage]: {} },
        });
        announce("Map laid out fresh");
        return true;
      },
      applyThemeGroups: (groups) => {
        get().pushUndo();
        set({
          codeGroups: groups.filter((g) => g.codes.length > 0),
          // a fresh theming lays the ISLAND stage out again; Reconcile keeps its own
          mapPositions: { ...get().mapPositions, themes: {} },
          mapIslandPos: { ...get().mapIslandPos, themes: {} },
        });
      },
      applyReconcilePlan: (clusters, actions, resetLayout, source, model) => {
        get().pushUndo();
        // stamp where these came from ONCE, here, where a run lands — the
        // ledger row is written much later, when the researcher accepts, and
        // by then nothing else remembers whose idea it was. Only UNSTAMPED
        // entries: a scoped rerun carries surviving pending proposals through
        // (mergeScopedClusters / mergeFocusResults), and those already know
        // their origin — restamping would credit e.g. a wording-sweep capsule
        // to a model that never saw it.
        const from = <T extends { source?: DecisionSource; model?: string }>(x: T): T =>
          source && !x.source ? { ...x, source, ...(model ? { model } : {}) } : x;
        set({
          // the sanitizer already enforced a valid member survivor; keep that
          // deliberate direction, fall back to evidence only when it broke
          codeClusters: stampCids(clusters.filter((c) => c.codes.length >= 2)
            .map((c) => from({ ...c, survivor: bestSurvivor(get(), c.codes, c.survivor) }))),
          codePlan: actions.map(from),
          ...(resetLayout ? {
            mapPositions: { ...get().mapPositions, reconcile: {} },
            mapIslandPos: { ...get().mapIslandPos, reconcile: {} },
          } : {}),
        });
      },
      // a completed Reconcile drop: position + membership change, ONE entry.
      // targetCi === null leaves whatever cluster the code was in (outside is
      // just outside); a number joins that cluster (leaving any other).
      // The batched drop. React Flow reports a multi-selection drag ONCE, with
      // the whole set, so filing only the grabbed node left every other
      // selected code snapping back to its packed spot on the next rebuild.
      applyMapDrop: (d) => {
        get().pushUndo();
        const s = get();
        const stage = d.stage;
        let clusters = s.codeClusters;
        for (const { code, ci } of d.reconcile ?? []) {
          const cur = clusters.findIndex((c) => c.codes.includes(code));
          if (cur === ci) continue;
          clusters = clusters.map((c, i) => {
            let codes = c.codes;
            if (i === cur) codes = codes.filter((x) => x !== code);
            if (i === ci && !codes.includes(code)) codes = [...codes, code];
            return codes === c.codes ? c : { ...c, codes };
          });
        }
        if (clusters !== s.codeClusters) {
          clusters = clusters
            .filter((c) => c.codes.length >= 2)
            .map((c) => ({ ...c, survivor: bestSurvivor(get(), c.codes, c.survivor) }));
        }
        let groups = s.codeGroups;
        const positions = { ...s.mapPositions[stage], ...(d.chips ?? {}) };
        for (const { code, gi } of d.themes ?? []) {
          const cur = groups.findIndex((g) => g.codes.includes(code));
          if (cur === gi) continue;
          groups = groups.map((g, i) => ({
            ...g,
            codes: i === gi ? [...g.codes, code] : g.codes.filter((x) => x !== code),
          }));
        }
        if (groups !== s.codeGroups) groups = groups.filter((g) => g.codes.length > 0);
        let areas = s.codeAreas;
        for (const { code, ai } of d.areas ?? []) {
          const cur = areas.findIndex((a) => a.codes.includes(code));
          if (cur === ai) continue;
          areas = areas.map((a, i) => ({
            ...a,
            codes: i === ai ? [...a.codes, code] : a.codes.filter((x) => x !== code),
          }));
        }
        if (areas !== s.codeAreas) areas = areas.filter((a) => a.codes.length > 0);
        // the caller decides which codes forget their spot; a membership change
        // no longer implies it, because leaving a container to open canvas must
        // leave the code exactly where it was dropped
        for (const code of d.tidy ?? []) delete positions[code];
        set({
          codeAreas: areas,
          codeClusters: clusters,
          codeGroups: groups,
          mapPositions: { ...s.mapPositions, [stage]: positions },
          mapIslandPos: { ...s.mapIslandPos, [stage]: { ...s.mapIslandPos[stage], ...(d.islands ?? {}) } },
        });
      },
      reconcileDrop: (code, pos, targetCi, undoable = true) => {
        if (undoable) get().pushUndo();
        const s = get();
        const cur = s.codeClusters.findIndex((c) => c.codes.includes(code));
        let clusters = s.codeClusters;
        if (cur !== targetCi) {
          clusters = clusters.map((c, i) => {
            let codes = c.codes;
            if (i === cur) codes = codes.filter((x) => x !== code);
            if (i === targetCi && !codes.includes(code)) codes = [...codes, code];
            return codes === c.codes ? c : { ...c, codes };
          })
          .filter((c) => c.codes.length >= 2)
          // membership changed here, so re-derive — but only where it had to:
          // a survivor still in its cluster keeps the direction it was given
          // (an evicted survivor is no longer a member and falls back)
          .map((c) => ({ ...c, survivor: bestSurvivor(get(), c.codes, c.survivor) }));
        }
        set({ codeClusters: clusters,
          mapPositions: { ...s.mapPositions, reconcile: { ...s.mapPositions.reconcile, [code]: pos } } });
      },
      // Adjusting the layout is a layout EDIT, not a view mode: it writes the
      // nudged positions like a hand-drag would, so it persists, exports, and
      // comes back with one undo — unlike the old view-only spread, which
      // vanished on reload and could not be reasoned about.
      applyMapLayout: (chips, islands, moved, stage) => {
        const s = get();
        // `moved` counts what actually shifted; the maps carry EVERY top-level
        // position so the packer cannot refill the gaps that were just opened
        if (!moved) { announce("Nothing was overlapping at this zoom"); return; }
        get().pushUndo();
        set({
          mapPositions: { ...s.mapPositions, [stage]: { ...s.mapPositions[stage], ...chips } },
          mapIslandPos: { ...s.mapIslandPos, [stage]: { ...s.mapIslandPos[stage], ...islands } },
        });
        announce(`Adjusted ${moved} position${moved === 1 ? "" : "s"} so nothing overlaps at this zoom`);
      },
      applyCluster: (ci) => {
        const s0 = get();
        const c = s0.codeClusters[ci];
        if (!c || c.codes.length < 2) return;
        get().pushUndo();
        // the proposal leaves the plan, then the merges + rename apply through
        // the same integrity path mergeCode/renameCode use — but silently, so
        // the whole cluster is ONE history entry
        set({ codeClusters: s0.codeClusters.filter((_, i) => i !== ci) });
        // counted before the merges run, or there is nothing left to count
        let moved = c.codes.filter((m) => m !== c.survivor).reduce((n, m) => n + countCode(s0, m), 0);
        for (const m of c.codes) if (m !== c.survivor) mergeInto(get, set, m, c.survivor);
        // the ledger row names the code that actually survived: a typed name
        // that norm-collides with an existing code MERGES into it, and the row
        // must not name an alias nobody can open
        let kept = c.survivor;
        const folded = c.codes.filter((m) => m !== c.survivor);
        if (c.newName && c.newName !== c.survivor) {
          const s1 = get();
          const existing = Object.keys(s1.codebook).find((k) => norm(k) === norm(c.newName!) && k !== c.survivor);
          if (existing) {
            // the survivor's own name folds away too — the row records it, or
            // its verdicts, provenance, and history stop following the merge
            mergeInto(get, set, c.survivor, existing); kept = existing;
            folded.push(c.survivor);
            moved += countCode(s0, c.survivor);
          }
          else { renameInto(get, set, c.survivor, c.newName!); kept = c.newName!; }
        }
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
        // one row for the capsule, not one per member merge: what the
        // researcher decided was "these are one code", once
        get().logDecision({
          kind: "merge",
          codes: [kept, ...folded],
          source: c.source ?? "you",
          ...(c.model ? { model: c.model } : {}),
          why: c.rationale || `Merged ${c.codes.length} codes into “${kept}”`,
          moved, now: countCode(get(), kept),
        });
        announce(`Merged ${c.codes.length} codes into ${kept}`);
      },
      // A rejected proposal is evidence: "the model suggested 41 merges and the
      // researcher took 34" is only sayable if the sevens are written down too.
      dismissCluster: (ci) => {
        const c = get().codeClusters[ci];
        if (!c) return;
        get().pushUndo();
        set({ codeClusters: get().codeClusters.filter((_, i) => i !== ci) });
        get().logDecision({
          kind: "dismiss",
          // the survivor's REAL name, not a newName typed into the halo: a
          // dismiss renamed nothing, and the wording sweep's refusedPairs()
          // matches this row against actual code names — a typed name here
          // would let the sweep re-nag a pair the researcher just turned down
          codes: [c.survivor, ...c.codes.filter((m) => m !== c.survivor)],
          source: c.source ?? "you",
          ...(c.model ? { model: c.model } : {}),
          why: c.rationale || "No reason recorded",
        });
      },
      setCodeClusters: (clusters) => { get().pushUndo(); set({ codeClusters: stampCids(clusters)
        // one policy for every cluster entering the store: a survivor that is
        // still a member holds (renaming a halo or storing a glimpse must not
        // silently flip a merge's direction), and anything else falls back to
        // the best-evidenced member
        .filter((c) => c.codes.length >= 2)
        .map((c) => ({ ...c, survivor: bestSurvivor(get(), c.codes, c.survivor) })) }); },
      setLastPid: (pid) => set({ lastPid: pid }),
      // Newest first: the list is a record of what you asked, read most-recent
      // down. Not undoable — an answer costs an API call, and Ctrl+Z after some
      // unrelated edit must never be able to spend it again.
      addAnswer: (a) => {
        const aid = get().nextAid;
        set({ answers: [{ ...a, aid, at: new Date().toISOString() }, ...get().answers], nextAid: aid + 1 });
      },
      deleteAnswer: (aid) => set({ answers: get().answers.filter((x) => x.aid !== aid) }),
      // One row per CITATION, so the file joins against coded-segments.csv on
      // segment_ref — an answer you can't trace back to the excerpts is not
      // something to put in a methods section.
      exportAnswers: () => {
        const rows: Record<string, string>[] = [];
        for (const a of [...get().answers].reverse()) {
          // the scope goes out in full, in its own columns: a count of codes told
          // a later reader nothing about WHICH material the answer covered, and a
          // space-joined list is ambiguous for names that contain spaces
          const meta = {
            asked_at: a.at, question: a.question, model: a.model,
            scope_transcripts: a.scope.pids.join("; "),
            scope_codes: a.scope.excerpts ? a.scope.codes.join("; ") : "",
            scope_material: [a.scope.excerpts && "excerpts", a.scope.events && "events"].filter(Boolean).join("; "),
          };
          const add = (kind: string, text: string, ref: string) =>
            rows.push({ ...meta, kind, point: text, ref });
          for (const p of a.points) for (const r of p.refs) add("point", p.text, r);
          for (const u of a.unsupported) add("unsupported", u, "");
          // an answer that produced nothing is still a question that was asked
          if (!a.points.length && !a.unsupported.length) add("empty", "", "");
        }
        return toCSV(rows, ["asked_at", "question", "kind", "point", "ref",
          "scope_transcripts", "scope_codes", "scope_material", "model"]);
      },
      // a colour chosen by hand is LOCKED: a later recolour pass can be asked to
      // keep these and colour the generated ones around them
      setColor: (code, color) => set({ codebook: { ...get().codebook, [code]: { ...get().codebook[code], color, colorLock: true } }, redoStack: [] }),

      // Recolour the whole codebook so that no two codes appearing on the same
      // line share a colour (codeColors.ts does the graph colouring). Undoable —
      // it rewrites every code's colour, which is exactly the kind of sweeping
      // change Ctrl+Z exists for. Returns how many colours actually moved.
      recolorCodes: (keepManual) => {
        const s = get();
        const codes = Object.keys(s.codebook);
        if (!codes.length) return 0;
        s.pushUndo();
        const locked = keepManual
          ? Object.fromEntries(codes.filter((c) => s.codebook[c].colorLock).map((c) => [c, s.codebook[c].color]))
          : {};
        const plan = recolorPlan(codes, conflictGraph(s.segments), locked);
        const cb = { ...s.codebook };
        let changed = 0;
        for (const c of codes) {
          const color = plan[c] ?? cb[c].color;
          if (color.toLowerCase() !== cb[c].color.toLowerCase()) changed++;
          // recolouring everything discards the hand-picked colours, so the locks
          // they stood for go with them
          cb[c] = keepManual ? { ...cb[c], color } : { ...cb[c], color, colorLock: false };
        }
        set({ codebook: cb });
        return changed;
      },
      // Undoable like every other codebook edit (rename/merge/delete/colour):
      // applying an AI draft OVERWRITES whatever the researcher had written, and
      // that has to be recoverable. No-ops don't push — an undo entry that
      // restores identical text just eats a slot on the stack.
      setDef: (code, def, ai) => {
        const cur = get().codebook[code];
        if (!cur || (cur.def === def && !!cur.defAi === (!!def && ai === true))) return;
        get().pushUndo();
        set({
          codebook: { ...get().codebook, [code]: { ...cur, def, defAi: !!def && ai === true } },
        });
      },
      // A whole AI run's definitions written as ONE undoable step — twelve
      // setDef calls would cost twelve Ctrl+Z presses to walk back a single
      // action the researcher took once. Returns how many entries changed.
      applyDrafts: (drafts) => {
        const cb = get().codebook;
        const next = { ...cb };
        const changed: string[] = [];
        for (const d of drafts) {
          const cur = next[d.code];
          const def = d.def.trim();
          if (!cur || !def) continue;
          // A draft that comes back identical to what is already stored is not
          // authorship by anyone: keep the provenance it had, or a definition
          // the researcher wrote gets relabelled as the model's work (the model
          // is fed the current definition and told to refine it, so an echo is
          // routine).
          const defAi = def === (cur.def ?? "").trim() ? !!cur.defAi : true;
          if (cur.def === def && !!cur.defAi === defAi) continue;
          next[d.code] = { ...cur, def, defAi };
          changed.push(d.code);
        }
        if (!changed.length) return [];
        get().pushUndo();
        set({ codebook: next });
        return changed;
      },
      renameCode: (code, newName, why, source, model, undoable = true) => {
        const name = newName.trim();
        if (!name || name === code) return;
        const s = get();
        const existing = Object.keys(s.codebook).find((c) => norm(c) === norm(name) && c !== code);
        // rename into existing -> merge, and the ledger row says merge, because
        // that is what happened to the data
        if (existing) { get().mergeCode(code, existing, why, source, model); return; }
        if (undoable) get().pushUndo();
        renameInto(get, set, code, name);
        set({ hotbarCache: hotbarCodes(get()) });
        get().logDecision({ kind: "rename", codes: [name, code], source: source ?? "you",
          why: why || `Renamed from “${code}”`, ...(model ? { model } : {}),
          now: countCode(get(), name) });
      },
      // One coherent first letter across the whole codebook (AI proposals tend
      // to arrive Capitalized while hand-typed codes are often lowercase).
      // First letter ONLY — the rest of a name is the researcher's wording.
      // One history entry for the whole sweep; pure case changes can't collide
      // (norm-equal names never coexist in the codebook), but guard anyway.
      // returns what it announces, so the Settings row can SHOW the outcome —
      // the sweep's visible effect is behind the modal, and a button whose
      // only answer is a screen-reader line reads as dead
      normalizeCodeCase: (style) => {
        const s = get();
        const tf = (n: string) =>
          (style === "lower" ? n.charAt(0).toLowerCase() : n.charAt(0).toUpperCase()) + n.slice(1);
        const ren = new Map<string, string>();
        for (const k of Object.keys(s.codebook)) {
          const next = tf(k);
          if (next !== k && !(next in s.codebook)) ren.set(k, next);
        }
        if (!ren.size) {
          const msg = "Code names already match that style";
          announce(msg); return msg;
        }
        get().pushUndo();
        const r = (n: string) => ren.get(n) ?? n;
        const cb: State["codebook"] = {};
        for (const k of Object.keys(s.codebook)) cb[r(k)] = s.codebook[k];
        set({
          codebook: cb,
          segments: s.segments.map((x) => ren.has(x.code) ? { ...x, code: r(x.code) } : x),
          hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.map(r) },
          codeGroups: s.codeGroups.map((g) => ({ ...g, codes: g.codes.map(r) })),
          codeAreas: s.codeAreas.map((g) => ({ ...g, codes: g.codes.map(r) })),
          codePlan: s.codePlan.map((a) => ({ ...a, code: r(a.code), ...(a.into ? { into: r(a.into) } : {}) })),
          codeClusters: s.codeClusters.map((c) => ({ ...c, survivor: r(c.survivor), codes: c.codes.map(r),
            // same members under new spelling: the glimpse is NOT stale
            ...(c.descCodes ? { descCodes: c.descCodes.map(r) } : {}),
            ...(c.againstCodes ? { againstCodes: c.againstCodes.map(r) } : {}) })),
          // a case sweep must not cost the researcher their map layout
          mapPositions: mapLayouts(s.mapPositions,
            (rec) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [r(k), v]))),
        });
        set({ hotbarCache: hotbarCodes(get()) });
        const msg = `${ren.size} code name${ren.size === 1 ? "" : "s"} now start ${style === "lower" ? "lowercase" : "with a capital"}`;
        announce(msg);
        return msg;
      },
      deleteCode: (code, why) => {
        const s = get();
        if (!s.codebook[code]) return;
        get().pushUndo();
        const lost = s.segments.filter((x) => norm(x.code) === norm(code)).length;
        const cb = { ...s.codebook }; delete cb[code];
        set({
          codebook: cb,
          segments: s.segments.filter((x) => norm(x.code) !== norm(code)), // A: drop its segments too
          hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.filter((c) => c !== code) },
          codeGroups: s.codeGroups.map((g) => ({ ...g, codes: g.codes.filter((c) => c !== code) }))
            .filter((g) => g.codes.length > 0),
          codeAreas: s.codeAreas.map((g) => ({ ...g, codes: g.codes.filter((c) => c !== code) }))
            .filter((g) => g.codes.length > 0),
          codePlan: s.codePlan.filter((a) => a.code !== code && a.into !== code),
          // a deleted member leaves its cluster; a deleted survivor (or a
          // cluster thinned below 2) drops the whole proposal
          codeClusters: s.codeClusters
            .map((c) => ({ ...c, codes: c.codes.filter((x) => x !== code) }))
            .filter((c) => c.survivor !== code && c.codes.length >= 2),
          mapPositions: mapLayouts(s.mapPositions, (rec) => dropKey(rec, code)),
        });
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
        get().logDecision({ kind: "delete", codes: [code], source: "you",
          why: why || `Deleted the code and its ${lost} coding${lost === 1 ? "" : "s"}`, moved: lost });
      },
      mergeCode: (from, into, why, source, model) => {
        if (norm(from) === norm(into)) return;
        get().pushUndo();
        const moved = countCode(get(), from);
        // segment dedup inside includes proposedBy + status: two coders at the
        // same span, or an accepted vs a candidate, are distinct data — not
        // duplicates the merge should collapse (matches addSegment's dedup).
        // The definition carries over when the survivor has none.
        mergeInto(get, set, from, into);
        set({ ...pruneGrounds(get()), hotbarCache: hotbarCodes(get()) });
        get().logDecision({ kind: "merge", codes: [into, from], source: source ?? "you",
          why: why || `Merged “${from}” into “${into}”`, ...(model ? { model } : {}),
          moved, now: countCode(get(), into) });
      },
      // Parking never touches segments — that is the whole point of it existing
      // beside rejectCode. hotbarCache is rebuilt because a parked code must
      // stop being offered by the digit keys.
      setParked: (code, parked, why) => {
        const s = get();
        const cur = s.codebook[code];
        if (!cur || !!cur.parked === parked) return;
        get().pushUndo();
        set({ codebook: { ...s.codebook, [code]: { ...cur, parked: parked || undefined } } });
        set({ hotbarCache: hotbarCodes(get()) });
        get().logDecision({ kind: parked ? "park" : "unpark", codes: [code], source: "you",
          now: countCode(get(), code),
          why: why || (parked
            ? "Set aside from the working codebook; its excerpts are untouched"
            : "Brought back into the working codebook") });
        announce(parked ? `${code} set aside` : `${code} back in the codebook`);
      },
      // No pushUndo and no state: the ledger row IS the outcome. Reading a
      // code and deciding it stands is a decision worth recording — it is what
      // makes a second pass through the tail skip it — but there is nothing to
      // reverse, so undo leaves these alone (see INERT_DECISIONS).
      noteVerdict: (code, why) => {
        if (!get().codebook[code]) return;
        get().logDecision({ kind: "keep", codes: [code], source: "you",
          why: why || "Read its excerpts; the code stands as it is" });
        announce(`${code} kept`);
      },
      // The sentence that separates two codes is the definition of each, so it
      // lands as ONE act: two setDefs would be two undo steps with a state in
      // between where one code is defined and the other is not, which is not a
      // state the researcher ever chose.
      defineBoth: (a, b, def, source, model) => {
        const s = get();
        const text = def.trim();
        if (!text || !s.codebook[a] || !s.codebook[b] || a === b) return;
        get().pushUndo();
        set({ codebook: { ...s.codebook,
          [a]: { ...s.codebook[a], def: text, defAi: false },
          [b]: { ...s.codebook[b], def: text, defAi: false } } });
        // NOT "keep": this row changed state (two definitions), so undo must
        // be able to strike it — keep is inert and restore() would skip it.
        // source/model: keeping apart an AI-proposed pair answers the AI's
        // question, with the same provenance merging it would have carried
        get().logDecision({ kind: "define", codes: [a, b], source: source ?? "you", why: text,
          ...(model ? { model } : {}) });
        announce(`${a} and ${b} kept apart, and that sentence is now the definition of both`);
      },
      // The counterpart to noteVerdict. These rows are invisible to undo by
      // design, so taking one back is its own act: the row stays, marked, and
      // the code goes back into whatever queue was skipping it.
      retractVerdict: (at) => {
        const d = get().ledger[at];
        if (!d || d.undone || !INERT_DECISIONS.has(d.kind)) return;
        set({ ledger: get().ledger.map((x, i) => (i === at ? { ...x, undone: true } : x)) });
        announce(`Took back: ${d.codes[0] ?? "that decision"}`);
      },
      togglePin: (code) => {
        const p = get().hotbar.pinned;
        const pinned = p.includes(code) ? p.filter((c) => c !== code) : [...p, code];
        // hotbar is snapshotted, so a stale redo would drop the pin again
        set({ hotbar: { ...get().hotbar, pinned }, redoStack: [] });
        if (get().hotbar.mode === "pinned") set({ hotbarCache: hotbarCodes(get()) });
      },
      refreshHotbar: () => set({ hotbarCache: hotbarCodes(get()) }),

      pushUndo: () => {
        const s = get();
        const stack = [...s.undoStack, snapshot(s)];
        if (stack.length > UNDO_CAP) stack.shift();
        // clears the selection gesture too: any real edit ends it, so the NEXT click is
        // its own undo step rather than being swallowed as "the same gesture"
        set({ undoStack: stack, redoStack: [], selRun: false }); // new action invalidates redo
      },
      // Selection changes are undoable, but they must not DROWN the real edits: a drag
      // fires selectLine on every mousemove, and holding an arrow key on key-repeat used to
      // push an entry per press -- enough to evict every actual coding edit from the
      // 80-entry stack in about a second. So a RUN of consecutive selection-only changes
      // collapses into the single entry taken before the run; the next real edit (or a
      // mouseup) ends the run. Undo steps back over a whole drag, or a whole burst of
      // arrowing, in one go -- and your coding history survives.
      //
      // (This used to key off a gesture NAME, with the keyboard passing
      // `key:${undoStack.length}` to be unique per press. The stack is capped at 80, so once
      // full that number stops changing, every press produced the same name, and the
      // coalescer swallowed them all: arrow-key selection silently stopped being undoable.
      // A boolean cannot have that bug.)
      pushSelUndo: () => {
        const s = get();
        if (s.selRun) {
          // still inside the run: no new entry, but this IS a new action, so a stale redo
          // branch must not survive it (pushUndo would normally do this)
          if (s.redoStack.length) set({ redoStack: [] });
          return;
        }
        s.pushUndo();           // clears selRun...
        set({ selRun: true });  // ...so claim it after
      },
      endSelGesture: () => set({ selRun: false }),
      // Two entry kinds on one stack: full snapshots (coding edits) and targeted
      // line entries (text edits). The opposite stack gets the SAME kind, capturing
      // the same slice of state, so undo/redo round-trips whichever kind it meets.
      undo: () => {
        const s = get();
        // the edge of the history is a real answer, not a no-op: say so, or a
        // silent nothing reads as "the undo worked and changed nothing"
        if (!s.undoStack.length) { earcon.nothing(); announce("Nothing left to undo"); return; }
        const o = s.undoStack[s.undoStack.length - 1];
        const back = inverse(s, o);
        set({ redoStack: [...s.redoStack, back], undoStack: s.undoStack.slice(0, -1) });
        applyEntry(get, set, o);
        earcon.undo();
        announce("Undone");
      },
      redo: () => {
        const s = get();
        if (!s.redoStack.length) { earcon.nothing(); announce("Nothing left to redo"); return; }
        const o = s.redoStack[s.redoStack.length - 1];
        const back = inverse(s, o);
        set({ undoStack: [...s.undoStack, back], redoStack: s.redoStack.slice(0, -1) });
        applyEntry(get, set, o);
        earcon.redo();
        announce("Redone");
      },

      setFontSize: (n) => set({ ui: { ...get().ui, fontSize: n } }),
      setSidebarFontSize: (n) => set({ ui: { ...get().ui, sidebarFontSize: n } }),
      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
      // Sign the unsigned work as the current coder. Relabels every "(default)" (and any
      // legacy blank) segment to the committed name — BLANKET, by design: with no
      // provenance flag we can't tell your own default rows from imported ones, and the
      // user owns that call (they're nudged at export before it ships). Call on COMMIT
      // (blur/Enter/save), never per keystroke, or "jo" typed one letter at a time stamps
      // everything "j" and leaves nothing to claim. Dedup after: relabeling can land two
      // rows on the same pid+span+code+coder (e.g. a "(default)" onto an existing name).
      claimUnattributed: () => {
        const by = get().ui.coderName.trim();
        if (!by || by === "(default)") return;
        // relabel + dedup DELETES rows, so it goes on the undo stack like
        // resolveImportSign's identical pass (pushUndo also clears redo, which
        // would otherwise restore "(default)" over the name you just claimed)
        get().pushUndo();
        const seen = new Set<string>();
        const segments = get().segments
          .map((s) => (s.proposedBy.trim() && s.proposedBy !== "(default)" ? s : { ...s, proposedBy: by }))
          .filter((s) => {
            const k = `${s.pid}|${s.start}|${s.end}|${norm(s.code)}|${s.proposedBy}`;
            return seen.has(k) ? false : (seen.add(k), true);
          });
        set({ segments });
        set(pruneGrounds(get())); // the dedup above deletes rows
      },
      toggleTheme: () => set({ ui: { ...get().ui, dark: !get().ui.dark } }),
      setHotbarMode: (mode) => { set({ hotbar: { ...get().hotbar, mode }, redoStack: [] }); set({ hotbarCache: hotbarCodes(get()) }); },
      setZen: (v) => set({ ui: { ...get().ui, zen: v } }),

      exportCSV: () => {
        const s = get();
        // `src` rides along so the dominance rule weighs the spoken text in both
        // runs — otherwise excerpt and excerpt_source could quote two different
        // speakers on the same row, which is a mislabel nothing would catch.
        const rowLines = (seg: Segment) => linesOf(s.transcripts, s.ui.lang, seg.pid)
          .filter((l) => l.id >= seg.start && l.id <= seg.end)
          .map((l) => ({ text: l.text, speaker: l.speaker, src: l.src }));
        const excerptFor = (seg: Segment) => excerptOf(rowLines(seg)).excerpt;
        const sourceFor = (seg: Segment) =>
          excerptOf(rowLines(seg).map((l) => ({ ...l, text: l.src ?? l.text }))).excerpt;
        // Only a study actually being read in a translation earns the second
        // column: adding an empty one to every other export would tell a reader
        // that a source text was looked for and not found.
        const transcribed = s.ui.lang !== "source"
          && Object.values(s.transcripts).some((t) => t.lines.some((l) => l.en?.trim()));
        const fields = ["segment_ref", "pid", "excerpt",
          ...(transcribed ? ["excerpt_source"] : []),
          "code", "proposed_by", "status", "notes"];
        const rows = s.segments.map((seg) => ({
          segment_ref: formatSegRef(seg.pid, seg.start, seg.end),
          pid: seg.pid,
          // the excerpt is quoted in the language the study is being read in,
          // and `excerpt_source` below carries what was actually said — an
          // export is the evidence trail, so it may never hold only a
          // translation (the column is omitted entirely when there is none)
          excerpt: excerptFor(seg),
          excerpt_source: transcribed ? sourceFor(seg) : "",
          // never-empty invariant enforced at the write edge, whatever the source
          code: seg.code, proposed_by: seg.proposedBy.trim() || "(default)", status: seg.status, notes: seg.notes,
        })).concat(s.extSegRows.map((r) => ({ ...r, proposed_by: (r.proposed_by || "").trim() || "(default)" })) as never[]);
        return toCSV(rows, fields);
      },
    }),
    {
      name: "coding-app-state",
      // Debounced IndexedDB (see persistence.ts for why localStorage lost the
      // job). A refused write still surfaces: persistence.ts reports save
      // health and the callback below drives saveFailed / the App banner.
      storage: projectStorage as PersistStorage<Partial<State>>,
      partialize: (s) => ({
        transcripts: s.transcripts, segments: s.segments, codebook: s.codebook,
        extSegRows: s.extSegRows, tabs: s.tabs, pinnedTabs: s.pinnedTabs, active: s.active,
        hotbar: s.hotbar, video: s.video, ui: { ...currentUi(s.ui), zen: false }, // zen is per-session view state
        ai: s.ai, aiFlags: s.aiFlags, aiGrounds: s.aiGrounds, aiLog: s.aiLog, ledger: s.ledger, // NB: the API key is not in the store (ai/key.ts)
        markers: s.markers, summaries: s.summaries, projectNotes: s.projectNotes, projectName: s.projectName, codeGroups: s.codeGroups, codeAreas: s.codeAreas, codeAreasFp: s.codeAreasFp, stretches: s.stretches, studyBrief: s.studyBrief, codePlan: s.codePlan, codeClusters: s.codeClusters, answers: s.answers,
      }),
      onRehydrateStorage: () => (s) => {
        // writes are dropped until hydration lands (a boot-time set() must not
        // clobber the saved project) — open the gate even on an empty/failed
        // hydration, or a fresh workspace would never save at all
        markHydrated();
        if (!s) return;
        s.nextSid = s.segments.reduce((m, x) => Math.max(m, x.sid), 0) + 1; // reduce, not spread: spreading throws past ~65k elements
        // Ascending line ids are an assumption everything downstream makes (see
        // rowsToLines). A workspace saved before that sort existed can hold an
        // out-of-order transcript, and re-import alignment would then compare two
        // differently-ordered line lists and drop or misplace coding.
        for (const t of Object.values(s.transcripts))
          if (t.lines.some((l, i) => i > 0 && l.id < t.lines[i - 1].id))
            t.lines = [...t.lines].sort((a, b) => a.id - b.id);
        s.markers ??= [];
        s.nextMid = s.markers.reduce((m, x) => Math.max(m, x.mid), 0) + 1;
        s.hotbarCache = hotbarCodes(s as State);
        // fields added after a persisted state was written (persist merges shallowly)
        s.ai.lenses ??= ["transcription"];
        s.pinnedTabs ??= [];
        s.aiGrounds ??= {};
        s.ledger ??= [];
        s.codeClusters = stampCids(s.codeClusters ?? [], { fromFile: true });
        s.ui.assistPanel ??= "observations";
        s.studyBrief ??= {}; // added with F7; a workspace saved before it has none
        s.ui.stretchView ??= "show";
        s.ui.tailLimit ??= 1;
        s.ui.stretchBand ??= "sm";
        s.ui.stretchLabel ??= "md";
        s.stretches ??= [];
        s.ui.eventSort ??= "type";
        // normalize, not just default: a corrupt persisted value would make the
        // sidebar chip index SORTS with -1 and crash the whole sidebar
        if (!SORTS.some((x) => x.id === s.ui.codeSort)) s.ui.codeSort = "name";
        s.ui.markerColors ??= {};
        s.ui.eventListHeight = clampEventHeight(s.ui.eventListHeight ?? 200);
        s.summaries ??= {};
        s.projectNotes ??= "";
        s.projectName ??= "";
        s.codeGroups ??= [];
        s.codeAreas ??= [];
        s.codeAreasFp ??= "";
        s.codePlan ??= [];
        s.codeClusters ??= [];
        // same pairwise->cluster migration for a persisted local session
        if (s.codePlan.some((a) => a.action === "merge")) {
          s.codeClusters = [...s.codeClusters,
            ...s.codePlan.filter((a) => a.action === "merge" && a.into).map((a) => ({
              survivor: a.into!, codes: [a.code, a.into!],
              ...(a.newName ? { newName: a.newName } : {}), rationale: a.rationale,
            }))];
          s.codePlan = s.codePlan.filter((a) => a.action !== "merge");
        }
        s.codeClusters = normalizeClusters(s as State, s.codeClusters);
        s.answers ??= [];
        s.nextAid = s.answers.reduce((m, x) => Math.max(m, x.aid), 0) + 1;
        s.ui.summaryLayout ??= "side";
        s.ui.mapMinimap ??= "bottom-right";
        s.ui.mapViewport ??= null;
        s.ui.mapSounds ??= true;
        s.ui.stretchColors ??= {};
        s.ui.soundVolume ??= 1;
        s.ui.mapRing ??= "md";
        s.ui.summarySplit = clampSummarySplit(s.ui.summarySplit ?? 0.5);
        s.ui.groundBold ??= true;
        s.ui.groundWash ??= true;
        s.ui.groundUnderline ??= false;
        s.ui.showNotices ??= true;
        s.ui.hiddenLenses ??= [];
        s.ui.lanePattern ??= false;
        s.ui.scrollSpeed ??= 1;
        s.ui.loopEdit ??= true;
        s.ui.loopSpeed ??= 0.75;
        // bounds moved (44–160 → 64–256): pull an old persisted width into range
        s.ui.minimapWidth = clampMinimapWidth(s.ui.minimapWidth ?? 66);
        // was `string | null` (global) before it went per-transcript — an old
        // scalar value can't be mapped to a pid, so it resets to everyone
        if (typeof s.ui.speakerFocus !== "object" || s.ui.speakerFocus === null) s.ui.speakerFocus = {};
        // dim/collapse were one exclusive mode before they became combinable
        // toggles; the old "collapse" mode dimmed too, so it maps to both on
        const legacyMode = (s.ui as { speakerFocusMode?: string }).speakerFocusMode;
        s.ui.focusDim ??= true;
        s.ui.focusCollapse ??= legacyMode === "collapse";
        s.ui.speakerColors ??= {};
        s.ui.speakerWeight ??= {};
        s.ui.fontFamily ??= "system";
        s.ui.coderName ??= "";
        s.ui.mergeGapOn ??= false;
        s.ui.mergeGap ??= 3;
        s.ui.lang = asLang(s.ui.lang);
        s.ui = currentUi(s.ui);
        // never-empty invariant: rows written empty by an earlier build become "(default)"
        s.segments = s.segments.map((x) => (x.proposedBy?.trim() ? x : { ...x, proposedBy: "(default)" }));
      },
    }
  )
);

// Save health → the App's autosave-failing banner. Deferred a microtask so the
// flag's own persist attempt can't recurse into the write path mid-flush.
setOnSaveResult((ok) => {
  const failed = !ok;
  if (useStore.getState().saveFailed === failed) return;
  queueMicrotask(() => useStore.setState({ saveFailed: failed }));
});

// ── import helpers (module-scope so they can call ensureCode/addSegment) ──
type Get = () => State;
type Set_ = (partial: Partial<State>) => void;

function ensureCode(get: Get, set: Set_, code: string): string {
  const cb = get().codebook;
  const existing = Object.keys(cb).find((c) => norm(c) === norm(code));
  if (existing) return existing;
  // least-used palette colour, NOT a counter over the codebook size: the counter
  // handed out a colour another code already held as soon as one was deleted
  // codebook is snapshotted: without clearing redo, a code created after an undo
  // vanishes again on the next Ctrl+Y
  set({ redoStack: [], codebook: { ...cb, [code]: {
    color: pickNewColor(Object.values(cb).map((c) => c.color)), def: "", status: "candidate",
  } } });
  // a newly created code should appear in the hotbar immediately (no manual refresh)
  set({ hotbarCache: hotbarCodes(get()) });
  return code;
}

// Import gate for transcript CSVs: every row needs a unique, numeric line_id.
// Returns a message naming the offending rows (header = row 1), or null when clean.
function badLineIds(rows: Record<string, string>[]): string | null {
  const bad: number[] = [], dup: number[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const id = (r.line_id || "").trim();
    // safe-integer too, not just digits: past 2^53 distinct ids collapse onto
    // the same number once `+r.line_id` rounds them, silently merging lines
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(+id)) bad.push(i + 2);
    else if (seen.has(id)) dup.push(i + 2);
    else seen.add(id);
  });
  const list = (ns: number[]) => ns.slice(0, 5).join(", ") + (ns.length > 5 ? ", …" : "");
  if (bad.length) return `has a blank, non-numeric or out-of-range line_id on row${bad.length > 1 ? "s" : ""} ${list(bad)}`;
  if (dup.length) return `has a duplicate line_id on row${dup.length > 1 ? "s" : ""} ${list(dup)}`;
  return null;
}

function rowsToLines(rows: Record<string, string>[]): Line[] {
  return rows
    .map((r) => {
      const l: Line = { id: +r.line_id, ts: r.timestamp || "", speaker: (r.speaker || "P").trim(), text: r.text || "" };
      if (r.end_timestamp?.trim()) l.end = r.end_timestamp.trim();
      // a translation column, if the file has one. Trimmed-empty is NOT a
      // translation: it would otherwise read as "this line translates to
      // nothing" and blank the line under an English reading.
      if (r.text_en?.trim()) l.en = r.text_en;
      // our own export writes `original` for a corrected line; without reading it
      // back, a round-trip through CSV laundered the correction into the source
      // text and lost the ✱ diff
      if (r.original?.trim() && r.original !== l.text) l.orig = r.original;
      return l;
    })
    .filter((l) => Number.isFinite(l.id))
    // Ascending ids are an assumption everything downstream makes: mergeGroups
    // walks in array order, so out-of-order rows built a group whose startId
    // exceeded its endId, and groupIdxOf's range test then matched no line at
    // all — the transcript rendered but could not be coded, with no error.
    .sort((a, b) => a.id - b.id);
}

// "interview-p3" -> "interview-p3 (2)" when the name is taken (import-as-new)
function uniquePid(s: State, pid: string): string {
  let n = 2;
  while (s.transcripts[`${pid} (${n})`]) n++;
  return `${pid} (${n})`;
}

function importTranscript(get: Get, set: Set_, pid: string, rows: Record<string, string>[]) {
  const lines = rowsToLines(rows);
  const s = get();
  const knownBefore = new Set(speakersOf(s)); // must be read BEFORE the import lands
  // REPLACING an existing transcript, not adding one. The consent modal path already
  // clears this state, but it only runs when the transcript has SEGMENTS — re-importing
  // an uncoded transcript came straight here, leaving an undo stack full of selections
  // (and a parked selection, and a scroll anchor) that point at line ids the new file may
  // not have. Coding from a restored one of those writes segments onto lines that no
  // longer exist.
  const replacing = !!s.transcripts[pid];
  if (replacing) {
    const saved = { ...s.savedSelections };
    delete saved[pid];
    forgetScroll(pid);
    set({
      undoStack: [], redoStack: [], selRun: false,
      selection: s.selection.pid === pid ? emptySel() : s.selection,
      savedSelections: saved,
    });
  }
  set({
    transcripts: { ...get().transcripts, [pid]: { lines } },
    tabs: placeTab(s, pid), // a re-import of a pinned-but-closed transcript lands back in the pinned group
    active: s.active === "browse" && !s.tabs.length ? pid : s.active,
  });
  // Guess the interviewer for speakers we've never seen before. Only for new ones, so
  // a deliberate change to someone's weight survives a re-import instead of being undone.
  const fresh = [...new Set(lines.map((l) => l.speaker.trim()).filter(Boolean))]
    .filter((sp) => !knownBefore.has(sp));
  const guessed = guessQuiet(fresh).filter((sp) => !(sp in get().ui.speakerWeight));
  if (guessed.length) {
    const w = { ...get().ui.speakerWeight };
    for (const sp of guessed) w[sp] = "quiet";
    set({ ui: { ...get().ui, speakerWeight: w } });
  }
  // Inline codes become independent contiguous runs per code, so overlaps stay legal.
  const coded: CodedLine[] = rows.map((r) => ({
    n: +r.line_id,
    codes: new Set((r.codes || "").split(";").map((c) => c.trim()).filter(Boolean)),
  })).filter((l) => Number.isFinite(l.n)).sort((a, b) => a.n - b.n);
  for (const [code, spans] of collapseRuns(coded)) {
    const canon = ensureCode(get, set, code);
    for (const [start, end] of spans) get().addSegment(pid, start, end, canon);
  }
  // segments that arrived BEFORE their transcript were parked in extSegRows as
  // passthrough; now that the transcript exists they become real (visible, editable)
  // segments — otherwise export would emit both the parked row and any re-coding
  const parked = get().extSegRows.filter((x) => /^(.+?):\d/.exec(x.segment_ref || "")?.[1] === pid);
  if (parked.length) {
    set({ extSegRows: get().extSegRows.filter((x) => !parked.includes(x)) });
    importSegments(get, set, parked);
  }
}

function importCodebook(get: Get, set: Set_, rows: Record<string, string>[]) {
  rows.forEach((r) => {
    if (!r.code) return;
    const key = ensureCode(get, set, r.code);
    const cb = get().codebook;
    // Column PRESENCE decides, not truthiness: `||` meant a file that
    // deliberately blanked a definition could never clear the one in the app.
    // A file with no short_def column at all still leaves it alone.
    const def = r.short_def !== undefined ? r.short_def.trim() : cb[key].def;
    set({ codebook: { ...cb, [key]: {
      ...cb[key],
      // our own export says where the definition came from; a hand-made or
      // older file has no column, and then an unchanged definition keeps the
      // provenance it had while a new one counts as the file author's
      defAi: !def ? false
        : r.def_source ? r.def_source.trim().toLowerCase() === "ai"
        : def === cb[key].def ? cb[key].defAi : false,
      def,
      status: r.status || cb[key].status,
      // colors come from our own codebook.csv export; older files have no column
      color: /^#[0-9a-f]{6}$/i.test(r.color || "") ? r.color : cb[key].color,
      // absent column leaves the flag alone — a hand-made file must not
      // silently bring back everything you set aside
      parked: r.set_aside === undefined ? cb[key].parked
        : /^(yes|true|1)$/i.test(r.set_aside.trim()) || undefined,
    } } });
  });
}

function importSegments(get: Get, set: Set_, rows: Record<string, string>[]) {
  // One pass over the rows, ONE set() at the end. The per-row version did an
  // O(segments) dedup .find plus one-to-three store writes — each a persist —
  // per row: a few thousand imported rows froze the tab for the better part of
  // a minute. The Maps below carry the same dedup rules in O(1) per row.
  const s0 = get();
  const segments = [...s0.segments];
  const codebook = { ...s0.codebook };
  const extSegRows = [...s0.extSegRows];
  const pendingSegUpdates = [...s0.pendingSegUpdates];
  let nextSid = s0.nextSid;
  let cbChanged = false;

  // dedup is per coder: two coders holding the same span+code is agreement data
  // NUL-joined, not "|": a code or coder name CONTAINING "|" must not make two
  // distinct rows collide into one key
  const segKey = (pid: string, start: number, end: number, code: string, by: string) =>
    [pid, start, end, norm(code), by].join("\u0000");
  // first-wins, like the old .find(): with pre-existing duplicate logical
  // segments, a consent row must target the same (earliest) sid it used to
  const bySeg = new Map<string, Segment>();
  for (const x of segments) {
    const k = segKey(x.pid, x.start, x.end, x.code, x.proposedBy);
    if (!bySeg.has(k)) bySeg.set(k, x);
  }
  // parked passthrough rows dedup too, or re-importing the same file grows
  // them without bound and export re-emits the duplicates
  const extKey = (x: Record<string, string>) =>
    `${x.segment_ref}|${norm(x.code || "")}|${(x.proposed_by || "").trim()}`;
  const extSeen = new Set(extSegRows.map(extKey));
  const pendingSids = new Set(pendingSegUpdates.map((u) => u.sid));
  // first-wins, like the old Object.keys().find() — if two norm-equal keys ever
  // coexist, imports must keep canonicalizing to the same one they always did
  const byNorm = new Map<string, string>();
  for (const c of Object.keys(codebook)) if (!byNorm.has(norm(c))) byNorm.set(norm(c), c);
  const ensure = (code: string): string => {
    const hit = byNorm.get(norm(code));
    if (hit) return hit;
    codebook[code] = { color: pickNewColor(Object.values(codebook).map((c) => c.color)), def: "", status: "candidate" };
    byNorm.set(norm(code), code);
    cbChanged = true;
    return code;
  };

  for (const r of rows) {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(r.segment_ref || "");
    if (!m) continue;
    const pid = m[1], start = +m[2], end = +(m[3] || m[2]);
    // a corrupt/hand-edited ref like p1:1-999999999 would hang remapSegment on the
    // next re-import (it walks every line in the range); no real segment spans 10k
    if (end < start || end - start > 9999) continue;
    if (!s0.transcripts[pid]) {
      // parked, not imported — the transcript isn't here (yet)
      if (!extSeen.has(extKey(r))) { extSeen.add(extKey(r)); extSegRows.push(r); }
      continue;
    }
    const canon = ensure(r.code);
    // an imported row with no coder is NOT yours — mark it "(default)", never your name
    const coder = (r.proposed_by || "").trim() || "(default)";
    const status = r.status || "accepted", notes = r.notes || "";
    const existing = bySeg.get(segKey(pid, start, end, canon, coder));
    if (existing) {
      // a re-imported row that only changed status/notes must not vanish into
      // the dedup — but it would OVERWRITE in-app review work, so it's parked
      // for consent (SegUpdateModal) instead of applied silently
      if ((existing.status !== status || existing.notes !== notes) && !pendingSids.has(existing.sid)) {
        pendingSids.add(existing.sid);
        pendingSegUpdates.push({
          sid: existing.sid, ref: formatSegRef(pid, start, end), code: canon,
          from: { status: existing.status, notes: existing.notes },
          to: { status, notes },
        });
      }
    } else {
      const seg = { sid: nextSid++, pid, start, end, code: canon, notes, proposedBy: coder, status };
      segments.push(seg);
      bySeg.set(segKey(pid, start, end, canon, coder), seg);
    }
  }

  set({ segments, codebook, extSegRows, pendingSegUpdates, nextSid,
    // a new code clears redo (codebook is snapshotted — a code created after an
    // undo must not vanish on the next Ctrl+Y), same as ensureCode
    ...(cbChanged ? { redoStack: [] } : {}) });
  // new codes should appear in the hotbar immediately (no manual refresh)
  if (cbChanged) set({ hotbarCache: hotbarCodes(get()) });
}

// selector helpers
// ── speakers ────────────────────────────────────────────────────────────────────
// Speaker identity used to be a single hardcoded rule: speaker.startsWith("R") means
// "researcher, dim it". That silently mislabels a participant called Rachel, renders
// every member of a focus group (P1/P2/P3) identically, and does nothing at all if the
// interviewer is called "Interviewer". Speakers are now first-class: each gets a colour
// and can be quieted, whatever they're called.
//
// All chips are dark enough for white text (>= 4.5:1), so the label inside them stays
// legible without a per-colour contrast dance.
const SPEAKER_COLORS = ["#6d28d9", "#0f766e", "#b45309", "#b91c1c",
  "#1d4ed8", "#4d7c0f", "#a21caf", "#0369a1"];

// stable default: the same speaker gets the same colour across sessions and transcripts
export const speakerColor = (ui: Pick<Ui, "speakerColors">, speaker: string): string => {
  const key = speaker.trim();
  const own = ui.speakerColors[key];
  if (own) return own;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return SPEAKER_COLORS[(h >>> 0) % SPEAKER_COLORS.length];
};

// every speaker across every loaded transcript, in first-appearance order
export const speakersOf = (s: Pick<State, "transcripts" | "tabs">): string[] => {
  const seen: string[] = [];
  for (const pid of s.tabs) {
    for (const l of s.transcripts[pid]?.lines ?? []) {
      const sp = l.speaker.trim();
      if (sp && !seen.includes(sp)) seen.push(sp);
    }
  }
  return seen;
};

export const weightOf = (ui: Pick<Ui, "speakerWeight">, speaker: string): SpeakerWeight =>
  ui.speakerWeight[speaker.trim()] ?? "normal";

// The chip's label used to be hardcoded white, which is fine for the eight defaults
// (all >= 4.5:1) and a disaster the moment someone picks pale yellow from the colour
// picker — the speaker's name vanishes. Pick the label colour from the chip's own
// luminance so ANY colour, including a user's, stays readable.
export const inkOn = (hex: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Pure black, not a soft near-black. Against #14181c a mid-tone chip tops out at
  // ~4.19:1 with EITHER ink — below AA whichever you pick. Black lifts that worst case
  // to 4.58:1, so every colour the picker can produce has a readable label.
  // white: 1.05/(L+.05)   ·   black: (L+.05)/.05
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#000000";
};

// A GUESS at who the interviewer is, applied once when a transcript first loads and
// freely editable afterwards — a default you can correct, not a law you can't.
//
// Deliberately WHOLE-LABEL matches only. An earlier `^r\b` prefix test also caught
// "R. Singh", "R (participant)" and "Rae" — quietly dimming participants, which is the
// exact failure the old startsWith("R") rule was removed for. A bare "R", or the word
// itself, is the whole label or it isn't a match. The regex itself lives in the
// contract (excerpt.ts) so the export prefix and this guess can't drift apart.
export const guessQuiet = (speakers: string[]): string[] =>
  speakers.filter((sp) => RESEARCHER.test(sp.trim()));

// A lane bar used to say WHICH code it is by hue alone (the name was hover-only) —
// unusable at low acuity, and the 12-colour rotation contains near-neighbours.
// Pattern is a second, independent channel, shown on the lane AND on the sidebar
// swatch so the mapping is learnable. Derived from the code NAME rather than stored:
// no schema change, and two codes that happen to share a colour still get different
// patterns — the very case this fixes. Diagonal stripes are deliberately NOT in the
// set: those mean "rejected" and must stay unambiguous.
export const PATTERNS = 6;
export const patternOf = (code: string): number => {
  let h = 0x811c9dc5; // FNV-1a, as in ai/flag.ts
  const s = norm(code);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % PATTERNS;
};

export const laneAssign = (segs: Segment[]): (Segment & { lane: number })[] => {
  const sorted = [...segs].sort((a, b) => a.start - b.start || b.end - a.end);
  const laneEnd: number[] = [];
  return sorted.map((s) => {
    let lane = laneEnd.findIndex((e) => e < s.start);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = s.end;
    return { ...s, lane };
  });
};
