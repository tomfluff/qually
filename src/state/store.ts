import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseCSV, toCSV } from "../contract/csv";
import { collapseRuns, formatSegRef, norm, type CodedLine } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";
import { mergeGroups, type Group } from "../merge";
import { previewImport, remapSegment, type ImportPreview } from "../align";
import { DEFAULT_MODEL } from "../ai/openai";
import { hashLine, type Flag } from "../ai/flag";
import { FORMAT, VERSION, parseProject, type Project } from "../project";
import { DEFAULT_ACCENT } from "../palettes";

const COLORS = ["#e0554f", "#3b82c4", "#3fa860", "#c98a2a", "#8e6bc9", "#2fa3a3",
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
  warnCorner: "left" | "right"; // close-call badge corner
  warnSize: "xs" | "sm" | "md" | "lg"; // close-call badge size
  laneWidth: "xs" | "sm" | "md" | "lg"; // width of the code lane bars
  minimapWidth: number; // transcript minimap width (px)
  minimapDetail: "detailed" | "simplified"; // minimap abstraction level
  showNotices: boolean; // AI noticing highlights visible (hide to read/code blind)
  lanePattern: boolean; // give each code a pattern as well as a colour (see patternOf)
}
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
  nextSid: number;
  jump: { pid: string; line: number } | null;
  paletteOpen: boolean;
  formatOpen: boolean;
  search: Search;
  pendingImports: PendingImport[]; // re-imports awaiting a user decision
  pendingProject: Project | null;  // a loaded project awaiting the replace confirmation

  importFiles: (files: FileList | File[]) => Promise<void>;
  resolveImport: (choice: ImportChoice) => void;
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
  toggleReject: (sid: number) => void;
  setNotes: (sid: number, notes: string) => void;
  setColor: (code: string, color: string) => void;
  togglePin: (code: string) => void;
  refreshHotbar: () => void;
  pushUndo: () => void;
  undo: () => void;
  redo: () => void;
  renameCode: (code: string, newName: string) => void;
  deleteCode: (code: string) => void;
  mergeCode: (from: string, into: string) => void;
  setDef: (code: string, def: string) => void;
  setFontSize: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setUi: (patch: Partial<Ui>) => void;
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

