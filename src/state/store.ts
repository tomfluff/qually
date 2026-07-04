import { create } from "zustand";
import { persist } from "zustand/middleware";
import { parseCSV, toCSV } from "../contract/csv";
import { collapseRuns, formatSegRef, norm, type CodedLine } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";

const COLORS = ["#e0554f", "#3b82c4", "#3fa860", "#c98a2a", "#8e6bc9", "#2fa3a3",
  "#c95c9c", "#7d8f2e", "#b0653a", "#5470d6", "#4f9e86", "#a35ac0"];

export interface Line { id: number; ts: string; speaker: string; text: string; }
export interface Segment {
  sid: number; pid: string; start: number; end: number; code: string;
  notes: string; proposedBy: string; status: string;
}
export interface Selection { pid: string | null; anchor: number | null; lines: Set<number>; }

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
  ui: { fontSize: number; sidebarFontSize: number; dark: boolean; zen: boolean };
  // transient (not persisted)
  selection: Selection;
  undoStack: string[];
  redoStack: string[];
  nextSid: number;
  jump: { pid: string; line: number } | null;

  importFiles: (files: FileList | File[]) => Promise<void>;
  ensureCode: (code: string) => string;
  addSegment: (pid: string, start: number, end: number, code: string,
    proposedBy?: string, status?: string, notes?: string) => void;
  applyCode: (code: string) => void;
  selectLine: (id: number, opts?: { extend?: boolean; toggle?: boolean }) => void;
  clearSelection: () => void;
  setActive: (pid: string) => void;
  closeTab: (pid: string) => void;
  jumpTo: (pid: string, line: number) => void;
  clearJump: () => void;
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
  toggleTheme: () => void;
  setHotbarMode: (mode: "auto" | "pinned") => void;
  setZen: (v: boolean) => void;
  exportCSV: () => string;
}

const emptySel = (): Selection => ({ pid: null, anchor: null, lines: new Set() });

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
      video: {}, ui: { fontSize: 16, sidebarFontSize: 13, dark: false, zen: false },
      selection: emptySel(), undoStack: [], redoStack: [], nextSid: 1, jump: null,

      importFiles: async (files) => {
        for (const f of Array.from(files)) {
          const rows = parseCSV(await f.text());
          if (!rows.length) continue;
          const cols = Object.keys(rows[0]);
          if (cols.includes("segment_ref")) importSegments(get, set, rows);
          else if (cols.includes("short_def") || (cols.includes("code") && cols.includes("status")))
            importCodebook(get, set, rows);
          else if (cols.includes("line_id") && cols.includes("text"))
            importTranscript(get, set, f.name.replace(/\.csv$/i, ""), rows);
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

      selectLine: (id, opts = {}) => {
        const s = get();
        let sel = s.selection.pid === s.active ? s.selection : emptySel();
        sel = { pid: s.active, anchor: sel.anchor, lines: new Set(sel.lines) };
        if (opts.extend && sel.anchor !== null) {
          sel.lines = new Set();
          const [a, b] = [Math.min(sel.anchor, id), Math.max(sel.anchor, id)];
          for (let i = a; i <= b; i++) sel.lines.add(i);
        } else if (opts.toggle) {
          if (sel.lines.has(id)) sel.lines.delete(id); else sel.lines.add(id);
          sel.anchor = id;
        } else if (sel.lines.has(id) && sel.lines.size === 1) {
          sel = emptySel();
        } else { sel.lines = new Set([id]); sel.anchor = id; }
        set({ selection: sel });
      },

      clearSelection: () => set({ selection: emptySel() }),
      setActive: (pid) => set({ active: pid, selection: emptySel() }),
      jumpTo: (pid, line) => set({ active: pid, selection: emptySel(), jump: { pid, line } }),
      clearJump: () => set({ jump: null }),
      closeTab: (pid) => {
        const s = get();
        const tabs = s.tabs.filter((p) => p !== pid);
        set({ tabs, active: s.active === pid ? (tabs[0] || "browse") : s.active });
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
        hotbar: s.hotbar, video: s.video, ui: s.ui,
      }),
      onRehydrateStorage: () => (s) => {
        if (!s) return;
        s.nextSid = Math.max(0, ...s.segments.map((x) => x.sid)) + 1;
        s.hotbarCache = hotbarCodes(s as State);
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

function importTranscript(get: Get, set: Set_, pid: string, rows: Record<string, string>[]) {
  const lines: Line[] = rows.map((r) => ({ id: +r.line_id, ts: r.timestamp || "", speaker: (r.speaker || "P").trim(), text: r.text || "" }))
    .filter((l) => Number.isFinite(l.id));
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
    set({ codebook: { ...cb, [key]: { ...cb[key], def: r.short_def || cb[key].def, status: r.status || cb[key].status } } });
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
