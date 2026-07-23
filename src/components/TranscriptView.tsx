// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties } from "react";
import { VList, type VListHandle } from "virtua";
import { useStore, laneAssign, patternOf, speakerColor, weightOf, inkOn } from "../state/store";
import { mergeGroups, type Group } from "../merge";
import { SegmentPopover } from "./SegmentPopover";
import { AiMarkPopover } from "./AiMarkPopover";
import { Icon } from "./Icon";
import { Minimap, type MinimapHandle } from "./Minimap";
import { Resizer } from "./Resizer";
import { seekVideo, loopLine, hasVideo } from "../video/seek";
import { hashLine, lensOf, spanLens, type Flag } from "../ai/flag";
import type { Line, SpeakerWeight } from "../state/store";
import { findMatches } from "../search";
import { excerptOf } from "../contract/excerpt";
import { savedScroll, positioned } from "../scrollMemory";
import { announce } from "../announce";
import { tinyDiff } from "../diff";
import type { ReactNode } from "react";

type LanedSeg = ReturnType<typeof laneAssign>[number];

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

const MIN_PAD = 48;    // headroom floor (also the spacer height until the viewport is measured)
const ROW_RATIO = 2.2; // one unwrapped row ≈ 2.2 × fontSize (row line-height + padding)
const GLIDE_MS = 260; // smooth-scroll duration; long enough to read as motion, short enough to not wait on
const WHEEL_TAU = 90; // ms; how hard the wheel glide chases its target (~3x this to settle)
const WHEEL_MIN = 40; // px; below this a wheel event is really a trackpad, which is smooth already

// per-tab scroll anchors — shared with the store, which must forget them on a
// re-import or project swap (a pid is not stable identity). See scrollMemory.ts.

