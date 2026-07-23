// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { parseCSV, toCSV } from "../contract/csv";
import { collapseRuns, formatSegRef, norm, type CodedLine } from "../contract/segments";
import { excerptOf, RESEARCHER } from "../contract/excerpt";
import { mergeGroups, type Group } from "../merge";
import { previewImport, remapSegment, type ImportPreview } from "../align";
import { DEFAULT_MODEL } from "../ai/openai";
import { hashLine, spanLens, type Flag } from "../ai/flag";
import { FORMAT, VERSION, parseProject, type Project } from "../project";
import { DEFAULT_ACCENT } from "../palettes";
import { forgetScroll } from "../scrollMemory";
import { announce } from "../announce";

export const COLORS = ["#e0554f", "#3b82c4", "#3fa860", "#c98a2a", "#8e6bc9", "#2fa3a3",
  "#c95c9c", "#7d8f2e", "#b0653a", "#5470d6", "#4f9e86", "#a35ac0"];

// orig = the imported text, present only while an in-app correction differs from it
export interface Line { id: number; ts: string; speaker: string; text: string; orig?: string; }
export interface Segment {
  sid: number; pid: string; start: number; end: number; code: string;
  notes: string; proposedBy: string; status: string;
}
export interface Selection { pid: string | null; anchor: number | null; head: number | null; lines: Set<number>; }
export interface Ui {
  fontSize: number; sidebarFontSize: number; dark: boolean; zen: boolean;
  sidebarWidth: number; browseLeftWidth: number;
  palettePos: "auto" | "centered";
  helpSeen: boolean;
  mergeLines: boolean; // merge partial (non-terminated) same-speaker lines into one unit
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
  smoothScroll: boolean; // animate Home/End/PageUp/PageDown and jumps instead of teleporting
  scrollSpeed: number; // wheel distance multiplier for the transcript (1 = device default)
  loopEdit: boolean; // loop the utterance's audio while its line is being edited
  loopSpeed: number; // playback rate while looping (independent of the dock's rate)
  // isolate one speaker's dialogue, PER TRANSCRIPT (focus is a lens on a study
  // file, not a global): pid -> speaker name; absent = everyone
  speakerFocus: Record<string, string>;
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
// the loop-speed stops (Settings seg + the edit bar's cycler) — one list, two UIs
export const LOOP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const UNDO_CAP = 80; // one cap for BOTH push sites (pushUndo and editLine)
// minimap width bounds — used by the Resizer clamp AND the rehydrate migration
export const clampMinimapWidth = (w: number) =>
  Number.isFinite(w) ? Math.max(64, Math.min(256, w)) : 66; // NaN slips through ?? — catch it here
export interface Search {
  open: boolean; query: string; scope: "tab" | "all";
  current: { line: number; occ: number } | null; // the emphasized occurrence
}
// A re-import of an already-coded transcript, held until the user picks what to do.
export interface PendingImport {
  pid: string;
  lines: Line[];
  rows: Record<string, string>[]; // kept for the inline `codes` column
  preview: ImportPreview;
}
export type ImportChoice = "update" | "replace" | "new" | "cancel";

// A re-imported segment row that would OVERWRITE an existing segment's status or
// notes — held for consent (the transcript re-import modal is the same idea).
export interface SegUpdate {
  sid: number; ref: string; code: string;
  from: { status: string; notes: string };
  to: { status: string; notes: string };
}

// AI settings. The API key is NOT here — the store is persisted wholesale, so the
// key lives in ai/key.ts (session-only by default). See docs in that file.
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
}

