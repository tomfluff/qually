// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties } from "react";
import { VList, type VListHandle } from "virtua";
import { stopScrollAnim } from "../scrollSpeed";
import { useStore, laneAssign, patternOf, speakerColor, weightOf, inkOn, LOOP_SPEEDS, clampMinimapWidth } from "../state/store";
import { mergeGroups, type Group } from "../merge";
import { SegmentPopover } from "./SegmentPopover";
import { CodeMenu } from "./CodeMenu";
import { AiMarkPopover } from "./AiMarkPopover";
import { Icon } from "./Icon";
import { Minimap, type MinimapHandle } from "./Minimap";
import { Resizer } from "./Resizer";
import { seekVideo, loopLine, loopWindow, hasVideo, setPlaybackRate } from "../video/seek";
import { useDismiss, useClampToViewport } from "../usePopover";
import { stretchColor, stretchDims, type Stretch } from "../stretches";
import { hashLine, lensOf, spanLens, type Flag } from "../ai/flag";
import type { Line, SpeakerWeight } from "../state/store";
import { findMatches } from "../search";
import { excerptOf } from "../contract/excerpt";
import { savedScroll, positioned, rememberScroll } from "../scrollMemory";
import { announce } from "../announce";
import { tinyDiff } from "../diff";
import { useMarkers } from "../useMarkers";
import { fmtLike, markerColor, markerKey, type Marker } from "../markers";
import { openColorPicker } from "../colorPicker";
import { AddEventModal } from "./AddEventModal";
import { tsToSec } from "../video/seek";
import type { ReactNode } from "react";

type LanedSeg = ReturnType<typeof laneAssign>[number];

// What the virtualized list actually holds. Session events get their OWN rows
// rather than riding inside a line: a note is not an utterance, and the two must
// never be mistaken for each other while reading. Everything downstream (scroll
// restore, jumps, keep-in-view, the minimap) indexes THIS array — one axis, so a
// marker between two lines can't push the two views out of step.
export type Item = { kind: "g"; g: Group } | { kind: "m"; m: Marker };