export function TranscriptView() {
  const active = useStore((s) => s.active);
  const transcript = useStore((s) => s.transcripts[s.active]);
  const mergeLines = useStore((s) => s.ui.mergeLines);
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
      savedScroll[active] = { index, delta: v.scrollOffset - v.getItemOffset(index) };
    }
    if (v.viewportSize) mmRef.current?.setRange(v.findItemIndex(v.scrollOffset), v.findItemIndex(v.scrollOffset + v.viewportSize));
    // Home/End (and any scroll) leave the selection behind. Rather than silently move
    // it — the selection is your place in the argument, not your place on screen — note
    // when it has gone off-screen and offer a way back. Not mid-glide: a follow drives
    // 'scroll' every frame with the head still catching up, which would flash the button.
    if (!gliding.current) setSelOff(offscreenDir(v));
  };
  // Which way the selection lies, if it isn't visible. Runs on EVERY scroll event, so it
  // may not walk the selection: `Math.min(...set)` spreads it, which is O(n) per frame
  // and throws RangeError (call-stack) once a selection gets big enough. The bounds are
  // memoised off the selection instead, and this only reads them.
  const offscreenDir = (v: VListHandle): "up" | "down" | null => {
    const b = selBounds.current;
    if (!b || !v.viewportSize) return null;
    const gi = groupsRef.current.findIndex((g) => g.endId >= b.first);
    const gj = groupsRef.current.findIndex((g) => g.endId >= b.last);
    if (gi < 0) return null;
    const top = v.findItemIndex(v.scrollOffset), bot = v.findItemIndex(v.scrollOffset + v.viewportSize);
    if (gj + 1 < top) return "up";
    if (gi + 1 > bot) return "down";
    return null;
  };
  const [selOff, setSelOff] = useState<"up" | "down" | null>(null);
  const groupsRef = useRef<Group[]>([]);
  const selBounds = useRef<{ first: number; last: number } | null>(null);
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);
  const [aiPop, setAiPop] = useState<{ line: number; span: Flag; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null); // line under repair (dblclick)
  useEffect(() => { setEditingId(null); setAiPop(null); }, [active]);
  const [hoverSid, setHoverSid] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // debounce clearing so moving between a segment's bars doesn't flicker the brackets
  const onLaneHover = (sid: number | null) => {
    clearTimeout(hoverTimer.current);
    if (sid === null) hoverTimer.current = setTimeout(() => setHoverSid(null), 40);
    else setHoverSid(sid);
  };

  // merged display units (singletons when the toggle is off)
  const groups = useMemo(() => mergeGroups(transcript?.lines ?? [], mergeLines), [transcript, mergeLines]);
  // speaker focus (Settings → Speakers): a focus name not present in THIS
  // transcript is ignored rather than dimming every row
  const focusActive = useMemo(
    () => ui.speakerFocus && groups.some((g) => g.speaker.trim() === ui.speakerFocus)
      ? ui.speakerFocus : null,
    [groups, ui.speakerFocus]);
  groupsRef.current = groups; // syncMinimap runs outside render and needs the current groups

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

  // Animate the jumps, opt-in (Settings -> Transcript). Read straight from the store,
  // not a subscription: the keydown effect below captures its closures once. Deliberately
  // does NOT defer to prefers-reduced-motion: it defaults off, so switching it on is an
  // explicit per-app choice, and it should beat the OS-wide default it contradicts.
  const smooth = () => useStore.getState().ui.smoothScroll;
  const tween = useRef(0);
  // true only while a glide is animating: the scroll it drives fires 'scroll' every
  // frame, and the selection reads as off-screen until the glide catches up — gate the
  // "back to selection" button off this so a follow doesn't flash it. (Instant/smooth-off
  // glides never set it: they land in one go, before any 'scroll' fires.)
  const gliding = useRef(false);
  // Three things write scrollTop: the glide loop, the wheel-chase loop, and instant
  // jumps (minimap, search, tab restore). The loops run for ~a half second after
  // their trigger, so a jump landing mid-loop got overwritten on the next frame —
  // click the minimap during a wheel's ease-out tail and the tail yanked the view
  // back. Every navigation entry point calls this first: one writer at a time.
  const wheelStop = useRef<() => void>(() => {});
  const stopAnims = () => {
    cancelAnimationFrame(tween.current);
    gliding.current = false;
    wheelStop.current();
  };
  // virtua's own `smooth` option delegates to scrollTo({behavior:"smooth"}), which the
  // browser silently downgrades to a jump when the OS asks for reduced motion — so the
  // app toggle could never win on a machine that asks for it. Animate scrollTop on a rAF
  // loop instead, which nothing downgrades.
  //
  // `targetOf` computes the destination up front (scrollToIndex can't tell us: it lands
  // asynchronously, over several frames, as rows measure). That makes the target only as
  // good as virtua's height estimates above it, so `land` runs at the end and puts us
  // exactly where the instant path would have — by then the rows we crossed are measured.
  const glide = (targetOf: (v: VListHandle, from: number) => number, land: () => void) => {
    const v = vref.current;
    const el = tviewRef.current?.querySelector<HTMLElement>(".tviewlist");
    stopAnims(); // includes the wheel-chase loop, which would fight this glide frame by frame
    if (!v || !el || !smooth()) return land();
    const from = el.scrollTop;
    const to = Math.max(0, Math.min(targetOf(v, from), el.scrollHeight - el.clientHeight));
    if (Math.abs(to - from) < 2) return land(); // already there; don't stage a 0px glide
    gliding.current = true;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / GLIDE_MS);
      el.scrollTop = from + (to - from) * (1 - (1 - p) ** 3); // easeOutCubic
      if (p < 1) tween.current = requestAnimationFrame(step);
      else { gliding.current = false; land(); }
    };
    tween.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(tween.current), []);
  // virtua's "center" alignment, computed rather than requested
  const centerOn = (i: number) => (v: VListHandle) => v.getItemOffset(i) - (v.viewportSize - v.getItemSize(i)) / 2;

  // The wheel. Chrome animates its own ~100px-per-click jumps, but only while the OS
  // isn't asking for reduced motion — ask for it and every click lands in one frame.
  // So chase the wheel ourselves: accumulate clicks into a target and ease scrollTop
  // toward it. Deliberately eased by TIME, not per-frame: a fixed fraction per frame
  // would scroll twice as fast on a 120Hz screen.
  useEffect(() => {
    const el = tviewRef.current?.querySelector<HTMLElement>(".tviewlist");
    if (!el) return;
    let target = 0, raf = 0, last = 0, running = false, lastSet = -1;
    const stop = () => { cancelAnimationFrame(raf); running = false; };
    wheelStop.current = stop;
    const step = (t: number) => {
      // Backstop for writers that don't route through stopAnims (search, a tab
      // restore): if the scroll isn't where this loop left it, someone else moved
      // it. A LARGE move is a navigation — their position wins, the chase ends. A
      // small one is virtua's own estimate correction while rows measure (routine
      // when wheeling up through unmeasured content) — carry the shift into the
      // target instead of aborting mid-gesture, or the first pass would stutter.
      if (lastSet >= 0) {
        const drift = el.scrollTop - lastSet;
        if (Math.abs(drift) > 48) { running = false; return; }
        if (Math.abs(drift) > 4) target = Math.max(0, Math.min(target + drift, el.scrollHeight - el.clientHeight));
      }
      const dt = Math.min(64, t - last); // a backgrounded tab resumes with a huge dt
      last = t;
      const d = target - el.scrollTop;
      if (Math.abs(d) < 0.5) { el.scrollTop = target; running = false; return; }
      el.scrollTop += d * (1 - Math.exp(-dt / WHEEL_TAU));
      lastSet = el.scrollTop;
      raf = requestAnimationFrame(step);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // ctrl+wheel is browser zoom, not ours to take
      const mult = useStore.getState().ui.scrollSpeed || 1;
      if (!smooth() && mult === 1) return; // nothing to do: native scroll is right
      // ponytail: |delta| is the only cheap tell between a wheel click and a trackpad
      // swipe. Trackpads already scroll pixel-by-pixel — smoothing them just adds lag —
      // so only the chunky events get chased. If a device lands wrong, this is the knob.
      const raw = e.deltaMode === 1 ? e.deltaY * fontSize * ROW_RATIO : e.deltaY;
      const px = raw * mult; // the Settings "scroll distance" knob scales every device
      if (!smooth() || Math.abs(raw) < WHEEL_MIN) {
        // no chase for this event (smoothing off, or a trackpad's pixel stream) —
        // but a non-1 multiplier still has to scale it, directly
        if (mult === 1) return;
        e.preventDefault();
        el.scrollTop = Math.max(0, Math.min(el.scrollTop + px, el.scrollHeight - el.clientHeight));
        return;
      }
      e.preventDefault();
      cancelAnimationFrame(tween.current); gliding.current = false; // a keyboard glide loses to the hand on the wheel
      const max = el.scrollHeight - el.clientHeight;
      target = Math.max(0, Math.min((running ? target : el.scrollTop) + px, max));
      if (!running) { running = true; last = performance.now(); lastSet = el.scrollTop; raf = requestAnimationFrame(step); }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); stop(); wheelStop.current = () => {}; };
  }, [transcript, fontSize]);

  // scroll the selection back into view — the way home after Home/End
  const backToSelection = () => {
    const st = useStore.getState();
    if (st.selection.pid !== active || !st.selection.lines.size) return;
    const first = Math.min(...st.selection.lines);
    const gi = groups.findIndex((g) => g.endId >= first);
    if (gi >= 0) glide(centerOn(gi + 1), () => vref.current?.scrollToIndex(gi + 1, { align: "center" })); // +1 for the top vpad
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
      // transcription errors always show (they feed the line editor); noticings can
      // be hidden wholesale (the eye) or per lens (the eye's dropdown)
      const spans = f.spans.filter((s) => spanLens(s) === "transcription"
        || (showNotices && !hiddenLenses.includes(spanLens(s))));
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
    setAiPop({ line: lid, span, x: r.left, y: r.bottom + 6 });
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
    // a glide started on the PREVIOUS tab would keep animating scrollTop against
    // the old tab's targets, overwrite the restore below, and (worse) its bogus
    // positions would get recorded as the new tab's saved scroll
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
  const toTop = () => glide((v) => v.getItemOffset(1), () => vref.current?.scrollToIndex(1, { align: "start" }));
  // align "end" alone parks the last line exactly at the viewport bottom — which is
  // where the floating hotbar dock sits, so End left it occluded. Overshoot by the
  // dock's current height (collapsed docks measure small, which is right) plus a gap.
  const toBottom = () => {
    const dock = document.querySelector(".hotbar")?.getBoundingClientRect().height ?? 64;
    const n = groups.length;
    glide((v) => v.getItemOffset(n) + v.getItemSize(n) - v.viewportSize + dock + 8,
      () => vref.current?.scrollToIndex(n, { align: "end", offset: dock + 8 }));
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
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const s = useStore.getState();
    if (s.selection.pid === active && s.selection.lines.size) return; // App moves it from here
    const v = vref.current;
    if (!v || !groups.length) return;
    e.preventDefault();
    // App's window handler also listens for arrows. It runs AFTER this one (window is
    // above the list in the bubble path) and would see the selection we just made and
    // immediately advance it — so the first press would silently skip a line. This
    // keypress seeds; the next one moves.
    e.stopPropagation();
    const gi = Math.min(groups.length - 1, Math.max(0, v.findItemIndex(v.scrollOffset) - 1)); // -1: the top vpad is item 0
    s.pushSelUndo(); // coalesces with a run of arrow presses
    s.startSelection(groups[gi].startId);
  };

  // Browse -> jump: scroll the virtualized list to the unit containing the line.
  // Waits for the measured pad (jump stays pending): on a fresh mount the top pad is
  // still the 48px placeholder, and jumping first means the pad's growth afterwards
  // shoves the content down under an unchanged scrollTop.
  useEffect(() => {
    if (pad === null || !jump || jump.pid !== active || !transcript) return;
    const idx = groups.findIndex((g) => jump.line >= g.startId && jump.line <= g.endId);
    if (idx >= 0) glide(centerOn(idx + 1), () => vref.current?.scrollToIndex(idx + 1, { align: "center" })); // +1 for the top vpad
    positioned.add(active); // the jump IS this tab's position; scrolls from here are the user's
    clearJump();
  }, [jump, active, transcript, groups, clearJump, pad]);

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
    const gi = groupsRef.current.findIndex((g) => headId >= g.startId && headId <= g.endId);
    if (gi < 0) return;
    const idx = gi + 1; // +1 for the top vpad
    const first = v.findItemIndex(v.scrollOffset);
    const last = v.findItemIndex(v.scrollOffset + v.viewportSize);
    // glide, not raw scrollToIndex: it lands on an explicitly-computed target, where
    // scrollToIndex estimates the height above and visibly overshoots-then-corrects
    // mid-list (a scroll-back bounce). When smooth is off, glide lands instantly.
    // Bottom edge is treated symmetrically with the top — no hotbar offset: the dock
    // resizes (collapsed->expanded) the moment a selection exists, and keying the scroll
    // to its height fights that change.
    if (idx <= first) glide((vh) => vh.getItemOffset(idx), () => v.scrollToIndex(idx, { align: "start" }));
    else if (idx >= last) glide((vh) => vh.getItemOffset(idx) + vh.getItemSize(idx) - vh.viewportSize,
      () => v.scrollToIndex(idx, { align: "end" }));
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
        const d = (e.key === "PageDown" ? 0.9 : -0.9) * v.viewportSize;
        // Measure the page off the live scrollTop, not v.scrollOffset — virtua's copy
        // lags a frame behind after a re-measure, which paged short. No `land` step: a
        // page is an exact pixel target, and scrollBy is relative, so re-running it at
        // the end would page twice.
        if (smooth()) glide((_, from) => from + d, () => {});
        else v.scrollBy(d);
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
    return <div className="empty">Import transcript CSVs to begin (Import files…).</div>;
  }

  // uniform column widths sized to the longest displayed label in this transcript
  const shorts = shortLabels([...new Set(transcript.lines.map((l) => l.speaker.trim()))]);
  const spkLen = (s: string) => (speakerNames === "short" ? shorts[s.trim()] ?? s.trim() : s.trim()).length;
  const spkChars = transcript.lines.reduce((m, l) => Math.max(m, spkLen(l.speaker)), 0);
  const spkWidth = `${Math.max(2.5, spkChars)}ch`;
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
      <VList ref={vref} className="tviewlist" onScroll={syncMinimap}
        tabIndex={0} onKeyDown={onListKeyDown}
        aria-label={`Transcript ${active}. Press the down arrow to select a line, 1 to 9 to apply a code, Enter to play from the selected line, M to review the selected line's AI marks.`}
        style={{ height: "100%", flex: 1, minWidth: 0, fontSize, "--spk-w": spkWidth, "--lid-w": lidWidth, "--lane-w": `${LANE_W[laneWidth]}px` } as CSSProperties}>
        {[
          <div className="vpad vpad-top" key="vpad-top" style={{ height: pad ?? MIN_PAD }} />, // headroom before the first line
          ...groups.map((g) => (
            <Row
              key={g.startId}
              group={g}
              selected={g.ids.some((id) => selLines?.has(id))}
              spkOff={focusActive && focusActive !== g.speaker.trim() ? ui.speakerFocusMode : null}
              cols={cols}
              laned={laned}
              codebook={codebook}
              onRowDown={(e) => onRowDown(e, g.startId)}
              onLaneClick={(seg, e) =>
                // clicking the segment's own lane while its popover is open closes it
                // (useDismiss ignores this lane, so the mousedown doesn't close-then-reopen)
                setPop((p) => p && p.sid === seg.sid ? null : { sid: seg.sid, x: e.clientX, y: e.clientY })}
              onGripDown={dragEdge}
              onLaneHover={onLaneHover}
              hl={hl}
              closeCallSids={closeCallSids}
              warnCls={warnCls}
              lanePattern={lanePattern}
              spkColor={speakerColor(ui, g.speaker)}
              weight={weightOf(ui, g.speaker)}
              showLid={showLineNumbers}
              speakerNames={speakerNames}
              shortName={shorts[g.speaker.trim()] ?? g.speaker.trim()}
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
      <Resizer side="right" onWidth={(w) => setUi({ minimapWidth: Math.max(44, Math.min(160, w)) })} />
      <Minimap ref={mmRef} groups={groups} laned={laned} cols={cols} codebook={codebook}
        closeCallSids={closeCallSids} detail={minimapDetail} ui={ui} vref={vref} onNav={stopAnims} />
        {selOff && (
          <button className={`backtosel ${selOff}`} onClick={backToSelection}
            style={{ fontSize: ui.sidebarFontSize }} aria-label="Scroll back to your selected line(s)">
            <Icon name={selOff === "up" ? "arrow-up" : "arrow-down"} size={ui.sidebarFontSize + 2} /> return
          </button>
        )}
      </div>
      {pop && <SegmentPopover sid={pop.sid} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
      {aiPop && <AiMarkPopover pid={active} line={aiPop.line} span={aiPop.span}
        x={aiPop.x} y={aiPop.y} onClose={() => setAiPop(null)} onCycle={cycleMarkPopover} />}
    </>
  );
}

function Row({ group, selected, spkOff, cols, laned, codebook, onRowDown, onLaneClick, onGripDown, onLaneHover, hl, closeCallSids, warnCls, lanePattern, spkColor, weight, showLid, speakerNames, shortName, searchQuery, current, editingId, onEditStart, onEditEnd, nextTsOf, flagsByLine }: {
  group: Group;
  selected: boolean;
  spkOff: "dim" | "collapse" | null; // speaker focus: how a NON-focused speaker's row steps back
  cols: number;
  laned: LanedSeg[];
  codebook: Record<string, { color: string }>;
  onRowDown: (e: MouseEvent) => void;
  onLaneClick: (seg: LanedSeg, at: { clientX: number; clientY: number }) => void;
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
        onClick={(e) => { e.stopPropagation(); onLaneClick(seg, e); }}>
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
    <div className={"lineRow" + (weight !== "normal" ? ` spk-${weight}` : "") + (spkOff ? ` spk-off-${spkOff}` : "") + (selected ? " selected" : "") + (merged ? " merged" : "")}
      id={`trow-${startId}`}
      data-lid={startId} data-end={endId} onMouseDown={onRowDown}
      style={{ "--spk-c": spkColor, "--spk-ink": inkOn(spkColor), ...(shadow.length ? { boxShadow: shadow.join(",") } : {}) } as CSSProperties}>
      {showLid && <span className="lid">{lidLabel(group)}</span>}
      {/* out of the Tab order: tabbing walked every rendered timecode. Mouse users
          click it; keyboard users press Enter on the selected line (see the list). */}
      <button className="ts" tabIndex={-1} onClick={(e) => { e.stopPropagation(); seekVideo(group.ts); }}
        title="play from here">
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
function LineEditor({ line, nextTs, onDone }: { line: Line; nextTs: string | null; onDone: () => void }) {
  const [value, setValue] = useState(line.text);
  const sidebarFs = useStore((s) => s.ui.sidebarFontSize); // the edit bar is chrome — sidebar-sized
  const taRef = useRef<HTMLTextAreaElement>(null);
  const looping = useRef<(() => void) | null>(null);
  const [loopOn, setLoopOn] = useState(false);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`;
    }
    // auto-loop is a Settings choice now; the editbar button starts it either way
    if (useStore.getState().ui.loopEdit) {
      looping.current = loopLine(line.ts, nextTs);
      setLoopOn(looping.current !== null);
    }
    return () => { looping.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLoop = () => {
    if (looping.current) { looping.current(); looping.current = null; setLoopOn(false); }
    else { looping.current = loopLine(line.ts, nextTs); setLoopOn(looping.current !== null); }
  };

  const save = (text: string) => {
    const t = text.trim();
    if (t) useStore.getState().editLine(useStore.getState().active, line.id, t);
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
          // mousedown preventDefault: the textarea must NOT blur (blur saves + closes)
          <button className={"editloop" + (loopOn ? " on" : "")} onMouseDown={(e) => e.preventDefault()}
            onClick={toggleLoop} aria-pressed={loopOn}
            title={loopOn ? "Stop looping this utterance" : "Loop this utterance while you edit"}>
            {loopOn ? "⏸ stop loop" : "▶ loop"} {line.ts.split(".")[0]}
          </button>
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