interface State {
  transcripts: Record<string, { lines: Line[] }>;
  segments: Segment[];
  codebook: Record<string, { color: string; def: string; status: string }>;
  extSegRows: Record<string, string>[];
  tabs: string[];
  active: string;
  hotbar: { mode: "auto" | "pinned"; pinned: string[] };
  hotbarCache: string[];
  video: Record<string, { name?: string; offset: number }>;
  ui: Ui;
  ai: Ai;
  aiFlags: Record<string, LineFlags>; // "pid:lineId" -> flags, valid while the hash matches
  aiLog: AiCall[];
  // transient (not persisted)
  selection: Selection;
  savedSelections: Record<string, Selection>; // each tab's parked selection, restored on return
  undoStack: string[];
  redoStack: string[];
  selRun: boolean; // top undo entry already captures the state before this run of selection-only changes
  nextSid: number;
  jump: { pid: string; line: number } | null;
  paletteOpen: boolean;
  formatOpen: boolean;
  search: Search;
  pendingImports: PendingImport[]; // re-imports awaiting a user decision
  pendingProject: Project | null;  // a loaded project awaiting the replace confirmation
  pendingSegUpdates: SegUpdate[];  // status/notes overwrites awaiting consent
  pendingImportSign: { sids: number[] } | null; // just-imported (default) rows: "whose are these?"
  pendingCoderAsk: boolean; // a transcript is loaded but the coder is still (default): "who's coding?"
  saveFailed: boolean; // localStorage write failed (quota) — autosave is NOT happening