function snapshot(s: State): string {
  return JSON.stringify({ segments: s.segments, codebook: s.codebook, hotbar: s.hotbar });
}
function restore(get: () => State, set: (p: Partial<State>) => void, json: string) {
  const o = JSON.parse(json);
  const next = { ...get(), segments: o.segments, codebook: o.codebook, hotbar: o.hotbar };
  set({ segments: o.segments, codebook: o.codebook, hotbar: o.hotbar, hotbarCache: hotbarCodes(next) });
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
      video: {}, ui: { fontSize: 16, sidebarFontSize: 13, dark: false, zen: false, sidebarWidth: 250, browseLeftWidth: 264, palettePos: "auto", helpSeen: false, mergeLines: false, showLineNumbers: false, accent: DEFAULT_ACCENT, speakerNames: "full", warnCorner: "right", warnSize: "sm", laneWidth: "md", minimapWidth: 66, minimapDetail: "detailed", showNotices: true, lanePattern: false },
      ai: { model: DEFAULT_MODEL, redactTerms: [], lenses: ["transcription"] }, aiFlags: {}, aiLog: [],
      selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [], nextSid: 1, jump: null, paletteOpen: false, formatOpen: false,
      search: { open: false, query: "", scope: "tab", current: null },
      pendingImports: [], pendingProject: null,

      importFiles: async (files) => {
        const skipped: string[] = [];
        for (const f of Array.from(files)) {
          // a project file goes through the same one entry point; the modal confirms
          // before it replaces the workspace
          if (/\.json$/i.test(f.name)) {
            set({ pendingProject: parseProject(await f.text()) });
            continue;
          }
          const rows = parseCSV(await f.text());
          const cols = rows.length ? Object.keys(rows[0]) : [];
          if (cols.includes("segment_ref")) importSegments(get, set, rows);
          else if (cols.includes("short_def") || (cols.includes("code") && cols.includes("status")))
            importCodebook(get, set, rows);
          else if (cols.includes("line_id") && cols.includes("text")) {
            const pid = f.name.replace(/\.csv$/i, "");
            const s = get();
            const old = s.transcripts[pid];
            const segs = s.segments.filter((x) => x.pid === pid);
            // Re-importing over existing coding would silently move every segment
            // onto whatever line now holds that number: ask first (see ImportModal).
            if (old && segs.length) {
              const lines = rowsToLines(rows);
              const { map: _m, ...preview } = previewImport(segs, old.lines, lines);
              set({ pendingImports: [...get().pendingImports, { pid, lines, rows, preview }] });
            } else {
              importTranscript(get, set, pid, rows);
            }
          } else {
            // an unrecognized file must say so, not vanish without a trace
            skipped.push(rows.length
              ? `${f.name} doesn't match any QuAlly format — a transcript CSV needs "line_id" and "text" columns (see File format)`
              : `${f.name} is empty`);
          }
        }
        set({ hotbarCache: hotbarCodes(get()) });
        if (skipped.length) throw new Error(skipped.join("; "));
      },

      resolveImport: (choice) => {
        const [p, ...rest] = get().pendingImports;
        if (!p) return;
        set({ pendingImports: rest });
        if (choice === "cancel") return;

        if (choice === "new") {
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

      addSegment: (pid, start, end, code, proposedBy = "tom", status = "accepted", notes = "") => {
        const s = get();
        if (s.segments.some((x) => x.pid === pid && x.start === start && x.end === end && norm(x.code) === norm(code))) return;
        set({ segments: [...s.segments, { sid: s.nextSid, pid, start, end, code, notes, proposedBy, status }], nextSid: s.nextSid + 1 });
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
        if (extend) {
          const anchorGi = s.selection.anchor !== null ? groupIdxOf(gs, s.selection.anchor) : -1;
          const headGi = s.selection.head !== null ? groupIdxOf(gs, s.selection.head) : anchorGi;
          const ni = Math.max(0, Math.min(gs.length - 1, (headGi < 0 ? anchorGi : headGi) + dir));
          if (ni === headGi) return;
          const base = anchorGi < 0 ? ni : anchorGi;
          set({ selection: { pid: s.active, anchor: gs[base].startId, head: gs[ni].startId, lines: new Set(idsBetween(gs, base, ni)) } });
        } else {
          const ids = [...s.selection.lines];
          const edgeGi = groupIdxOf(gs, dir > 0 ? Math.max(...ids) : Math.min(...ids));
          const ni = edgeGi + dir;
          if (ni < 0 || ni >= gs.length) return;
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
      clearSelection: () => set({ selection: emptySel() }),
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
        set({ active: pid, selection: saved[pid] ?? emptySel(), savedSelections: saved, jump: { pid, line } });
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
        delete saved[pid]; // a closed tab's selection dies with it
        if (s.active !== pid) { set({ tabs, savedSelections: saved }); return; }
        const next = tabs[0] || "browse";
        set({ tabs, active: next, selection: saved[next] ?? emptySel(), savedSelections: saved });
      },

      // In-app transcription fix. The imported text is kept in `orig` (first edit
      // wins) so the correction is a recorded, revertible fact, not a silent change;
      // editing back to the original clears the flag. Line ids never change, so
      // segments are untouched. Not on the undo stack — `orig` IS the undo.
      editLine: (pid, id, text) => {
        const t = get().transcripts[pid];
        if (!t) return;
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
        set({ aiFlags: next });
      },
      clearFlags: (pid) => {
        const next: Record<string, LineFlags> = {};
        for (const [k, v] of Object.entries(get().aiFlags)) if (!k.startsWith(`${pid}:`)) next[k] = v;
        set({ aiFlags: next });
      },
      // "I disagree with this mark": the span goes, but the line stays recorded as
      // scanned under that lens, so dismissing doesn't cause a re-fetch of the same mark.
      dismissNotice: (pid, id, lens, quote) => {
        const key = `${pid}:${id}`;
        const cur = get().aiFlags[key];
        if (!cur) return;
        set({ aiFlags: { ...get().aiFlags, [key]: { ...cur, spans: cur.spans.filter((s) => !((s.lens ?? "transcription") === lens && s.quote === quote)) } } });
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
        for (const pid of s.tabs) {
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
          // NB: no API key (not in the store), no UI prefs, no media — see project.ts
        };
        return JSON.stringify(p, null, 2);
      },

      setPendingProject: (p) => set({ pendingProject: p }),

      // Replaces the workspace wholesale. Merging would mean sid collisions and
      // code-name conflicts for no benefit; the modal confirms before we get here.
      openProject: (p) => {
        set({
          transcripts: p.transcripts, segments: p.segments, codebook: p.codebook,
          extSegRows: p.extSegRows, tabs: p.tabs, active: p.active,
          hotbar: p.hotbar, video: p.video, ai: p.ai, aiFlags: p.aiFlags, aiLog: p.aiLog,
          // transient state belongs to the old workspace, not the loaded one
          selection: emptySel(), savedSelections: {}, undoStack: [], redoStack: [],
          jump: null, search: { open: false, query: "", scope: "tab", current: null },
          pendingImports: [], pendingProject: null,
          nextSid: Math.max(0, ...p.segments.map((x) => x.sid)) + 1,
        });
        set({ hotbarCache: hotbarCodes(get()) });
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

      setSegmentRange: (sid, start, end) =>
        set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, start, end } : x) }),
      deleteSegment: (sid) => { get().pushUndo(); set({ segments: get().segments.filter((x) => x.sid !== sid) }); },
      toggleReject: (sid) => {
        get().pushUndo();
        set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, status: x.status === "rejected" ? "accepted" : "rejected" } : x) });
      },
      setNotes: (sid, notes) => set({ segments: get().segments.map((x) => x.sid === sid ? { ...x, notes } : x) }),
      setColor: (code, color) => set({ codebook: { ...get().codebook, [code]: { ...get().codebook[code], color } } }),
      setDef: (code, def) => set({ codebook: { ...get().codebook, [code]: { ...get().codebook[code], def } } }),
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
        if (stack.length > 80) stack.shift();
        set({ undoStack: stack, redoStack: [] }); // new action invalidates redo
      },
      undo: () => {
        const s = get();
        if (!s.undoStack.length) return;
        set({ redoStack: [...s.redoStack, snapshot(s)], undoStack: s.undoStack.slice(0, -1) });
        restore(get, set, s.undoStack[s.undoStack.length - 1]);
      },
      redo: () => {
        const s = get();
        if (!s.redoStack.length) return;
        set({ undoStack: [...s.undoStack, snapshot(s)], redoStack: s.redoStack.slice(0, -1) });
        restore(get, set, s.redoStack[s.redoStack.length - 1]);
      },

      setFontSize: (n) => set({ ui: { ...get().ui, fontSize: n } }),
      setSidebarFontSize: (n) => set({ ui: { ...get().ui, sidebarFontSize: n } }),
      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
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
          code: seg.code, proposed_by: seg.proposedBy, status: seg.status, notes: seg.notes,
        })).concat(s.extSegRows as never[]);
        return toCSV(rows, fields);
      },
    }),
    {
      name: "coding-app-state",
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
        s.ui.lanePattern ??= false;
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
  set({
    transcripts: { ...s.transcripts, [pid]: { lines } },
    tabs: s.tabs.includes(pid) ? s.tabs : [...s.tabs, pid],
    active: s.active === "browse" && !s.tabs.length ? pid : s.active,
  });
  // inline codes column -> segments (contract run-collapse, same as sync_coding.py)
  const coded: CodedLine[] = rows.map((r) => ({
    n: +r.line_id,
    codes: new Set((r.codes || "").split(";").map((c) => c.trim()).filter(Boolean)),
  })).filter((l) => Number.isFinite(l.n)).sort((a, b) => a.n - b.n);
  for (const [code, spans] of collapseRuns(coded)) {
    const canon = ensureCode(get, set, code);
    for (const [start, end] of spans) get().addSegment(pid, start, end, canon);
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
    if (!get().transcripts[pid]) { set({ extSegRows: [...get().extSegRows, r] }); return; }
    const canon = ensureCode(get, set, r.code);
    get().addSegment(pid, start, end, canon, r.proposed_by || "tom", r.status || "accepted", r.notes || "");
  });
}

// selector helpers
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