// text with search matches wrapped in <mark>; the occ == curOcc match is emphasized
function renderText(text: string, query: string, curOcc: number): ReactNode {
  const m = findMatches(text, query);
  if (!m.length) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  m.forEach(([s, e], k) => {
    if (s > last) nodes.push(text.slice(last, s));
    nodes.push(<mark key={k} className={k === curOcc ? "cur" : ""}>{text.slice(s, e)}</mark>);
    last = e;
  });
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// AI marks in the text. Transcription flags: amber dotted (something's wrong).
// Noticing lenses: a quiet per-lens tint (something to look at). Hover shows the
// read-only tip (errors include the suggested fix); a plain click opens the
// mark's popover (selection deliberately suppressed); Alt-click stays the dismiss
// shortcut. Search highlighting wins when a query is active — two overlapping
// mark-ups on the same characters is noise, and you're hunting, not proofreading.
// The ✱ on a repaired line. Its tooltip shows only the span that changed (the
// Tooltip component reads the data-tip* attrs and renders a struck-old/new diff),
// not the whole original re-quoted.
function EditMark({ orig, text }: { orig: string; text: string }): ReactNode {
  const d = tinyDiff(orig, text);
  return <span className="editmark" data-tipdel={d.del} data-tipins={d.ins}
    data-tippre={d.pre || undefined} data-tipsuf={d.suf || undefined}>✱</span>;
}

function renderFlagged(text: string, spans: Flag[], lineId: number): ReactNode {
  const hits: { at: number; len: number; span: Flag; idx: number }[] = [];
  spans.forEach((s, idx) => {
    const at = text.indexOf(s.quote);
    if (at >= 0) hits.push({ at, len: s.quote.length, span: s, idx });
  });
  if (!hits.length) return text;
  hits.sort((a, b) => a.at - b.at);
  const nodes: ReactNode[] = [];
  let last = 0;
  hits.forEach((h, k) => {
    if (h.at < last) return; // overlapping marks: keep the first
    if (h.at > last) nodes.push(text.slice(last, h.at));
    const lens = lensOf(spanLens(h.span));
    const isError = spanLens(h.span) === "transcription";
    // A mark's press must NOT select the row (onRowDown bails on [data-ai]), but
    // the mousedown still bubbles — document-level closers (open code menu,
    // segment popover, color picker) rely on hearing it. The click then reaches
    // the list's delegated [data-ai] handler, which opens the mark's popover.
    const ai = `${lineId}:${h.idx}`;
    nodes.push(isError
      ? <span key={k} className="aidoubt" data-ai={ai}
          data-tip={h.span.fix ? `${h.span.reason} → “${h.span.fix}”` : h.span.reason}
          >{text.slice(h.at, h.at + h.len)}</span>
      : <span key={k} className={`ainote lens-${spanLens(h.span)}`} style={{ "--lens-c": lens?.color } as CSSProperties}
          data-ai={ai} data-tip={`${lens?.label ?? spanLens(h.span)} — ${h.span.reason}`}
          onClick={(e) => {
            if (!e.altKey) return; // plain click opens the popover (delegated); alt-click stays the dismiss shortcut
            e.stopPropagation();
            const st = useStore.getState();
            st.dismissNotice(st.active, lineId, spanLens(h.span), h.span.quote);
          }}>{text.slice(h.at, h.at + h.len)}</span>);
    last = h.at + h.len;
  });
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const lidLabel = (g: Group) => g.startId === g.endId ? `${g.startId}` : `${g.startId}–${g.endId}`;
// "Short" mode used to be a blind slice(0,3): Alice, Alicia and Alina all rendered
// "Ali", which left COLOUR as the only thing telling them apart — the exact failure
// this branch exists to remove. Grow the abbreviation until it is unique among the
// speakers actually present.
export function shortLabels(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of names) {
    const t = raw.trim();
    let len = Math.min(3, t.length);
    while (len < t.length && names.some((o) => {
      const u = o.trim();
      return u !== t && u.slice(0, len).toLowerCase() === t.slice(0, len).toLowerCase();
    })) len++;
    out[t] = t.slice(0, len);
  }
  return out;
}
const LANE_W = { xs: 10, sm: 14, md: 18, lg: 24 } as const; // lane bar width px

// the stretch gutter's geometry: band px per thickness step, vertical-label
// font px per size step — the label rides its band, so a dimension costs a
// band plus one letter-height, not a column of prose
const STRETCH_BAND_PX = { xs: 3, sm: 5, md: 8, lg: 12 } as const;
const STRETCH_LABEL_PX = { sm: 10, md: 13, lg: 16 } as const;
// lazy: this module is imported by node-side tests where document is absent
let stMeasure: CanvasRenderingContext2D | null = null;

const MIN_PAD = 48;    // headroom floor (also the spacer height until the viewport is measured)
const ROW_RATIO = 2.2; // one unwrapped row ≈ 2.2 × fontSize (row line-height + padding)
// There is deliberately no animated scrolling here. Every jump lands in one frame.
// An rAF loop that writes scrollTop cannot coexist with virtua: virtua shifts the scroll
// itself whenever a row measures differently than it guessed, and the two writers fight
// frame by frame. It jittered worst right after a font-size change, which makes every
// cached row height wrong at once. Native scroll doesn't have the problem because virtua
// compensates against a position it already knows about.

// per-tab scroll anchors — shared with the store, which must forget them on a
// re-import or project swap (a pid is not stable identity). See scrollMemory.ts.

export function TranscriptView() {
  const active = useStore((s) => s.active);
  const transcript = useStore((s) => s.transcripts[s.active]);
  const mergeLines = useStore((s) => s.ui.mergeLines);
  const mergeGap = useStore((s) => (s.ui.mergeGapOn ? s.ui.mergeGap : null));
  const showLineNumbers = useStore((s) => s.ui.showLineNumbers);
  const speakerNames = useStore((s) => s.ui.speakerNames);
  const warnCls = useStore((s) => `cc-${s.ui.warnSize} cc-${s.ui.warnCorner}`);
  const lanePattern = useStore((s) => s.ui.lanePattern);
  const ui = useStore((s) => s.ui);
  const laneWidth = useStore((s) => s.ui.laneWidth);
  const minimapDetail = useStore((s) => s.ui.minimapDetail);
  const setUi = useStore((s) => s.setUi);
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const selLines = useStore((s) => (s.selection.pid === s.active ? s.selection.lines : null));
  const allStretches = useStore((s) => s.stretches);
  const stretchBand = useStore((s) => s.ui.stretchBand);
  const stretchLabel = useStore((s) => s.ui.stretchLabel);
  // the gutter exists only while this transcript has stretches; every row
  // shares one geometry so the text column stays aligned
  const stretchCtx = useMemo(() => {
    const list = allStretches.filter((st) => st.pid === active);
    if (!list.length) return null;
    const dims = stretchDims(list);
    const bandPx = STRETCH_BAND_PX[stretchBand];
    const labelPx = STRETCH_LABEL_PX[stretchLabel];
    const pillW = labelPx + 7;  // the tab-pill's thickness across its text
    const leadIn = 6;           // clearance from the row's own left border
    // a dimension's column: pill flush against its band (a tab out of the
    // booklet's spine), then 4px clear of the NEXT lane
    const colW = pillW + bandPx + 4;
    const widthPx = leadIn + dims.length * colW;
    return { list, dims, bandPx, labelPx, pillW, leadIn, colW, width: `${widthPx}px`, widthPx };
  }, [allStretches, active, stretchBand, stretchLabel]);
  const [stretchMenu, setStretchMenu] = useState<{ x: number; y: number; start: number; end: number; addAfter: Group } | null>(null);
  // The sticky labels: a stretch's name rides the top of the viewport while
  // you are inside it and hands off where the next stretch begins — computed
  // imperatively on scroll (the rows are virtualized; no row can know it is
  // the first visible one), same rhythm as the minimap sync.
  const stretchOvRef = useRef<HTMLDivElement>(null);
  const stretchCtxRef = useRef<StretchCtx | null>(null);
  stretchCtxRef.current = stretchCtx;
  const syncStretchLabels = useCallback(() => {
    const ov = stretchOvRef.current, v = vref.current, ctx = stretchCtxRef.current;
    if (!ov) return;
    if (!ctx || !v || !v.viewportSize) { ov.replaceChildren(); return; }
    const idx = itemIdxRef.current;
    const listEl = ov.parentElement?.querySelector(".tviewlist");
    const ovRect = ov.getBoundingClientRect();
    // anchor to a rendered gutter cell: the rows carry left padding the list
    // edge knows nothing about, and the labels must sit IN their columns.
    // No cell in the viewport (all event rows, or the first frame after a
    // restore) — the cell absorbs exactly the row padding, so the list's own
    // left edge is the same x: fall back to it rather than blanking the gutter
    const cellEl = listEl?.querySelector(".stretchCell");
    const baseX = (cellEl ?? listEl ?? ov).getBoundingClientRect().left - ovRect.left;
    const frag = document.createDocumentFragment();
    const vp = v.viewportSize;
    // the bands first: ONE continuous strip per stretch, clamped to a margin
    // around the viewport (a stretch can span thousands of rows). Rounded cap
    // only when its real start is on screen.
    // start-order per column, and a LOGICALLY DISJOINT band starts no higher
    // than the last one ended: with merged lines two adjacent stretches share
    // the boundary row's item, and unclamped both would paint it — the
    // earlier one keeps it. A stretch whose LINES genuinely overlap the
    // previous ones (allowed on purpose — re-marking, containment) is not
    // clamped: it paints over them, as marked.
    const lastBand = new Map<number, { end: number; bottom: number }>();
    for (const st of [...ctx.list].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const gi0 = idx?.get(st.start), gi1 = idx?.get(st.end);
      if (gi0 === undefined || gi1 === undefined) continue;
      const col = ctx.dims.indexOf(st.dim);
      if (col < 0) continue;
      const prev = lastBand.get(col);
      const rawY0 = v.getItemOffset(gi0 + 1) - v.scrollOffset;
      const y0 = prev && st.start > prev.end ? Math.max(rawY0, prev.bottom) : rawY0;
      const y1 = v.getItemOffset(gi1 + 2) - v.scrollOffset;
      if (y1 <= y0) continue;
      lastBand.set(col, {
        end: Math.max(st.end, prev?.end ?? -Infinity),
        bottom: Math.max(y1, prev?.bottom ?? -Infinity),
      });
      if (y1 <= 0 || y0 >= vp) continue;
      const top = Math.max(y0, -20), bottom = Math.min(y1, vp + 20);
      const band = document.createElement("span");
      band.className = "stFloatBand" + (y0 >= -20 ? " stStart" : "");
      band.title = `${st.dim}: ${st.value} · lines ${st.start}–${st.end}`;
      band.style.cssText = `left:${baseX + ctx.leadIn + col * ctx.colW + ctx.pillW}px;` +
        `top:${top}px;height:${bottom - top}px;width:${ctx.bandPx}px;background:${stretchColor(st.value)};`;
      frag.appendChild(band);
    }
    for (const st of ctx.list) {
      const gi0 = idx?.get(st.start), gi1 = idx?.get(st.end);
      if (gi0 === undefined || gi1 === undefined) continue;
      // virtua child indices carry the vpad at 0, so items shift by one; the
      // stretch's end is the start of whatever follows its last row
      const y0 = v.getItemOffset(gi0 + 1) - v.scrollOffset;
      const y1 = v.getItemOffset(gi1 + 2) - v.scrollOffset;
      if (y1 <= 0 || y0 >= v.viewportSize) continue;
      const col = ctx.dims.indexOf(st.dim);
      if (col < 0) continue;
      // measured, not guessed: a vertical label's height is its horizontal
      // text advance — canvas measure, no layout read (wide glyphs, CJK)
      stMeasure ??= document.createElement("canvas").getContext("2d")!;
      stMeasure.font = `700 ${ctx.labelPx}px ${getComputedStyle(document.body).fontFamily}`;
      // a first ESTIMATE for placement; the real rendered height is read back
      // below and re-clamped — letter-spacing and font metrics drift enough
      // that an estimated pill poked past its band's end
      const len = stMeasure.measureText(st.value.toUpperCase()).width + 18;
      const top = Math.min(Math.max(y0 + 2, 4), Math.max(y1 - len, y0 + 2));
      const el = document.createElement("span");
      el.className = "stFloatLabel";
      el.textContent = st.value;
      el.title = `${st.dim}: ${st.value} · lines ${st.start}–${st.end}`;
      const c = stretchColor(st.value);
      el.style.cssText = `left:${baseX + ctx.leadIn + col * ctx.colW}px;top:${top}px;` +
        `font-size:${ctx.labelPx}px;background:${c};color:${inkOn(c)};width:${ctx.pillW}px;`;
      el.dataset.y0 = String(y0); el.dataset.y1 = String(y1);
      frag.appendChild(el);
    }
    ov.replaceChildren(frag);
    // second pass with REAL heights: the pill must never pass its stretch's
    // end. Re-clamp against the measured box; when the visible span is
    // shorter than the label, clip the pill to the span instead of letting
    // it overhang rows the stretch does not cover. All heights are read
    // before any top is written — one forced layout per sync, not one per
    // label (this runs on every scroll frame).
    const labels = Array.from(ov.children).filter(
      (el): el is HTMLElement => el.classList.contains("stFloatLabel"));
    const heights = labels.map((el) => el.offsetHeight);
    labels.forEach((el, i) => {
      const y0 = Number(el.dataset.y0), y1 = Number(el.dataset.y1);
      const h = heights[i];
      let top = Math.min(Math.max(y0 + 2, 4), y1 - h);
      if (top < y0 + 2) top = y0 + 2; // span shorter than the label
      el.style.top = `${top}px`;
      if (top + h > y1) { el.style.height = `${Math.max(0, y1 - top)}px`; el.style.overflow = "hidden"; }
    });
  }, []);
  useEffect(() => { syncStretchLabels(); });
  // a window resize re-wraps rows (offsets shift) without a re-render or scroll;
  // rAF so virtua has remeasured before we read offsets
  useEffect(() => {
    const onResize = () => requestAnimationFrame(syncStretchLabels);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [syncStretchLabels]);
  // a row growing in place (typing into an event note, the line editor) shifts
  // every offset below it with no re-render here and no scroll event; virtua's
  // inner spacer changes height with the total, so watch that
  useEffect(() => {
    const inner = stretchOvRef.current?.parentElement?.querySelector(".tviewlist > div");
    if (!inner) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(syncStretchLabels));
    ro.observe(inner);
    return () => ro.disconnect();
  }, [syncStretchLabels, active]);
  // a primitive, not an object — a fresh-object selector re-renders forever (see CodeMenu)
  const headId = useStore((s) => (s.selection.pid === s.active ? s.selection.head : null));
  const fontSize = useStore((s) => s.ui.fontSize);
  const search = useStore((s) => s.search);
  const selectLine = useStore((s) => s.selectLine);
  const startSelection = useStore((s) => s.startSelection);
  const pushUndo = useStore((s) => s.pushUndo);
  const setSegmentRange = useStore((s) => s.setSegmentRange);
  const jump = useStore((s) => s.jump);
  const clearJump = useStore((s) => s.clearJump);
  const vref = useRef<VListHandle>(null);
  const mmRef = useRef<MinimapHandle>(null);
  const tviewRef = useRef<HTMLDivElement>(null);
  const positioning = useRef(false); // true while the effect below is moving the list itself
  const syncMinimap = () => {
    const v = vref.current;
    if (!v) return;
    // Record the tab's position only when the user owns the scroll: not before the
    // initial placement (offset 0 is inside the top headroom), and not while we're
    // positioning — during a tab switch the browser clamp-scrolls the old offset
    // against the new content, which would overwrite the new tab's saved position.
    if (positioned.has(active) && !positioning.current) {
      const index = v.findItemIndex(v.scrollOffset);
      rememberScroll(active, { index, delta: v.scrollOffset - v.getItemOffset(index) });
    }
    if (v.viewportSize) mmRef.current?.setRange(v.findItemIndex(v.scrollOffset), v.findItemIndex(v.scrollOffset + v.viewportSize));
    // Home/End (and any scroll) leave the selection behind. Rather than silently move
    // it — the selection is your place in the argument, not your place on screen — note
    // when it has gone off-screen and offer a way back.
    setSelOff(offscreenDir(v));
  };
  // Which way the selection lies, if it isn't visible. Runs on EVERY scroll event, so it
  // may not walk the selection: `Math.min(...set)` spreads it, which is O(n) per frame
  // and throws RangeError (call-stack) once a selection gets big enough. The bounds are
  // memoised off the selection instead, and this only reads them.
  const offscreenDir = (v: VListHandle): "up" | "down" | null => {
    const b = selBounds.current;
    if (!b || !v.viewportSize) return null;
    const gi = itemIdxRef.current.get(b.first) ?? -1;
    const gj = itemIdxRef.current.get(b.last) ?? gi;
    if (gi < 0) return null;
    const top = v.findItemIndex(v.scrollOffset), bot = v.findItemIndex(v.scrollOffset + v.viewportSize);
    if (gj + 1 < top) return "up";
    if (gi + 1 > bot) return "down";
    return null;
  };
  const [selOff, setSelOff] = useState<"up" | "down" | null>(null);
  // line id -> its row's index in `items`. Read from handlers that run outside
  // render (scroll, keep-in-view), so it lives in a ref as well as a memo.
  const itemIdxRef = useRef<Map<number, number>>(new Map());
  const selBounds = useRef<{ first: number; last: number } | null>(null);
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);
  // the code menu, opened by right-clicking a lane bar (same menu as the sidebar's)
  const [codeMenu, setCodeMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  const [aiPop, setAiPop] = useState<{ line: number; span: Flag; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null); // line under repair (dblclick)
  // add/edit-event modal: a prefilled time (new event) or the marker being edited
  // lid/mid ride along so the modal can anchor its card to the row it came from
  const [addEv, setAddEv] = useState<{ t: number; lid: number } | { m: Marker } | null>(null);
  const eventAt = useStore((s) => s.eventAt);
  const setEventAt = useStore((s) => s.setEventAt);
  useEffect(() => { setEditingId(null); setAiPop(null); setAddEv(null); setEventAt(null); }, [active]);

  // "After this line" as a default time: the next timed line's start − 1s, clamped
  // to the line's own start so a rapid-fire transcript can't push it before the
  // line; past the last line (or with no timecodes) fall to start + 5s, then 0.
  const openAddEvent = (g: Group) => {
    // one card at a time. The render guard (eventAt && !addEv) is the arbiter for
    // the reverse direction; this clear keeps the store honest so the dock card
    // doesn't reappear the moment this one closes.
    setEventAt(null);
    const start = tsToSec(g.ts.trim() || "") ?? 0;
    const ls = transcript?.lines ?? [];
    const i = ls.findIndex((l) => l.id === g.endId);
    const next = i >= 0 ? ls.slice(i + 1).find((l) => l.ts.trim()) : undefined;
    const nextSec = next ? tsToSec(next.ts) : null;
    setAddEv({
      t: nextSec !== null && nextSec !== undefined ? Math.max(start, nextSec - 1) : start + 5,
      lid: g.startId,
    });
  };
  const [hoverSid, setHoverSid] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // debounce clearing so moving between a segment's bars doesn't flicker the brackets
  const onLaneHover = (sid: number | null) => {
    clearTimeout(hoverTimer.current);
    if (sid === null) hoverTimer.current = setTimeout(() => setHoverSid(null), 40);
    else setHoverSid(sid);
  };

  // merged display units (singletons when the toggle is off)
  const groups = useMemo(() => mergeGroups(transcript?.lines ?? [], mergeLines, mergeGap), [transcript, mergeLines, mergeGap]);
  // speaker focus (the target button, bottom right) — per transcript. A stale
  // focus name no longer in THIS transcript is ignored rather than dimming
  // every row (a re-import can rename speakers under a stored focus).
  const focusName = ui.speakerFocus[active];
  const focusActive = useMemo(
    () => focusName && groups.some((g) => g.speaker.trim() === focusName) ? focusName : null,
    [groups, focusName]);

  // Session events, interleaved BY TIME (see markers.ts / useMarkers): each one
  // renders immediately before the first line that starts after it, so reading down
  // the transcript the clock only goes forwards. Several at once stack in time
  // order; markers past the last line go at the end. A group is one row and can't
  // be split, so a marker anchored to a line INSIDE a merged group goes AFTER the
  // group: it happened during the group's speech, and "before" would show it ahead
  // of words spoken earlier than it.
  const { placed, offset: mkOffset } = useMarkers(active);
  // A real line's timecode, so an event's time is printed in the transcript's own
  // shape ("01:20", not "0:01:20") — the two clocks must look like one clock.
  const tsSample = useMemo(
    () => transcript?.lines.find((l) => l.ts.trim())?.ts, [transcript]);
  const items = useMemo<Item[]>(() => {
    if (!placed.before.size && !placed.tail.length) return groups.map((g) => ({ kind: "g", g }));
    const out: Item[] = [];
    for (const g of groups) {
      for (const m of placed.before.get(g.startId) ?? []) out.push({ kind: "m", m });
      out.push({ kind: "g", g });
      for (const id of g.ids) if (id !== g.startId)
        for (const m of placed.before.get(id) ?? []) out.push({ kind: "m", m });
    }
    for (const m of placed.tail) out.push({ kind: "m", m });
    return out;
  }, [groups, placed]);
  const itemIdx = useMemo(() => {
    const m = new Map<number, number>();
    items.forEach((it, i) => { if (it.kind === "g") for (const id of it.g.ids) m.set(id, i); });
    return m;
  }, [items]);
  itemIdxRef.current = itemIdx; // syncMinimap and keep-in-view run outside render

  // min/max of the selection, walked ONCE when it changes rather than on every scroll
  useEffect(() => {
    if (!selLines?.size) { selBounds.current = null; setSelOff(null); return; }
    let first = Infinity, last = -Infinity;
    for (const id of selLines) { if (id < first) first = id; if (id > last) last = id; }
    selBounds.current = { first, last };
    const v = vref.current;
    // the selection may already be off-screen (e.g. a tab switch restored an offset that
    // doesn't include it). But when keep-in-view owns the head — positioned, no pending
    // jump — it's about to pull the head back, so don't flash the button on the way there.
    if (v) setSelOff(positioned.has(active) && !jump ? null : offscreenDir(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selLines, groups, active]);

  // A scaled wheel write can be one frame in flight when a navigation lands; cancel it
  // so the navigation isn't overwritten. Every navigation entry point calls this first.
  // The wheel itself is no longer this view's business: one document-level handler
  // scales every scrolling surface in the app (src/scrollSpeed.ts), because the
  // Settings knob reaching only the transcript was the bug.
  const stopAnims = stopScrollAnim;

  // scroll the selection back into view — the way home after Home/End
  const backToSelection = () => {
    const st = useStore.getState();
    if (st.selection.pid !== active || !st.selection.lines.size) return;
    const first = Math.min(...st.selection.lines);
    const gi = itemIdx.get(first);
    if (gi === undefined) return;
    stopAnims();
    vref.current?.scrollToIndex(gi + 1, { align: "center" }); // +1 for the top vpad
  };

  // AI marks for this transcript, but only where the line still reads as it did when
  // it was scanned — a correction invalidates its own marks, for free. With notices
  // hidden (the eye toggle: read/code blind), only transcription flags remain.
  const aiFlags = useStore((s) => s.aiFlags);
  const showNotices = useStore((s) => s.ui.showNotices);
  const hiddenLenses = useStore((s) => s.ui.hiddenLenses);
  const flagsByLine = useMemo(() => {
    const m = new Map<number, Flag[]>();
    for (const l of transcript?.lines ?? []) {
      const f = aiFlags[`${active}:${l.id}`];
      if (!f || !f.spans.length || f.hash !== hashLine(l.text)) continue;
      // noticings hide wholesale (the eye) or per lens (the eye's dropdown);
      // transcription errors have their own dropdown entry and IGNORE the eye —
      // hiding "AI noticings" to read blind shouldn't also hide repair marks
      const spans = f.spans.filter((s) => {
        const lens = spanLens(s);
        if (lens === "transcription") return !hiddenLenses.includes("transcription");
        return showNotices && !hiddenLenses.includes(lens);
      });
      if (spans.length) m.set(l.id, spans);
    }
    return m;
  }, [aiFlags, transcript, active, showNotices, hiddenLenses]);

  // The mark popover holds a SNAPSHOT of its span — close it when that span is no
  // longer in the flag set (a scan finished and replaced the flags, an undo, the
  // notices eye-toggle), or Apply/Dismiss would act on a superseded mark.
  useEffect(() => {
    if (aiPop && !flagsByLine.get(aiPop.line)?.includes(aiPop.span)) setAiPop(null);
  }, [flagsByLine, aiPop]);

  // Click on an AI mark → its popover. Delegated on the list container: the marks
  // live inside virtualized rows, so per-mark state wiring would thread through
  // every Row; the spans instead carry a data-ai="line:index" key into flagsByLine.
  const onAiClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.<HTMLElement>("[data-ai]");
    if (!el || e.altKey) return; // alt-click is the dismiss shortcut, handled on the span
    const [lid, k] = (el.getAttribute("data-ai") ?? "").split(":").map(Number);
    const span = flagsByLine.get(lid)?.[k];
    if (!span) return;
    const r = el.getBoundingClientRect();
    // the SAME mark toggles its popover closed (its mousedown is ignored by
    // the popover's dismiss, so this click is the one deciding)
    setAiPop((cur) => cur && cur.span === span ? null : { line: lid, span, x: r.left, y: r.bottom + 6 });
  };

  // Scroll headroom, VS Code's `scrollBeyondLastLine` but on both ends: a pad of
  // (viewport − one row) lets ANY line be pulled to the top or the bottom of the
  // screen, so the first and last lines get coded under the same conditions as the
  // middle — same room for the anchored command palette, same reading position.
  // Measured, not a constant: it has to track the viewport and the row height.
  // null = not measured yet — a genuinely short viewport also measures to exactly
  // MIN_PAD, so the value alone can't tell "small" from "not laid out".
  const [pad, setPad] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = tviewRef.current;
    if (!el) return;
    // One unwrapped row's worth is kept visible (ROW_RATIO · fontSize). Deliberately
    // NOT measured from a rendered row: row heights vary with wrapping, and the row at
    // the top depends on the scroll position the pad itself sets — that feeds back and
    // never settles.
    const measure = () => setPad(Math.max(MIN_PAD, Math.round(el.clientHeight - fontSize * ROW_RATIO)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fontSize]);

  // Position the list whenever the active tab (or the pad geometry) changes: restore
  // the tab's remembered offset, or park a first-time tab on line 1 — scroll offset 0
  // is now a screen of empty headroom. Two things make this fiddly, and both are why
  // this sets scrollTop on the scroller rather than calling scrollToIndex:
  //   - virtua's scrollToIndex is a no-op until it has measured the list (after mount);
  //   - the browser clamps scrollTop to the scrollable height, and until virtua has
  //     rendered the bottom pad the list isn't tall enough, so an early set lands short.
  // So: attempt, check whether it took, and retry on a self-driven rAF chain (a short
  // transcript barely re-renders, so per-render retries would never fire). If the
  // scroll moves in a way we didn't cause, the user grabbed it — their position wins.
  useEffect(() => {
    if (pad === null) return;             // container not laid out yet; the pad is a guess
    if (useStore.getState().jump) return; // a Browse -> line jump owns the position
    // a scaled wheel write still in flight would land against the PREVIOUS tab's
    // position, overwrite the restore below, and (worse) get recorded as the new
    // tab's saved scroll
    stopAnims();
    positioning.current = true;
    // One frame so the swapped-in children are committed, then let virtua do the
    // scrolling: its scrollToIndex re-evaluates the target after every row
    // measurement until it goes quiet, which is exactly what an anchor needs on a
    // list whose heights above the anchor are still estimates. (A raw scrollTop
    // set can't do this — it chases stale estimates and fights the re-measuring.)
    const raf = requestAnimationFrame(() => {
      const v = vref.current;
      const anchor = savedScroll[active];
      if (v && anchor) v.scrollToIndex(anchor.index, { align: "start", offset: anchor.delta });
      else if (v) v.scrollToIndex(1, { align: "start" }); // first showing: park on line 1
      positioned.add(active);
      positioning.current = false;
    });
    return () => { cancelAnimationFrame(raf); positioning.current = false; };
  }, [active, pad]);

  // With a viewport-sized top pad, offset 0 is a blank screen: "the top" now means
  // the first line parked at the top of the viewport, which is index 1 (0 = the pad).
  const toTop = () => { stopAnims(); vref.current?.scrollToIndex(1, { align: "start" }); };
  // align "end" alone parks the last line exactly at the viewport bottom — which is
  // where the floating hotbar dock sits, so End left it occluded. Overshoot by the
  // dock's current height (collapsed docks measure small, which is right) plus a gap.
  const toBottom = () => {
    const dock = document.querySelector(".hotbar")?.getBoundingClientRect().height ?? 64;
    stopAnims();
    vref.current?.scrollToIndex(items.length, { align: "end", offset: dock + 8 });
  };

  // Open the selected line's AI-mark popover; called again (M — from the list or
  // forwarded by the open popover) it advances to the line's next mark and wraps.
  // Returns whether it acted, so callers only preventDefault when it did.
  const cycleMarkPopover = (): boolean => {
    const sel = useStore.getState().selection;
    if (sel.pid !== active || sel.head === null) return false;
    const g = groups.find((x) => sel.head! >= x.startId && sel.head! <= x.endId);
    if (!g) return false;
    const all: { line: number; span: Flag; idx: number }[] = [];
    for (const l of g.lines)
      (flagsByLine.get(l.id) ?? []).forEach((span, idx) => all.push({ line: l.id, span, idx }));
    if (!all.length) return false;
    const at = aiPop ? all.findIndex((m) => m.span === aiPop.span) : -1;
    const next = all[(at + 1) % all.length];
    // anchor at the mark's rendered span; fall back to the row if virtua
    // hasn't got it on screen
    const mk = tviewRef.current?.querySelector<HTMLElement>(`[data-ai="${next.line}:${next.idx}"]`)
      ?? document.getElementById(`trow-${g.startId}`);
    const r = mk?.getBoundingClientRect();
    setAiPop({ line: next.line, span: next.span, x: r?.left ?? 100, y: (r?.bottom ?? 100) + 6 });
    return true;
  };

  // The ONLY way into a selection used to be onMouseDown on a row: arrow keys are
  // gated on a selection already existing, so a keyboard user could never make the
  // first one — and the digit hotkeys, the whole point of the app, stayed forever
  // out of reach. The list is now a tab stop, and the first arrow press seeds a
  // selection from the top VISIBLE line (not line 1 — you'd lose your place in a
  // 3000-line transcript). Once a selection exists, App's global handler drives it.
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The inline line editor is a textarea INSIDE this list, so its keys bubble
    // here. Seeding a selection off them would steal the caret from someone typing.
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
    // Enter = play from the selected line. The per-row timecode buttons are out of
    // the Tab order (tabbing through every rendered row was a wall of stops), so
    // the selected line carries the keyboard path to "play from here".
    if (e.key === "Enter" && e.target === e.currentTarget) {
      const sel = useStore.getState().selection;
      if (sel.pid === active && sel.head !== null) {
        const g = groups.find((x) => sel.head! >= x.startId && sel.head! <= x.endId);
        if (g) { e.preventDefault(); seekVideo(g.ts); }
      }
      return;
    }
    // M: the keyboard route to the AI-mark popover — the marks themselves are
    // deliberately not tab stops (per-row stops were a wall). Opens the selected
    // line's first mark; the POPOVER forwards further M presses back here to
    // cycle (once it's open, focus sits inside it, so this handler can't hear M).
    if (e.key === "m" || e.key === "M") {
      if (cycleMarkPopover()) e.preventDefault();
      return;
    }
    // E: add an event after the selected line — the keyboard twin of right-click
    if (e.key === "e" || e.key === "E") {
      const sel = useStore.getState().selection;
      if (sel.pid !== active || sel.head === null) return;
      const g = groups.find((x) => sel.head! >= x.startId && sel.head! <= x.endId);
      if (g) { e.preventDefault(); openAddEvent(g); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const s = useStore.getState();
    if (s.selection.pid === active && s.selection.lines.size) return; // App moves it from here
    const v = vref.current;
    if (!v || !items.length) return;
    e.preventDefault();
    // App's window handler also listens for arrows. It runs AFTER this one (window is
    // above the list in the bubble path) and would see the selection we just made and
    // immediately advance it — so the first press would silently skip a line. This
    // keypress seeds; the next one moves.
    e.stopPropagation();
    // -1: the top vpad is item 0. The top row may be a marker, which has no line to
    // select — walk down to the first real one (and back up if the list ends in markers).
    const at = Math.min(items.length - 1, Math.max(0, v.findItemIndex(v.scrollOffset) - 1));
    const seed = items.slice(at).find((it) => it.kind === "g")
      ?? [...items.slice(0, at)].reverse().find((it) => it.kind === "g");
    if (!seed || seed.kind !== "g") return;
    s.pushSelUndo(); // coalesces with a run of arrow presses
    s.startSelection(seed.g.startId);
  };

  // Browse -> jump: scroll the virtualized list to the unit containing the line.
  // Waits for the measured pad (jump stays pending): on a fresh mount the top pad is
  // still the 48px placeholder, and jumping first means the pad's growth afterwards
  // shoves the content down under an unchanged scrollTop.
  useEffect(() => {
    if (pad === null || !jump || jump.pid !== active || !transcript) return;
    const idx = itemIdx.get(jump.line);
    if (idx !== undefined) { stopAnims(); vref.current?.scrollToIndex(idx + 1, { align: "center" }); } // +1 for the top vpad
    positioned.add(active); // the jump IS this tab's position; scrolls from here are the user's
    clearJump();
  }, [jump, active, transcript, itemIdx, clearJump, pad]);

  // Keep the moving end of the selection on screen. Without this, arrowing past the
  // viewport edge walks the selection off-screen and the keyboard user is coding
  // blind. Only scrolls when the head is actually outside the visible range, so a
  // mouse drag inside the viewport doesn't jerk the list around.
  useEffect(() => {
    const v = vref.current;
    if (headId === null || !v || !v.viewportSize) return;
    // A pending Browse jump, or a tab whose saved scroll hasn't been restored yet, both
    // want to own the scroll position. Following the selection head on top of either
    // would yank the list straight back off the target.
    if (jump || !positioned.has(active)) return;
    const gi = itemIdxRef.current.get(headId);
    if (gi === undefined) return;
    const idx = gi + 1; // +1 for the top vpad
    const first = v.findItemIndex(v.scrollOffset);
    const last = v.findItemIndex(v.scrollOffset + v.viewportSize);
    // Bottom edge is treated symmetrically with the top — no hotbar offset: the dock
    // resizes (collapsed->expanded) the moment a selection exists, and keying the scroll
    // to its height fights that change.
    if (idx <= first) { stopAnims(); v.scrollToIndex(idx, { align: "start" }); }
    else if (idx >= last) { stopAnims(); v.scrollToIndex(idx, { align: "end" }); }
    // headId ONLY: follow the selection when it MOVES. groups was a dep once, but
    // any transcript edit (applying an AI fix included) rebuilds it, and the re-run
    // yanked the view back to a selection you had deliberately scrolled away from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headId]);

  // Speak the selection as it moves. The listbox exposes the head via
  // aria-activedescendant (line 590), which NVDA/JAWS read — but Narrator's support for
  // activedescendant is unreliable and often silent, so pipe it through the live region
  // too. Cost: NVDA/JAWS then hear it twice; acceptable until they're tested.
  // One line: "selected|not selected, speaker, text, time". Many: "N selected" then
  // speaker + text for every selected line (no time). Full speaker label always — short
  // mode is a visual abbreviation, no use to a listener. (line.speaker is the full label.)
  useEffect(() => {
    const lines = transcript?.lines;
    if (headId === null || !lines) return;
    const at = (id: number) => lines.find((l) => l.id === id);
    // AI marks on a line, spoken after it: non-transcription notices as their type
    // (the lens label), transcription errors as "possible transcript errors:" plus the
    // note the tooltip shows. flagsByLine already honours the notices-hidden toggle.
    const marks = (id: number) => {
      const fs = flagsByLine.get(id);
      if (!fs?.length) return "";
      const notices = [...new Set(fs.filter((f) => spanLens(f) !== "transcription")
        .map((f) => lensOf(spanLens(f))?.label ?? spanLens(f)))];
      const errs = fs.filter((f) => spanLens(f) === "transcription").map((f) => f.reason);
      const out: string[] = [];
      if (notices.length) out.push(notices.join(", "));
      if (errs.length) out.push(`possible transcript errors: ${errs.join(", ")}`);
      return out.length ? `, ${out.join(", ")}` : "";
    };
    const count = selLines?.size ?? 0;
    if (count > 1 && selLines) {
      const parts = [...selLines].sort((a, b) => a - b)
        .map((id) => { const l = at(id); return l ? `${l.speaker.trim()}, ${l.text}${marks(id)}` : null; })
        .filter(Boolean);
      announce(`${count} selected, ${parts.join(", ")}`);
    } else {
      const l = at(headId);
      if (l) announce(`${selLines?.has(headId) ? "selected" : "not selected"}, ${l.speaker.trim()}, ${l.text}, ${l.ts}${marks(headId)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headId, selLines]);

  // sync the minimap viewport box on mount and whenever the list content changes
  useEffect(() => { const id = requestAnimationFrame(syncMinimap); return () => cancelAnimationFrame(id); });

  // PageUp/PageDown/Home/End scroll the transcript list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const v = vref.current;
      if (!v) return;
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        stopAnims();
        v.scrollBy((e.key === "PageDown" ? 0.9 : -0.9) * v.viewportSize);
      }
      // Home/End mean first/last LINE, not the ends of the scrollable area — those
      // are now a screen of empty headroom.
      else if (e.key === "Home") { e.preventDefault(); toTop(); }
      else if (e.key === "End") { e.preventDefault(); toBottom(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  // lane assignment for the active transcript (greedy interval graph)
  // rejected segments stay in the lanes (styled distinctly) so they can be re-accepted
  const laned = useMemo(
    () => laneAssign(segments.filter((s) => s.pid === active)),
    [segments, active]
  );
  // reserve 5 lanes; grow past that so text contracts instead of the strip scrolling
  const cols = Math.max(5, laned.reduce((m, s) => Math.max(m, s.lane + 1), 0));

  // close-call segments: the excerpt rule's losing speaker held >=40% of chars
  // (mixed-substance flag, surfaced while coding — CODING-APP-DEV.md W7 item 18)
  const closeCallSids = useMemo(() => {
    const set = new Set<number>();
    const lines = transcript?.lines ?? [];
    for (const s of laned) {
      const range = lines.filter((l) => l.id >= s.start && l.id <= s.end).map((l) => ({ text: l.text, speaker: l.speaker }));
      if (excerptOf(range).closeCall) set.add(s.sid);
    }
    return set;
  }, [laned, transcript]);

  // drag a segment edge to another unit (elementFromPoint -> that unit's boundary line id)
  const dragEdge = (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => {
    e.preventDefault(); e.stopPropagation();
    // snapshot lazily, on the first REAL change: the grips overlap the bar's edge, so
    // a plain click (open the popover) lands here too — an unconditional pushUndo
    // killed the redo stack and pushed a no-op undo entry for every such click
    let snapped = false;
    const apply = (start: number, end: number) => {
      if (!snapped) { snapped = true; pushUndo(); }
      setSegmentRange(seg.sid, start, end);
    };
    const move = (ev: globalThis.MouseEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(".lineRow") as HTMLElement | null;
      if (!row?.dataset.lid) return;
      const gs = +row.dataset.lid, ge = +(row.dataset.end ?? row.dataset.lid);
      // (snapped ||) — once a drag began, coming back to the original line must
      // still apply, to restore the original bounds
      if (which === "start" && gs <= seg.end && (snapped || gs !== seg.start)) apply(gs, seg.end);
      if (which === "end" && ge >= seg.start && (snapped || ge !== seg.end)) apply(seg.start, ge);
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // click selects; click+drag selects a range (Shift extends, Ctrl toggles — no drag)
  const onRowDown = (e: MouseEvent, id: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".lanes,.ts,.lineEdit")) return;
    // A press on an AI mark belongs to the mark (its click opens the popover, or
    // alt-click dismisses) — selecting here would trigger a keep-in-view scroll
    // that fights the popover. Bailing HERE rather than stopPropagation on the
    // span keeps the mousedown visible to document-level closers (an open code
    // menu / segment popover must still close on this press).
    if ((e.target as HTMLElement).closest("[data-ai]")) return;
    if (e.detail > 1) return; // second press of a double-click: that's an edit, not a re-select
    const st = useStore.getState();
    // open the gesture BEFORE any mutation — a click and a whole drag are one undo step
    st.pushSelUndo();
    if (e.shiftKey) { selectLine(id, { extend: true }); st.endSelGesture(); return; }
    if (e.ctrlKey || e.metaKey) { selectLine(id, { toggle: true }); st.endSelGesture(); return; }
    let moved = false;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: globalThis.MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; startSelection(id); }
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(".lineRow") as HTMLElement | null;
      if (row?.dataset.lid) selectLine(+row.dataset.lid, { extend: true });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (!moved) selectLine(id); // plain click (toggles off if already the sole selection)
      // close the undo gesture: a whole click-or-drag is ONE step, and the next one
      // starts a new entry rather than coalescing into this one
      useStore.getState().endSelGesture();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  if (!transcript) {
    return <div className="empty">Import transcript CSVs to begin (Import files).</div>;
  }

  // uniform column widths sized to the longest displayed label in this transcript
  const shorts = shortLabels([...new Set(transcript.lines.map((l) => l.speaker.trim()))]);
  const spkLabel = (s: string) => speakerNames === "short" ? shorts[s.trim()] ?? s.trim() : s.trim();
  // MEASURED, not counted in `ch`: the chip's font is proportional and bold, so
  // "Interviewer" is far wider than 11 digit-widths — a ch-based min-width let the
  // longest chips overflow and shove the text column right, one indent per name
  // length. Measuring the real glyphs is what keeps every row's text on one edge.
  const spkWidth = measureSpk(transcript.lines.map((l) => spkLabel(l.speaker)), fontSize);
  const lidChars = groups.reduce((m, g) => Math.max(m, lidLabel(g).length), 1);
  const lidWidth = `${Math.max(2, lidChars)}ch`;

  // bracket the hovered (or popover-open) segment's first/last lines
  const activeSid = hoverSid ?? pop?.sid ?? null;
  const hlSeg = activeSid !== null ? laned.find((s) => s.sid === activeSid) : undefined;
  // fallback must be 6-digit: an "a6" alpha suffix is appended below
  const hl = hlSeg ? { start: hlSeg.start, end: hlSeg.end, color: codebook[hlSeg.code]?.color || "#999999" } : null;

  return (
    <>
      <div className="tview" ref={tviewRef} onClick={onAiClick}>
      {/* A plain focusable region, deliberately NOT an ARIA listbox. A focused listbox
          narrates its own selected option (in DOM order, AI-highlight markup and all) on
          every move — which double-spoke over, and fought the order of, our own live
          region. The widget contract and a custom narration can't coexist, and only the
          live region can express our order + the AI marks + a whole multi-line selection.
          So the selection-announce effect above is the single, consistent voice; the rows
          drop role=option/aria-selected for the same reason. */}
      <VList ref={vref} className="tviewlist" onScroll={() => { syncMinimap(); syncStretchLabels(); }}
        tabIndex={0} onKeyDown={onListKeyDown}
        aria-label={`Transcript ${active}. Press the down arrow to select a line, 1 to 9 to apply a code, Enter to play from the selected line, M to review the selected line's AI observations.`}
        style={{ height: "100%", flex: 1, minWidth: 0, fontSize, "--spk-w": spkWidth, "--lid-w": lidWidth, "--lane-w": `${LANE_W[laneWidth]}px` } as CSSProperties}>
        {[
          <div className="vpad vpad-top" key="vpad-top" style={{ height: pad ?? MIN_PAD }} />, // headroom before the first line
          ...items.map((it) => it.kind === "m" ? (
            <MarkerRow key={`m${it.m.mid}`} marker={it.m} offset={mkOffset}
              tsSample={tsSample} colors={ui.markerColors} showLid={showLineNumbers}
              stretchW={stretchCtx?.width} onEdit={() => setAddEv({ m: it.m })} />
          ) : (
            <Row
              key={`g${it.g.startId}`}
              group={it.g}
              selected={it.g.ids.some((id) => selLines?.has(id))}
              spkOff={focusActive && focusActive !== it.g.speaker.trim()
                ? (ui.focusDim ? " spk-off-dim" : "") + (ui.focusCollapse ? " spk-off-collapse" : "")
                : ""}
              cols={cols}
              laned={laned}
              codebook={codebook}
              onRowDown={(e) => onRowDown(e, it.g.startId)}
              stretchCtx={stretchCtx}
              // right-click: with a selection under the cursor it is the
              // stretch gesture; bare, it stays "add an event here"
              onRowContext={(e) => {
                const st = useStore.getState();
                const sel = st.selection.pid === active ? st.selection.lines : null;
                if (sel?.size && it.g.ids.some((id) => sel.has(id))) {
                  setStretchMenu({ x: e.clientX, y: e.clientY,
                    start: Math.min(...sel), end: Math.max(...sel), addAfter: it.g });
                } else openAddEvent(it.g);
              }}
              onLaneClick={(seg, e) =>
                // clicking the segment's own lane while its popover is open closes it
                // (useDismiss ignores this lane, so the mousedown doesn't close-then-reopen)
                setPop((p) => p && p.sid === seg.sid ? null : { sid: seg.sid, x: e.clientX, y: e.clientY })}
              onLaneMenu={(seg, e) => {
                setPop(null); // one popover at a time — the code menu takes over
                setCodeMenu({ code: seg.code, x: e.clientX, y: e.clientY });
              }}
              onGripDown={dragEdge}
              onLaneHover={onLaneHover}
              hl={hl}
              closeCallSids={closeCallSids}
              warnCls={warnCls}
              lanePattern={lanePattern}
              spkColor={speakerColor(ui, it.g.speaker)}
              weight={weightOf(ui, it.g.speaker)}
              showLid={showLineNumbers}
              speakerNames={speakerNames}
              shortName={shorts[it.g.speaker.trim()] ?? it.g.speaker.trim()}
              searchQuery={search.query}
              current={search.current}
              editingId={editingId}
              onEditStart={setEditingId}
              onEditEnd={() => setEditingId(null)}
              flagsByLine={flagsByLine}
              nextTsOf={(id) => {
                const ls = transcript.lines;
                const i = ls.findIndex((l) => l.id === id);
                return i >= 0 && i + 1 < ls.length ? ls[i + 1].ts : null;
              }}
            />
          )),
          <div className="vpad vpad-bot" key="vpad-bot" style={{ height: pad ?? MIN_PAD }} />, // headroom after the last line
        ]}
      </VList>
      <Resizer side="right" onWidth={(w) => setUi({ minimapWidth: clampMinimapWidth(w) })} />
      <Minimap ref={mmRef} items={items} laned={laned} cols={cols} codebook={codebook}
        closeCallSids={closeCallSids} flagsByLine={flagsByLine}
        detail={minimapDetail} ui={ui} vref={vref} onNav={stopAnims}
        stretches={stretchCtx?.list ?? []} stretchDimList={stretchCtx?.dims ?? []} />
        {selOff && (
          <button className={`backtosel ${selOff}`} onClick={backToSelection}
            style={{ fontSize: ui.sidebarFontSize }} aria-label="Scroll back to your selected line(s)">
            <Icon name={selOff === "up" ? "arrow-up" : "arrow-down"} size={ui.sidebarFontSize + 2} /> return
          </button>
        )}
      <SpeakerFocus active={active} groups={groups} />
      </div>
      {addEv && <AddEventModal pid={active} defaultT={"t" in addEv ? addEv.t : 0}
        marker={"m" in addEv ? addEv.m : undefined} tsSample={tsSample}
        anchorSel={"m" in addEv ? `#mrow-${addEv.m.mid}` : `#trow-${addEv.lid}`}
        onClose={() => {
          setAddEv(null);
          // hand focus back to the list (it would fall to <body>), like the palette
          document.querySelector<HTMLElement>(".tviewlist")?.focus();
        }} />}
      {/* the same card, asked for from the video dock (Mark) or E with nothing
          selected — anchored to the dock, since that is where you were looking */}
      {eventAt !== null && !addEv && <AddEventModal pid={active} defaultT={eventAt} tsSample={tsSample}
        anchorSel=".vdock" onClose={() => {
          setEventAt(null);
          document.querySelector<HTMLElement>(".tviewlist")?.focus();
        }} />}
      {pop && <SegmentPopover sid={pop.sid} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
      {codeMenu && <CodeMenu code={codeMenu.code} x={codeMenu.x} y={codeMenu.y}
        onClose={() => setCodeMenu(null)} />}
      <div className="stretchLabels" ref={stretchOvRef} aria-hidden="true" />
      {stretchMenu && (
        <StretchMenu x={stretchMenu.x} y={stretchMenu.y} start={stretchMenu.start} end={stretchMenu.end}
          pid={active} onAddEvent={() => openAddEvent(stretchMenu.addAfter)}
          onClose={() => setStretchMenu(null)} />
      )}
      {aiPop && <AiMarkPopover pid={active} line={aiPop.line} span={aiPop.span}
        x={aiPop.x} y={aiPop.y} onClose={() => setAiPop(null)} onCycle={cycleMarkPopover} />}
    </>
  );
}

// A session event, in its own row between the lines. It reads in the transcript's
// own column order — timecode, then who/what it is, then the words — so the eye
// keeps its two anchors while the row itself stays unmistakably not-an-utterance:
// full width, its own colour, no speaker chip and no lane strip. The text sizes
// with the transcript (it IS reading matter), the chrome around it does not.
//
// The text is editable in place (a field note is a first draft), and the row can be
// deleted; both go through the undo stack.
//
// The timecode plays from the moment the note was made: the marker's time is on the
// video clock, so it goes back through the dock's offset to reach a line time — the
// same conversion anchorMarkers uses, in the same direction.
function MarkerRow({ marker, offset, tsSample, colors, showLid, stretchW, onEdit }: {
  marker: Marker; offset: number;
  tsSample: string | undefined;          // a real line's timecode, to copy its shape
  colors: Record<string, string>;        // chosen event-type colours (ui.markerColors)
  /** section-gutter width: the card's CONTENT starts past the lanes while its
      coloured border stays at the row's own edge */
  stretchW?: string;
  showLid: boolean;                      // line numbers on: pad so the chips still line up
  onEdit: () => void;                    // open the add-event modal on this event
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(marker.label);
  // The box opens at the note's real height and grows as it's typed. rows={1}
  // alone showed a one-line slot with the rest of a long note scrolled out of
  // sight (the CSS hides the overflow), so editing meant hunting for text that
  // was already there.
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto"; // measure from scratch, or shrinking never happens
    // scrollHeight is the PADDING box; the element is border-box, so the borders
    // have to be added back or the last line stays 2px under the edge
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [editing, value]);
  const key = markerKey(marker);
  const color = markerColor(key, colors);
  const lineTs = fmtLike(marker.t - offset, tsSample);
  const save = () => {
    useStore.getState().editMarker(marker.mid, value.trim());
    setEditing(false);
  };
  return (
    // --spk-c is what the transcript's timecode chip tints itself from; pointing it
    // at the event colour gives this row the SAME chip, in its own hue, for free.
    // One line, in the transcript's own column rhythm — timecode, then words.
    // The chip shares the line rows' left edge in BOTH cases: gutterless via the
    // matching 4px bar + 16px padding, guttered via lanes' width + the same 8px
    // the line rows' flex gap adds after their cell.
    // The lid spacer matches theirs when line numbers are on.
    // The type only shows when there's no note to show:
    // colour carries the type the rest of the time. The row is real selectable text
    // (user-select in the CSS), so Ctrl+C copies the note like anything else.
    //
    // Right-click anywhere on the row recolours the TYPE (every event of it) — the
    // gesture the codebook swatches use; the textarea keeps its native menu.
    <div className="markerRow" id={`mrow-${marker.mid}`}
      // full-width on purpose: the event's coloured border belongs at the
      // row's own edge; the gutter's lead-in keeps labels clear of it, and a
      // pill floating over the card's tint reads fine (it is solid)
      style={{ "--mk-c": color, "--spk-c": color,
        ...(stretchW ? { paddingLeft: `calc(${stretchW} + 8px)` } : {}) } as CSSProperties}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".mkedit")) return;
        e.preventDefault(); e.stopPropagation();
        openColorPicker(color, (v) => useStore.getState().setMarkerColor(key, v),
          { x: e.clientX, y: e.clientY });
      }}>
      {showLid && <span className="lid" aria-hidden="true" />}
      <button className="ts" tabIndex={-1} title="Play from here"
        onClick={() => seekVideo(lineTs)}>{lineTs}</button>
      {editing ? (
        <textarea className="mkedit" rows={1} autoFocus value={value} ref={taRef}
          aria-label={`Edit event note at ${lineTs}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
            // Esc restores the stored text: an event note is a record of what was
            // observed, so an abandoned edit must leave no trace
            else if (e.key === "Escape") { e.stopPropagation(); setValue(marker.label); setEditing(false); }
          }}
          onBlur={save} />
      ) : (
        <span className="mklabel" onDoubleClick={() => { setValue(marker.label); setEditing(true); }}
          title="Double-click to edit">
          {/* no note yet: the TYPE stands in as the text, not a "(no text)" shrug —
              it's what the hotkey recorded, and the only honest thing to show.
              Bracketed italics say "stand-in", not the note's own words. */}
          {marker.label || <em className="mkkey">({key})</em>}
        </span>
      )}
      {/* full edit (time/type/text) in the same modal that adds one; dblclick on
          the text stays the quick path for the note alone */}
      <button className="mkdel mkeditbtn" aria-label={`Edit event at ${lineTs}`}
        title="Edit this event" onClick={onEdit}>
        <Icon name="pencil" size={14} />
      </button>
      <button className="mkdel" aria-label={`Delete event at ${lineTs}${marker.label ? `: ${marker.label}` : `: ${key}`}`}
        title="Delete this event" onClick={() => useStore.getState().deleteMarker(marker.mid)}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

// The mark-stretch menu: right-click on a selection. One form, two lists —
// what to mark these lines as (dimension + value, both remembering what the
// project already uses), and what already covers them, unmarkable in place.
function StretchMenu({ x, y, start, end, pid, onAddEvent, onClose }: {
  x: number; y: number; start: number; end: number; pid: string;
  onAddEvent: () => void; onClose: () => void;
}) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const stretches = useStore((s) => s.stretches);
  // suggestions come from THIS transcript's dimensions first — the gutter the
  // menu is standing in — never pre-filling another participant's axis
  const dims = stretchDims(stretches.filter((s2) => s2.pid === pid));
  const allDims = stretchDims(stretches);
  const [dim, setDim] = useState(dims[0] ?? allDims[0] ?? "condition");
  const [value, setValue] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  useClampToViewport(ref, [x, y]);
  const values = [...new Set(stretches.filter((s2) => s2.dim === dim.trim()).map((s2) => s2.value))];
  const here = stretches.map((st, i) => ({ st, i }))
    .filter(({ st }) => st.pid === pid && st.start <= end && st.end >= start);
  const mark = () => {
    const d = dim.trim() || "condition", v = value.trim();
    if (!v) return;
    useStore.getState().markStretch({ pid, start, end, dim: d, value: v });
    announce(`Lines ${start}–${end} marked ${d}: ${v}`);
    onClose();
  };
  return (
    <div ref={ref} className="ctxmenu stretchMenu" role="dialog" aria-label="Mark these lines"
      style={{ left: x, top: y, fontSize: fs }}>
      <button role="menuitem" onClick={() => { onAddEvent(); onClose(); }}>Add event after this line</button>
      <div className="ctxdiv" />
      <div className="ctxhead">Mark lines {start}–{end} as</div>
      <div className="stForm">
        <input value={dim} onChange={(e) => setDim(e.target.value)} list="stretch-dims"
          aria-label="Dimension" placeholder="condition" />
        <datalist id="stretch-dims">{(dims.length ? dims : allDims).map((d) => <option key={d} value={d} />)}</datalist>
        <input value={value} onChange={(e) => setValue(e.target.value)} list="stretch-values"
          aria-label="Value" placeholder="baseline" autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") mark(); }} />
        <datalist id="stretch-values">{values.map((v) => <option key={v} value={v} />)}</datalist>
        <button className="btn primary" disabled={!value.trim()} onClick={mark}>Mark</button>
      </div>
      {here.length > 0 && <div className="ctxdiv" />}
      {here.map(({ st, i }) => (
        <button key={i} role="menuitem" className="stUnmark"
          title={`Remove this mark (lines ${st.start}–${st.end})`}
          onClick={() => { useStore.getState().unmarkStretch(i); announce(`Unmarked ${st.dim}: ${st.value}`); onClose(); }}>
          <span className="stDot" style={{ background: stretchColor(st.value) }} />
          {st.dim}: {st.value} <span className="stRange">{st.start}–{st.end}</span> ×
        </button>
      ))}
    </div>
  );
}

type StretchCtx = {
  list: Stretch[]; dims: string[]; bandPx: number; labelPx: number;
  pillW: number; leadIn: number; colW: number; width: string; widthPx: number;
};

// The stretch gutter cell: pure reserved SPACE. Bands and labels both live on
// the parent's overlay — a band drawn per row broke at event rows (a marker
// card's tint ran through it) and seamed at fractional DPI; ONE continuous
// strip per stretch has neither problem, and rides the same scroll sync as
// the sticky labels.
function StretchCell({ ctx }: { ctx: StretchCtx }) {
  return <span className="stretchCell" style={{ width: ctx.width }} aria-hidden="true" />;
}

function Row({ group, selected, spkOff, cols, laned, codebook, onRowDown, onRowContext, stretchCtx, onLaneClick, onLaneMenu, onGripDown, onLaneHover, hl, closeCallSids, warnCls, lanePattern, spkColor, weight, showLid, speakerNames, shortName, searchQuery, current, editingId, onEditStart, onEditEnd, nextTsOf, flagsByLine }: {
  group: Group;
  /** right-click on the row body — the parent decides between "add event" and
      the stretch menu (a selection is the stretch gesture's handle) */
  onRowContext: (e: MouseEvent) => void;
  stretchCtx: StretchCtx | null;
  selected: boolean;
  spkOff: string; // speaker focus: class(es) a NON-focused speaker's row carries ("" = focused/none)
  cols: number;
  laned: LanedSeg[];
  codebook: Record<string, { color: string }>;
  onRowDown: (e: MouseEvent) => void;
  onLaneClick: (seg: LanedSeg, at: { clientX: number; clientY: number }) => void;
  onLaneMenu: (seg: LanedSeg, at: { clientX: number; clientY: number }) => void;
  onGripDown: (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => void;
  onLaneHover: (sid: number | null) => void;
  hl: { start: number; end: number; color: string } | null;
  closeCallSids: Set<number>;
  warnCls: string;
  lanePattern: boolean;
  spkColor: string;
  weight: SpeakerWeight;
  showLid: boolean;
  speakerNames: "full" | "short";
  shortName: string;
  searchQuery: string;
  current: { line: number; occ: number } | null;
  editingId: number | null;
  onEditStart: (id: number) => void;
  onEditEnd: () => void;
  nextTsOf: (id: number) => string | null;
  flagsByLine: Map<number, Flag[]>;
}) {
  const { startId, endId } = group;
  const lanes = [];
  for (let i = 0; i < cols; i++) {
    const seg = laned.find((s) => s.lane === i && s.start <= endId && startId <= s.end);
    if (!seg) { lanes.push(<span key={i} className="laneEmpty" />); continue; }
    const rej = seg.status === "rejected";
    // "candidate" here, "proposed" in the Python-side contract — any unverdicted
    // status is a suggestion; only an explicit "accepted" earns the solid bar
    const cand = !rej && seg.status !== "accepted";
    const color = codebook[seg.code]?.color || "#999";
    const isStart = seg.start >= startId && seg.start <= endId;
    const isEnd = seg.end >= startId && seg.end <= endId;
    const cc = closeCallSids.has(seg.sid);
    const cls = "laneBar" + (rej ? " rejected" : cand ? " candidate" : lanePattern ? ` lp${patternOf(seg.code)}` : "")
      + (isStart ? " segStart" : "") + (isEnd ? " segEnd" : "");
    // rejected: an empty husk — NO fill, just a faint outline of the code colour
    // where the segment used to be. Reads as "hollowed out" against accepted's
    // solid fill and candidate's pale fill; the fill-vs-no-fill contrast is the
    // non-hue channel, so it survives any palette and both themes.
    // draw top/bottom only on the segment's first/last line so a multi-line reject
    // reads as one continuous outline instead of per-line notches.
    //
    // "Faint" via color-mix against --bg, NEVER alpha: these bars take part in the
    // 1px fractional-DPI seam bleed, and a translucent paint can't tile — the
    // overlap doubles its alpha into a darker join line, while skipping the bleed
    // leaves the DPI hairline gap. An opaque flattened colour looks identical over
    // the page and paints over itself invisibly, so multi-row bars connect smoothly.
    const b = `2.5px solid color-mix(in srgb, ${color} 44%, var(--bg))`;
    // candidate (another coder's suggestion awaiting a verdict): pale fill + dashed
    // outline — "pencilled in", distinct from both solid-accepted and hollow-rejected
    // by outline style alone, so it doesn't rely on hue.
    const d = `1.5px dashed ${color}`;
    const style: CSSProperties = rej
      ? {
          // a faint diagonal hatch inside the husk — the universal "voided"
          // texture. Anchored to the VIEWPORT (background-attachment: fixed), not
          // the element: a per-element pattern restarts its phase at every row of
          // a multi-line reject and kinks at the joins; anchored, every row
          // samples the same stripes and the 1px seam overlap repaints identical
          // (opaque, see above) pixels. Trade-off: the hatch holds still while
          // the content scrolls past — a subtle shimmer, accepted for the seams.
          background: `repeating-linear-gradient(45deg, color-mix(in srgb, ${color} 22%, var(--bg)) 0 2px, transparent 2px 5px)`,
          backgroundAttachment: "fixed",
          borderLeft: b, borderRight: b,
          borderTop: isStart ? b : undefined,
          borderBottom: isEnd ? b : undefined,
        }
      : cand
      ? {
          background: `color-mix(in srgb, ${color} 22%, var(--bg))`,
          borderLeft: d, borderRight: d,
          borderTop: isStart ? d : undefined,
          borderBottom: isEnd ? d : undefined,
        }
      : { background: color };
    lanes.push(
      // a real (keyboard-reachable) control on the segment's FIRST line only: one Tab
      // stop per segment opens its popover; the continuation bars stay decorative
      <span key={i} className={cls} data-sid={seg.sid} data-tip={`${seg.code} (${seg.start}-${seg.end})${rej ? " — rejected" : ""}${cand ? ` — suggested by ${seg.proposedBy}` : ""}${cc ? " · ⚠ near-balanced speakers" : ""}`}
        style={style}
        {...(isStart ? {
          role: "button" as const, tabIndex: 0,
          "aria-label": `Segment ${seg.code}, lines ${seg.start} to ${seg.end}${rej ? ", rejected" : cand ? `, suggested by ${seg.proposedBy}` : ""}`,
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault(); e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onLaneClick(seg, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
          },
        } : {})}
        onMouseEnter={() => onLaneHover(seg.sid)} onMouseLeave={() => onLaneHover(null)}
        onClick={(e) => { e.stopPropagation(); onLaneClick(seg, e); }}
        // right-click the bar = the CODE's menu (rename, define, recolour, merge,
        // pin, delete) — the same one the sidebar opens, at the place you just
        // applied the code, so acting on it costs no hunt down the code list.
        // stopPropagation: the row's own right-click adds an event, which is not
        // what you meant when you aimed at a lane.
        onContextMenu={(e) => {
          e.preventDefault(); e.stopPropagation();
          onLaneMenu(seg, e);
        }}>
        {/* close-call (near-balanced excerpt): corner warning badge (side/size configurable) */}
        {isStart && cc && <span className={"ccbadge " + warnCls}>!</span>}
        {isStart && <span className="grip gripTop" onMouseDown={(e) => onGripDown(e, seg, "start")} />}
        {isEnd && <span className="grip gripBot" onMouseDown={(e) => onGripDown(e, seg, "end")} />}
      </span>
    );
  }
  // inset shadow brackets the hovered segment: top border on its first unit, bottom on its last
  const shadow: string[] = [];
  const bracket = `${hl?.color}a6`; // 0xa6 ≈ 65% opacity (codebook colors are #RRGGBB)
  if (hl && hl.start >= startId && hl.start <= endId) shadow.push(`inset 0 2px 0 ${bracket}`);
  if (hl && hl.end >= startId && hl.end <= endId) shadow.push(`inset 0 -2px 0 ${bracket}`);
  const merged = startId !== endId;

  return (
    <div className={"lineRow" + (weight !== "normal" ? ` spk-${weight}` : "") + spkOff + (selected ? " selected" : "") + (merged ? " merged" : "")}
      id={`trow-${startId}`}
      data-lid={startId} data-end={endId} onMouseDown={onRowDown}
      // right-click = add an event after this line. The line editor keeps its
      // native menu (paste); nothing else on a row had a use for right-click.
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".lineEdit")) return;
        e.preventDefault(); onRowContext(e);
      }}
      style={{ "--spk-c": spkColor, "--spk-ink": inkOn(spkColor), ...(shadow.length ? { boxShadow: shadow.join(",") } : {}) } as CSSProperties}>
      {stretchCtx && <StretchCell ctx={stretchCtx} />}
      {showLid && <span className="lid">{lidLabel(group)}</span>}
      {/* out of the Tab order: tabbing walked every rendered timecode. Mouse users
          click it; keyboard users press Enter on the selected line (see the list). */}
      <button className="ts" tabIndex={-1} onClick={(e) => { e.stopPropagation(); seekVideo(group.ts); }}
        title="Play from here">
        {group.ts.split(".")[0]}
      </button>
      {/* the NAME is in the chip: colour tells speakers apart at a glance, but never
          alone -- the label is always there for anyone the colour doesn't reach.
          In short mode the full name rides along visually hidden, so a screen
          reader is never stuck with the three-letter abbreviation. */}
      <span className="spk" data-tip={group.speaker}>
        {speakerNames === "short" ? shortName : group.speaker}
        {speakerNames === "short" && shortName !== group.speaker.trim() &&
          <span className="sr-only"> ({group.speaker.trim()})</span>}
      </span>
      <span className="txt">
        {group.lines.map((l, k) => (
          <Fragment key={l.id}>
            {k > 0 && " "}
            {editingId === l.id ? (
              <LineEditor line={l} nextTs={nextTsOf(l.id)} onDone={onEditEnd} />
            ) : (
              // no title= on this span: a native tip on every line is noise while reading,
              // and it would fire behind the custom tooltips on the spans inside it
              <span onDoubleClick={(e) => { e.preventDefault(); onEditStart(l.id); }}>
                {searchQuery
                  ? renderText(l.text, searchQuery, current && current.line === l.id ? current.occ : -1)
                  : flagsByLine.has(l.id)
                    ? renderFlagged(l.text, flagsByLine.get(l.id)!, l.id)
                    : l.text}
                {l.orig !== undefined && <EditMark orig={l.orig} text={l.text} />}
              </span>
            )}
          </Fragment>
        ))}
      </span>
      <span className="lanes">{lanes}</span>
    </div>
  );
}

// Inline transcription repair (dblclick a line). While open, the loaded media —
// if any — loops this utterance (a Settings toggle; the editbar button starts and
// stops it, the dock's speed control applies) so the fix is made against the audio,
// not from memory. Enter saves, Esc cancels, blur saves (it's a typo fix, losing
// it to a stray click would hurt more than keeping it).
// Widest speaker chip in this transcript, in px. Canvas measurement of the chip's
// ACTUAL font (bold, .82em of the transcript size, the app's chrome family) —
// counting characters can't align a proportional font. Capped so a runaway label
// can't eat the reading column; the chip ellipsises past the cap.
const spkCanvas = typeof document === "undefined" ? null : document.createElement("canvas");
function measureSpk(labels: string[], fontSize: number): string {
  const ctx = spkCanvas?.getContext("2d");
  const chip = fontSize * 0.82; // .lineRow .spk font-size
  if (!ctx) return `${Math.max(2.5, ...labels.map((l) => l.length))}ch`; // SSR/jsdom fallback
  ctx.font = `700 ${chip}px system-ui, Segoe UI, Roboto, sans-serif`;
  let w = chip * 2.5; // floor: a two-initial chip still reads as a chip
  for (const l of labels) w = Math.max(w, ctx.measureText(l).width);
  return `${Math.min(Math.ceil(w) + 13, chip * 14)}px`; // +13 = the chip's 6px side padding, +1 for rounding
}

// Focus one speaker's dialogue — a floating target button at the transcript's
// bottom right (the eye-menu pattern, mirrored to the bottom). PER TRANSCRIPT:
// focus is a lens on a study file, not a global. Only appears when the file
// actually has more than one speaker.
function SpeakerFocus({ active, groups }: { active: string; groups: Group[] }) {
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenu(false), []);
  useDismiss(ref, close, { enabled: menu });
  const speakers = useMemo(() => {
    const seen: string[] = [];
    for (const g of groups) { const sp = g.speaker.trim(); if (sp && !seen.includes(sp)) seen.push(sp); }
    return seen;
  }, [groups]);
  if (speakers.length < 2) return null;
  const focus = ui.speakerFocus[active];
  const setFocus = (sp: string | null) => {
    const next = { ...ui.speakerFocus };
    if (sp) next[active] = sp; else delete next[active];
    setUi({ speakerFocus: next });
  };
  return (
    <div className="focuswrap" ref={ref}>
      {menu && (
        <div className="focusmenu" role="group" aria-label="Focus one speaker's dialogue"
          style={{ fontSize: ui.sidebarFontSize }}>
          <button className={"focusitem" + (!focus ? " on" : "")} onClick={() => setFocus(null)}>
            <span className="focusname">Everyone</span>{!focus && " ✓"}
          </button>
          {speakers.map((sp) => (
            <button key={sp} className={"focusitem" + (focus === sp ? " on" : "")}
              onClick={() => setFocus(focus === sp ? null : sp)}>
              <span className="lensdot" style={{ background: speakerColor(ui, sp) }} />
              <span className="focusname">{sp}</span>{focus === sp && " ✓"}
            </button>
          ))}
          {/* independent, combinable effects — dim only, collapse only, or both */}
          <div className="focusmode">
            <span>Others:</span>
            <label className="focuscheck">
              <input type="checkbox" checked={ui.focusDim}
                onChange={() => setUi({ focusDim: !ui.focusDim })} /> dim
            </label>
            <label className="focuscheck">
              <input type="checkbox" checked={ui.focusCollapse}
                onChange={() => setUi({ focusCollapse: !ui.focusCollapse })} /> collapse
            </label>
          </div>
        </div>
      )}
      <button className={"focustoggle" + (focus ? " on" : "")} onClick={() => setMenu((m) => !m)}
        aria-expanded={menu} aria-haspopup="menu" aria-pressed={!!focus}
        aria-label={focus ? `Focused on ${focus} — change or clear` : "Focus one speaker's dialogue"}
        title={focus ? `Focused on ${focus}` : "Focus one speaker's dialogue"}>
        <Icon name="target" size={17} />
      </button>
    </div>
  );
}

// how long the looped clip is — derived from the SAME window loopLine plays
function loopDur(ts: string, nextTs: string | null): string {
  const win = loopWindow(ts, nextTs);
  return win === null ? "" : `${Math.round(win.e - win.s)}s`;
}
function LineEditor({ line, nextTs, onDone }: { line: Line; nextTs: string | null; onDone: () => void }) {
  const [value, setValue] = useState(line.text);
  const sidebarFs = useStore((s) => s.ui.sidebarFontSize); // the edit bar is chrome — sidebar-sized
  const loopSpeed = useStore((s) => s.ui.loopSpeed);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const looping = useRef<(() => void) | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  // the pid this editor OPENED on — save must never resolve identity at commit
  // time (an undo/redo can switch `active` before the blur-save fires, which
  // would stamp this text onto the same line id in a different transcript)
  const pid = useRef(useStore.getState().active);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`;
    }
    // auto-loop is a Settings choice now; the editbar button starts it either way
    if (useStore.getState().ui.loopEdit) {
      looping.current = loopLine(line.ts, nextTs, useStore.getState().ui.loopSpeed);
      setLoopOn(looping.current !== null);
    }
    return () => { looping.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLoop = () => {
    if (looping.current) { looping.current(); looping.current = null; setLoopOn(false); }
    else { looping.current = loopLine(line.ts, nextTs, useStore.getState().ui.loopSpeed); setLoopOn(looping.current !== null); }
  };
  // cycle the loop speed; a running loop follows immediately, and the choice
  // persists (it IS the Settings value)
  const cycleSpeed = () => {
    const i = LOOP_SPEEDS.indexOf(loopSpeed);
    const next = LOOP_SPEEDS[(i + 1) % LOOP_SPEEDS.length] ?? 0.75;
    useStore.getState().setUi({ loopSpeed: next });
    if (looping.current) setPlaybackRate(next);
  };

  const save = (text: string) => {
    const t = text.trim();
    if (t) useStore.getState().editLine(pid.current, line.id, t);
    onDone();
  };

  return (
    <span className="lineEdit">
      <textarea ref={taRef} rows={1} value={value} aria-label={`Correct line ${line.id}`}
        onChange={(e) => { setValue(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(value); }
          else if (e.key === "Escape") { e.stopPropagation(); onDone(); }
        }}
        onBlur={() => save(value)} />
      <span className="editbar" style={{ fontSize: sidebarFs }}>
        <kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel
        {hasVideo() && (
          <>
            {/* mousedown preventDefault: the textarea must NOT blur (blur saves + closes) */}
            <button className={"editloop" + (loopOn ? " on" : "")} onMouseDown={(e) => e.preventDefault()}
              onClick={toggleLoop} aria-pressed={loopOn}
              title={loopOn ? "Stop looping this utterance" : "Loop this utterance while you edit"}>
              {loopOn ? "⏸ stop loop" : "▶ loop"} {loopDur(line.ts, nextTs)}
            </button>
            <button className="editloop editspeed" onMouseDown={(e) => e.preventDefault()}
              onClick={cycleSpeed} title="Loop speed (also in Settings → Transcript)">
              {loopSpeed}×
            </button>
          </>
        )}
        {line.orig !== undefined && (
          <button className="editrevert" onMouseDown={(e) => e.preventDefault()}
            onClick={() => save(line.orig!)}>
            ↺ was: “{line.orig}”
          </button>
        )}
      </span>
    </span>
  );
}