  importFiles: (files: FileList | File[]) => Promise<void>;
  newProject: () => void;
  resolveImport: (choice: ImportChoice) => void;
  resolveSegUpdates: (apply: boolean) => void;
  resolveImportSign: (name: string | null) => void;
  resolveCoderAsk: (name: string | null) => void;
  ensureCode: (code: string) => string;
  addSegment: (pid: string, start: number, end: number, code: string,
    proposedBy?: string, status?: string, notes?: string) => void;
  applyCode: (code: string) => void;
  selectLine: (id: number, opts?: { extend?: boolean; toggle?: boolean }) => void;
  moveSelection: (dir: -1 | 1, extend: boolean) => void;
  startSelection: (id: number) => void;
  clearSelection: () => void;
  setActive: (pid: string) => void;
  closeTab: (pid: string) => void;
  jumpTo: (pid: string, line: number) => void;
  clearJump: () => void;
  scrollToLine: (line: number) => void;
  setPalette: (v: boolean) => void;
  setFormatOpen: (v: boolean) => void;
  openSearch: () => void;
  closeSearch: () => void;
  setSearch: (patch: Partial<Search>) => void;
  editLine: (pid: string, id: number, text: string) => void;
  exportEdits: () => string;
  setAi: (patch: Partial<Ai>) => void;
  addFlags: (pid: string, flags: Record<number, Flag[]>, lines: Line[], scanned: string[]) => void;
  clearFlags: (pid: string) => void;
  dismissNotice: (pid: string, id: number, lens: string, quote: string) => void;
  applyFix: (pid: string, id: number, quote: string, fix: string) => void;
  logAiCall: (call: AiCall) => void;
  exportAiLog: () => string;
  exportCodebook: () => string;
  exportTranscript: (pid: string) => string;
  exportNotices: () => string;
  exportProject: () => string;
  openProject: (p: Project) => void;
  setPendingProject: (p: Project | null) => void;
  setSegmentRange: (sid: number, start: number, end: number) => void;
  deleteSegment: (sid: number) => void;
  setStatus: (sid: number, status: string) => void;
  setNotes: (sid: number, notes: string) => void;
  setColor: (code: string, color: string) => void;
  togglePin: (code: string) => void;
  refreshHotbar: () => void;
  pushUndo: () => void;
  pushSelUndo: () => void;
  endSelGesture: () => void;
  undo: () => void;
  redo: () => void;
  renameCode: (code: string, newName: string) => void;
  deleteCode: (code: string) => void;
  mergeCode: (from: string, into: string) => void;
  setDef: (code: string, def: string) => void;
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
function groupsOf(s: State): Group[] {
  const t = s.transcripts[s.active];
  return t ? mergeGroups(t.lines, s.ui.mergeLines) : [];
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
// Set isn't JSON, so the line ids go as an array.
function snapshot(s: State): string {
  return JSON.stringify({
    segments: s.segments, codebook: s.codebook, hotbar: s.hotbar, active: s.active,
    sel: { ...s.selection, lines: [...s.selection.lines] },
  });
}
// Text edits get a TARGETED undo entry (kind:"line") instead of a full snapshot:
// the snapshot above deliberately omits transcripts/aiFlags, and 80 copies of a
// whole transcript would not be a stack, it would be a memory leak. The entry
// holds the one line (with its orig) and the line's AI-flag record, so undoing
// an applyFix brings back both the wording and the mark it consumed.
function lineEntry(s: State, pid: string, id: number): string | null {
  const line = s.transcripts[pid]?.lines.find((l) => l.id === id);
  if (!line) return null;
  return JSON.stringify({ kind: "line", pid, id, line, flags: s.aiFlags[`${pid}:${id}`] ?? null });
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
  // to the edited transcript so the undo is never a silent off-screen change
  if (get().active !== o.pid && get().tabs.includes(o.pid)) set({ active: o.pid });
}
function restore(get: () => State, set: (p: Partial<State>) => void, json: string) {
  const o = JSON.parse(json);
  const cur = get();
  const next = { ...cur, segments: o.segments, codebook: o.codebook, hotbar: o.hotbar };
  let sel: Selection = o.sel
    ? { pid: o.sel.pid, anchor: o.sel.anchor, head: o.sel.head, lines: new Set<number>(o.sel.lines) }
    : cur.selection; // a snapshot from before selections were tracked

  // The tab may have been CLOSED since the snapshot. Drop a selection that points into it:
  // applyCode trusts selection.pid and the digit hotkeys only check lines.size, so a live
  // selection on a closed tab writes segments onto a transcript that isn't on screen.
  if (sel.pid && !cur.tabs.includes(sel.pid)) sel = emptySel();
  const active = o.active && (o.active === "browse" || cur.tabs.includes(o.active))
    ? o.active : cur.active;

  // Crossing tabs here bypasses setActive(), which is what stashes the outgoing tab's
  // selection and parks the incoming one. Do its bookkeeping by hand, or the parked copy
  // goes stale and reappears next time you visit that tab.
  const saved = { ...cur.savedSelections };
  if (active !== cur.active) saved[cur.active] = cur.selection; // park what we leave
  if (active !== "browse") saved[active] = sel;                 // and what we restore, EMPTY OR NOT

  set({
    segments: o.segments, codebook: o.codebook, hotbar: o.hotbar,
    hotbarCache: hotbarCodes(next), selection: sel, active, savedSelections: saved,
    // One cache must own the scroll after a tab change, or the tab's remembered anchor
    // (restored in a rAF) races the selection-follow (synchronous) and wins -- landing you
    // nowhere near what you just undid. `jump` is that ownership token; the positioning
    // effect defers to it.
    jump: active !== cur.active && sel.pid && sel.head !== null
      ? { pid: sel.pid, line: sel.head } : cur.jump,
  });
}

function hotbarCodes(s: State): string[] {
  if (s.hotbar.mode === "pinned") return s.hotbar.pinned.slice(0, 9);
  const count: Record<string, number> = {};
  s.segments.filter((x) => x.status === "accepted").forEach((x) => { count[x.code] = (count[x.code] || 0) + 1; });
  return Object.keys(s.codebook).sort((a, b) => (count[b] || 0) - (count[a] || 0)).slice(0, 9);
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      transcripts: {}, segments: [], codebook: {}, extSegRows: [],
      tabs: [], active: "browse",
      hotbar: { mode: "auto", pinned: [] }, hotbarCache: [],
      video: {}, ui: { fontSize: 16, sidebarFontSize: 13, dark: false, zen: false, sidebarWidth: 250, browseLeftWidth: 264, palettePos: "auto", helpSeen: false, mergeLines: false, showLineNumbers: false, accent: DEFAULT_ACCENT, speakerNames: "full", fontFamily: "system", warnCorner: "right", warnSize: "sm", laneWidth: "md", minimapWidth: 66, minimapDetail: "detailed", showNotices: true, hiddenLenses: [], lanePattern: false, smoothScroll: false, scrollSpeed: 1, loopEdit: true, loopSpeed: 0.75, speakerFocus: {}, focusDim: true, focusCollapse: false,
        speakerColors: {}, speakerWeight: {}, coderName: "" },
      ai: { model: DEFAULT_MODEL, redactTerms: [], lenses: ["transcription"] }, aiFlags: {}, aiLog: [],
      selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [], selRun: false, nextSid: 1, jump: null, paletteOpen: false, formatOpen: false,
      search: { open: false, query: "", scope: "tab", current: null },
      pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false, saveFailed: false,

      // wipe the workspace, keep the person: ui prefs (coder name, theme, fonts)
      // and AI settings survive; everything project-shaped resets — including the
      // speaker map, which belongs to the study (see exportProject): a lingering
      // "P is quiet" from study A would silently apply to study B's "P"
      newProject: () => {
        set({
          transcripts: {}, segments: [], codebook: {}, extSegRows: [], tabs: [],
          active: "browse", hotbar: { mode: get().hotbar.mode, pinned: [] }, hotbarCache: [],
          video: {}, aiFlags: {}, aiLog: [],
          // speakerFocus cleared with them: a stale focus name matching a speaker in
          // the NEXT study would silently dim everyone else there
          ui: { ...get().ui, speakerColors: {}, speakerWeight: {}, speakerFocus: {} },
          selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [], selRun: false,
          jump: null, search: { open: false, query: "", scope: "tab", current: null },
          pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false,
          nextSid: 1,
        });
        forgetScroll();
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
              if (old && (segs.length || old.lines.some((l) => l.orig !== undefined))) {
                const lines = rowsToLines(rows);
                const { map: _m, ...preview } = previewImport(segs, old.lines, lines);
                set({ pendingImports: [...get().pendingImports, { pid, lines, rows, preview }] });
              } else {
                mark(); importTranscript(get, set, pid, rows);
              }
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
      },

      resolveImport: (choice) => {
        const [p, ...rest] = get().pendingImports;
        if (!p) return;
        set({ pendingImports: rest });
        if (choice === "cancel") return;

        if (choice === "new") {
          get().pushUndo(); // an import is an edit: undoable, and it invalidates redo
          importTranscript(get, set, uniquePid(get(), p.pid), p.rows);
        } else {
          const s = get();
          const segs = s.segments.filter((x) => x.pid === p.pid);
          let kept: Segment[] = []; // "replace": the transcript's coding goes with it
          if (choice === "update") {
            const { map } = previewImport(segs, s.transcripts[p.pid].lines, p.lines);
            kept = segs.flatMap((seg) => {
              const r = remapSegment(seg, map);
              return r ? [{ ...seg, start: r.start, end: r.end }] : [];
            });
          }
          const saved = { ...s.savedSelections };
          delete saved[p.pid]; // a stashed selection points at the old line ids
          set({
            segments: [...s.segments.filter((x) => x.pid !== p.pid), ...kept],
            // The undo stack snapshots segments but not transcripts, so replaying it
            // after a re-import would restore segments pointing at the old line ids.
            // The modal's preview is the safety net instead.
            undoStack: [], redoStack: [],
            selection: s.selection.pid === p.pid ? emptySel() : s.selection,
            savedSelections: saved,
          });
          importTranscript(get, set, p.pid, p.rows);
        }
        set({ hotbarCache: hotbarCodes(get()) });
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
        if (s.segments.some((x) => x.pid === pid && x.start === start && x.end === end && norm(x.code) === norm(code) && x.proposedBy === by)) return;
        set({ segments: [...s.segments, { sid: s.nextSid, pid, start, end, code, notes, proposedBy: by, status }], nextSid: s.nextSid + 1 });
      },

      applyCode: (code) => {
        const s = get();
        if (!s.selection.pid || !s.selection.lines.size) return;
        s.pushUndo();
        const ids = [...s.selection.lines].sort((a, b) => a - b);
        let start = ids[0], prev = ids[0];
        for (let i = 1; i <= ids.length; i++) {
          if (i === ids.length || ids[i] !== prev + 1) { get().addSegment(s.selection.pid, start, prev, code); start = ids[i]; }
          prev = ids[i];
        }
        // the visual confirmation is a lane bar appearing; this is its audible twin
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
        const tabs = pid !== "browse" && !s.tabs.includes(pid) && s.transcripts[pid]
          ? [...s.tabs, pid] : s.tabs;
        set({ active: pid, tabs, selection: saved[pid] ?? emptySel(), savedSelections: saved, jump: { pid, line } });
      },
      clearJump: () => set({ jump: null }),
      scrollToLine: (line) => set({ jump: { pid: get().active, line } }), // same-tab scroll, no selection change
      setPalette: (v) => set({ paletteOpen: v }),
      setFormatOpen: (v) => set({ formatOpen: v }),
      openSearch: () => set({ search: { ...get().search, open: true } }),
      closeSearch: () => set({ search: { open: false, query: "", scope: "tab", current: null } }),
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

      // In-app transcription fix. The imported text is kept in `orig` (first edit
      // wins) so the correction is a recorded, revertible fact, not a silent change;
      // editing back to the original clears the flag. Line ids never change, so
      // segments are untouched. On the undo stack as a targeted line entry (see
      // lineEntry) — `orig` stays the RECORD of the change, Ctrl+Z steps it back.
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
      clearFlags: (pid) => {
        const next: Record<string, LineFlags> = {};
        for (const [k, v] of Object.entries(get().aiFlags)) if (!k.startsWith(`${pid}:`)) next[k] = v;
        set({ aiFlags: next, redoStack: [] }); // ditto — see addFlags
      },
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
      exportAiLog: () => toCSV(
        get().aiLog as unknown as Record<string, unknown>[],
        ["at", "model", "task", "pid", "lines", "redactions", "inTok", "outTok", "costUsd"]
      ),

      // The other half of the CSV interchange story: importCodebook has always
      // existed with no exporter, so colors and definitions could only ever be lost.
      exportCodebook: () => {
        const cb = get().codebook;
        const rows = Object.keys(cb).sort().map((code) => ({
          code, color: cb[code].color, short_def: cb[code].def, status: cb[code].status,
        }));
        return toCSV(rows, ["code", "color", "short_def", "status"]);
      },

      // Re-importable transcript, carrying the CORRECTED text. `original` is the
      // pre-correction text (informational; the importer ignores unknown columns).
      exportTranscript: (pid) => {
        const t = get().transcripts[pid];
        if (!t) return "";
        const rows = t.lines.map((l) => ({
          line_id: String(l.id), timestamp: l.ts, speaker: l.speaker, text: l.text,
          original: l.orig ?? "",
        }));
        return toCSV(rows, ["line_id", "timestamp", "speaker", "text", "original"]);
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
          format: FORMAT, version: VERSION, savedAt: new Date().toISOString(),
          transcripts: s.transcripts, segments: s.segments, codebook: s.codebook,
          extSegRows: s.extSegRows, tabs: s.tabs, active: s.active,
          hotbar: s.hotbar, video: s.video,
          ai: s.ai, aiFlags: s.aiFlags, aiLog: s.aiLog,
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
          ui: { ...s.ui, speakerColors: speakers.colors, speakerWeight: speakers.weight, speakerFocus: {} },
          transcripts: p.transcripts, segments: p.segments, codebook: p.codebook,
          extSegRows: p.extSegRows, tabs: p.tabs, active: p.active,
          hotbar: p.hotbar, video: p.video, ai: p.ai, aiFlags: p.aiFlags, aiLog: p.aiLog,
          // transient state belongs to the old workspace, not the loaded one
          selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [],
          jump: null, search: { open: false, query: "", scope: "tab", current: null },
          pendingImports: [], pendingProject: null, pendingSegUpdates: [], pendingImportSign: null, pendingCoderAsk: false,
          nextSid: Math.max(0, ...p.segments.map((x) => x.sid)) + 1,
        });
        set({ hotbarCache: hotbarCodes(get()) });
        forgetScroll(); // every pid in the new project is a different transcript
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
      setSegmentRange: (sid, start, end) =>
        set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, start, end } : x), redoStack: [] }),
      deleteSegment: (sid) => {
        get().pushUndo();
        set({ segments: get().segments.filter((x) => x.sid !== sid) });
        announce("Segment deleted");
      },
      setStatus: (sid, status) => {
        get().pushUndo();
        set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, status } : x) });
        announce(`Segment ${status}`);
      },
      setNotes: (sid, notes) => set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, notes } : x), redoStack: [] }),
      setColor: (code, color) => set({ codebook: { ...get().codebook, [code]: { ...get().codebook[code], color } }, redoStack: [] }),
      setDef: (code, def) => set({ codebook: { ...get().codebook, [code]: { ...get().codebook[code], def } }, redoStack: [] }),
      renameCode: (code, newName) => {
        const name = newName.trim();
        if (!name || name === code) return;
        const s = get();
        const existing = Object.keys(s.codebook).find((c) => norm(c) === norm(name) && c !== code);
        if (existing) { get().mergeCode(code, existing); return; } // rename into existing -> merge
        get().pushUndo();
        const cb: State["codebook"] = {};
        for (const k of Object.keys(s.codebook)) cb[k === code ? name : k] = s.codebook[k];
        set({
          codebook: cb,
          segments: s.segments.map((x) => norm(x.code) === norm(code) ? { ...x, code: name } : x),
          hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.map((c) => c === code ? name : c) },
        });
        set({ hotbarCache: hotbarCodes(get()) });
      },
      deleteCode: (code) => {
        const s = get();
        if (!s.codebook[code]) return;
        get().pushUndo();
        const cb = { ...s.codebook }; delete cb[code];
        set({
          codebook: cb,
          segments: s.segments.filter((x) => norm(x.code) !== norm(code)), // A: drop its segments too
          hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.filter((c) => c !== code) },
        });
        set({ hotbarCache: hotbarCodes(get()) });
      },
      mergeCode: (from, into) => {
        if (norm(from) === norm(into)) return;
        const s = get();
        get().pushUndo();
        const seen = new Set<string>();
        const merged = s.segments
          .map((x) => norm(x.code) === norm(from) ? { ...x, code: into } : x)
          .filter((x) => {
            const key = `${x.pid}|${x.start}|${x.end}|${norm(x.code)}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          });
        const cb = { ...s.codebook }; delete cb[from];
        set({
          codebook: cb,
          segments: merged,
          hotbar: { ...s.hotbar, pinned: s.hotbar.pinned.filter((c) => c !== from) },
        });
        set({ hotbarCache: hotbarCodes(get()) });
      },
      togglePin: (code) => {
        const p = get().hotbar.pinned;
        const pinned = p.includes(code) ? p.filter((c) => c !== code) : [...p, code];
        set({ hotbar: { ...get().hotbar, pinned } });
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
        if (!s.undoStack.length) return;
        const raw = s.undoStack[s.undoStack.length - 1];
        const o = JSON.parse(raw);
        const back = o.kind === "line" ? lineEntry(s, o.pid, o.id) ?? raw : snapshot(s);
        set({ redoStack: [...s.redoStack, back], undoStack: s.undoStack.slice(0, -1) });
        if (o.kind === "line") restoreLine(get, set, o); else restore(get, set, raw);
        announce("Undone");
      },
      redo: () => {
        const s = get();
        if (!s.redoStack.length) return;
        const raw = s.redoStack[s.redoStack.length - 1];
        const o = JSON.parse(raw);
        const back = o.kind === "line" ? lineEntry(s, o.pid, o.id) ?? raw : snapshot(s);
        set({ undoStack: [...s.undoStack, back], redoStack: s.redoStack.slice(0, -1) });
        if (o.kind === "line") restoreLine(get, set, o); else restore(get, set, raw);
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
        const seen = new Set<string>();
        const segments = get().segments
          .map((s) => (s.proposedBy.trim() && s.proposedBy !== "(default)" ? s : { ...s, proposedBy: by }))
          .filter((s) => {
            const k = `${s.pid}|${s.start}|${s.end}|${norm(s.code)}|${s.proposedBy}`;
            return seen.has(k) ? false : (seen.add(k), true);
          });
        set({ segments });
      },
      toggleTheme: () => set({ ui: { ...get().ui, dark: !get().ui.dark } }),
      setHotbarMode: (mode) => { set({ hotbar: { ...get().hotbar, mode } }); set({ hotbarCache: hotbarCodes(get()) }); },
      setZen: (v) => set({ ui: { ...get().ui, zen: v } }),

      exportCSV: () => {
        const s = get();
        const fields = ["segment_ref", "pid", "excerpt", "code", "proposed_by", "status", "notes"];
        const rows = s.segments.map((seg) => ({
          segment_ref: formatSegRef(seg.pid, seg.start, seg.end),
          pid: seg.pid,
          excerpt: excerptOf((s.transcripts[seg.pid]?.lines || [])
            .filter((l) => l.id >= seg.start && l.id <= seg.end)
            .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt,
          // never-empty invariant enforced at the write edge, whatever the source
          code: seg.code, proposed_by: seg.proposedBy.trim() || "(default)", status: seg.status, notes: seg.notes,
        })).concat(s.extSegRows.map((r) => ({ ...r, proposed_by: (r.proposed_by || "").trim() || "(default)" })) as never[]);
        return toCSV(rows, fields);
      },
    }),
    {
      name: "coding-app-state",
      // A full localStorage makes setItem THROW; zustand would log it and move on,
      // and autosave silently stops while the user keeps coding. Surface it instead
      // (saveFailed drives the App banner). setState is deferred a microtask so the
      // flag's own persist attempt can't recurse into this handler mid-write.
      storage: createJSONStorage(() => ({
        getItem: (k) => localStorage.getItem(k),
        removeItem: (k) => localStorage.removeItem(k),
        setItem: (k, v) => {
          try {
            localStorage.setItem(k, v);
            if (useStore.getState().saveFailed) queueMicrotask(() => useStore.setState({ saveFailed: false }));
          } catch {
            if (!useStore.getState().saveFailed) queueMicrotask(() => useStore.setState({ saveFailed: true }));
          }
        },
      })),
      partialize: (s) => ({
        transcripts: s.transcripts, segments: s.segments, codebook: s.codebook,
        extSegRows: s.extSegRows, tabs: s.tabs, active: s.active,
        hotbar: s.hotbar, video: s.video, ui: { ...s.ui, zen: false }, // zen is per-session view state
        ai: s.ai, aiFlags: s.aiFlags, aiLog: s.aiLog, // NB: the API key is not in the store (ai/key.ts)
      }),
      onRehydrateStorage: () => (s) => {
        if (!s) return;
        s.nextSid = Math.max(0, ...s.segments.map((x) => x.sid)) + 1;
        s.hotbarCache = hotbarCodes(s as State);
        // fields added after a persisted state was written (persist merges shallowly)
        s.ai.lenses ??= ["transcription"];
        s.ui.showNotices ??= true;
        s.ui.hiddenLenses ??= [];
        s.ui.lanePattern ??= false;
        s.ui.smoothScroll ??= false;
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
        // never-empty invariant: rows written empty by an earlier build become "(default)"
        s.segments = s.segments.map((x) => (x.proposedBy?.trim() ? x : { ...x, proposedBy: "(default)" }));
      },
    }
  )
);

// ── import helpers (module-scope so they can call ensureCode/addSegment) ──
type Get = () => State;
type Set_ = (partial: Partial<State>) => void;

function ensureCode(get: Get, set: Set_, code: string): string {
  const cb = get().codebook;
  const existing = Object.keys(cb).find((c) => norm(c) === norm(code));
  if (existing) return existing;
  set({ codebook: { ...cb, [code]: { color: COLORS[Object.keys(cb).length % COLORS.length], def: "", status: "candidate" } } });
  // a newly created code should appear in the hotbar immediately (no manual refresh)
  set({ hotbarCache: hotbarCodes(get()) });
  return code;
}

// Import gate for transcript CSVs: every row needs a unique, numeric line_id.
// Returns a message naming the offending rows (header = row 1), or null when clean.
export function badLineIds(rows: Record<string, string>[]): string | null {
  const bad: number[] = [], dup: number[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const id = (r.line_id || "").trim();
    if (!/^\d+$/.test(id)) bad.push(i + 2);
    else if (seen.has(id)) dup.push(i + 2);
    else seen.add(id);
  });
  const list = (ns: number[]) => ns.slice(0, 5).join(", ") + (ns.length > 5 ? ", …" : "");
  if (bad.length) return `has a blank or non-numeric line_id on row${bad.length > 1 ? "s" : ""} ${list(bad)}`;
  if (dup.length) return `has a duplicate line_id on row${dup.length > 1 ? "s" : ""} ${list(dup)}`;
  return null;
}

export function rowsToLines(rows: Record<string, string>[]): Line[] {
  return rows
    .map((r) => ({ id: +r.line_id, ts: r.timestamp || "", speaker: (r.speaker || "P").trim(), text: r.text || "" }))
    .filter((l) => Number.isFinite(l.id));
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
    tabs: s.tabs.includes(pid) ? s.tabs : [...s.tabs, pid],
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
  // inline codes column -> segments (contract run-collapse, same as sync_coding.py)
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
    set({ codebook: { ...cb, [key]: {
      ...cb[key],
      def: r.short_def || cb[key].def,
      status: r.status || cb[key].status,
      // colors come from our own codebook.csv export; older files have no column
      color: /^#[0-9a-f]{6}$/i.test(r.color || "") ? r.color : cb[key].color,
    } } });
  });
}

function importSegments(get: Get, set: Set_, rows: Record<string, string>[]) {
  rows.forEach((r) => {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(r.segment_ref || "");
    if (!m) return;
    const pid = m[1], start = +m[2], end = +(m[3] || m[2]);
    // a corrupt/hand-edited ref like p1:1-999999999 would hang remapSegment on the
    // next re-import (it walks every line in the range); no real segment spans 10k
    if (end < start || end - start > 9999) return;
    if (!get().transcripts[pid]) {
      // parked, not imported — dedup here, or re-importing the same file grows the
      // passthrough rows without bound and export re-emits the duplicates
      const key = (x: Record<string, string>) =>
        `${x.segment_ref}|${norm(x.code || "")}|${(x.proposed_by || "").trim()}`;
      if (!get().extSegRows.some((x) => key(x) === key(r))) set({ extSegRows: [...get().extSegRows, r] });
      return;
    }
    const canon = ensureCode(get, set, r.code);
    // an imported row with no coder is NOT yours — mark it "(default)", never your name
    const coder = (r.proposed_by || "").trim() || "(default)";
    const status = r.status || "accepted", notes = r.notes || "";
    const existing = get().segments.find((x) =>
      x.pid === pid && x.start === start && x.end === end && norm(x.code) === norm(canon) && x.proposedBy === coder);
    if (existing) {
      // a re-imported row that only changed status/notes must not vanish into
      // addSegment's dedup — but it would OVERWRITE in-app review work, so it's
      // parked for consent (SegUpdateModal) instead of applied silently
      if ((existing.status !== status || existing.notes !== notes)
          && !get().pendingSegUpdates.some((u) => u.sid === existing.sid))
        set({ pendingSegUpdates: [...get().pendingSegUpdates, {
          sid: existing.sid, ref: formatSegRef(pid, start, end), code: canon,
          from: { status: existing.status, notes: existing.notes },
          to: { status, notes },
        }] });
    } else {
      get().addSegment(pid, start, end, canon, coder, status, notes);
    }
  });
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
export const speakerColor = (ui: Ui, speaker: string): string => {
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

export const weightOf = (ui: Ui, speaker: string): SpeakerWeight =>
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
