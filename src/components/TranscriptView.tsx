import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties } from "react";
import { VList, type VListHandle } from "virtua";
import { useStore, laneAssign, patternOf } from "../state/store";
import { mergeGroups, type Group } from "../merge";
import { SegmentPopover } from "./SegmentPopover";
import { Minimap, type MinimapHandle } from "./Minimap";
import { Resizer } from "./Resizer";
import { seekVideo, loopLine } from "../video/seek";
import { hashLine, lensOf, spanLens, type Flag } from "../ai/flag";
import type { Line } from "../state/store";
import { findMatches } from "../search";
import { excerptOf } from "../contract/excerpt";
import type { ReactNode } from "react";

type LanedSeg = ReturnType<typeof laneAssign>[number];
const isR = (sp: string) => sp.trim().toUpperCase().startsWith("R");

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
// Noticing lenses: a quiet per-lens tint (something to look at) — hover names the
// lens, Alt-click dismisses (plain click still selects the line). Search
// highlighting wins when a query is active — two overlapping mark-ups on the same
// characters is noise, and you're hunting, not proofreading.
function renderFlagged(text: string, spans: Flag[], lineId: number): ReactNode {
  const hits: { at: number; len: number; span: Flag }[] = [];
  for (const s of spans) {
    const at = text.indexOf(s.quote);
    if (at >= 0) hits.push({ at, len: s.quote.length, span: s });
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.at - b.at);
  const nodes: ReactNode[] = [];
  let last = 0;
  hits.forEach((h, k) => {
    if (h.at < last) return; // overlapping marks: keep the first
    if (h.at > last) nodes.push(text.slice(last, h.at));
    const lens = lensOf(spanLens(h.span));
    const isError = spanLens(h.span) === "transcription";
    nodes.push(isError
      ? <span key={k} className="aidoubt" data-tip={h.span.reason}>{text.slice(h.at, h.at + h.len)}</span>
      : <span key={k} className={`ainote lens-${spanLens(h.span)}`} style={{ "--lens-c": lens?.color } as CSSProperties}
          data-tip={`${lens?.label ?? spanLens(h.span)} — ${h.span.reason} · Alt-click to dismiss`}
          onClick={(e) => {
            if (!e.altKey) return; // plain click keeps selecting the line
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
const shortSpeaker = (s: string) => s.trim().slice(0, 3);
const LANE_W = { xs: 10, sm: 14, md: 18, lg: 24 } as const; // lane bar width px

const MIN_PAD = 48;    // headroom floor, before the viewport has been measured
const ROW_RATIO = 2.2; // one unwrapped row ≈ 2.2 × fontSize (row line-height + padding)

// Per-tab scroll memory. Module scope, NOT component refs: TranscriptView unmounts
// entirely while the Browse tab is shown, so refs would forget every position on the
// way through Browse. (Selection memory is the store's savedSelections, same reason.)
//
// The position is an ANCHOR (top item's child index + pixels into it), not a raw
// scrollTop: row heights above the viewport are virtua estimates, and the same VList
// instance serves every tab, so after showing another transcript the estimates for
// this one have changed — a saved pixel offset would land on different text.
interface ScrollAnchor { index: number; delta: number }
const savedScroll: Record<string, ScrollAnchor> = {};
const positioned = new Set<string>(); // tabs whose initial position has been applied

export function TranscriptView() {
  const active = useStore((s) => s.active);
  const transcript = useStore((s) => s.transcripts[s.active]);
  const mergeLines = useStore((s) => s.ui.mergeLines);
  const showLineNumbers = useStore((s) => s.ui.showLineNumbers);
  const speakerNames = useStore((s) => s.ui.speakerNames);
  const warnCls = useStore((s) => `cc-${s.ui.warnSize} cc-${s.ui.warnCorner}`);
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
  };
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null); // line under repair (dblclick)
  useEffect(() => { setEditingId(null); }, [active]);
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

  // AI marks for this transcript, but only where the line still reads as it did when
  // it was scanned — a correction invalidates its own marks, for free. With notices
  // hidden (the eye toggle: read/code blind), only transcription flags remain.
  const aiFlags = useStore((s) => s.aiFlags);
  const showNotices = useStore((s) => s.ui.showNotices);
  const flagsByLine = useMemo(() => {
    const m = new Map<number, Flag[]>();
    for (const l of transcript?.lines ?? []) {
      const f = aiFlags[`${active}:${l.id}`];
      if (!f || !f.spans.length || f.hash !== hashLine(l.text)) continue;
      const spans = showNotices ? f.spans : f.spans.filter((s) => spanLens(s) === "transcription");
      if (spans.length) m.set(l.id, spans);
    }
    return m;
  }, [aiFlags, transcript, active, showNotices]);

  // Scroll headroom, VS Code's `scrollBeyondLastLine` but on both ends: a pad of
  // (viewport − one row) lets ANY line be pulled to the top or the bottom of the
  // screen, so the first and last lines get coded under the same conditions as the
  // middle — same room for the anchored command palette, same reading position.
  // Measured, not a constant: it has to track the viewport and the row height.
  const [pad, setPad] = useState(MIN_PAD);
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
    if (pad <= MIN_PAD) return;           // container not laid out yet; the pad is a guess
    if (useStore.getState().jump) return; // a Browse -> line jump owns the position
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
  const toTop = () => vref.current?.scrollToIndex(1, { align: "start" });
  const toBottom = () => vref.current?.scrollToIndex(groups.length, { align: "end" });

  // The ONLY way into a selection used to be onMouseDown on a row: arrow keys are
  // gated on a selection already existing, so a keyboard user could never make the
  // first one — and the digit hotkeys, the whole point of the app, stayed forever
  // out of reach. The list is now a tab stop, and the first arrow press seeds a
  // selection from the top VISIBLE line (not line 1 — you'd lose your place in a
  // 3000-line transcript). Once a selection exists, App's global handler drives it.
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
    s.startSelection(groups[gi].startId);
  };

  // Browse -> jump: scroll the virtualized list to the unit containing the line.
  // Waits for the measured pad (jump stays pending): on a fresh mount the top pad is
  // still the 48px placeholder, and jumping first means the pad's growth afterwards
  // shoves the content down under an unchanged scrollTop.
  useEffect(() => {
    if (pad <= MIN_PAD || !jump || jump.pid !== active || !transcript) return;
    const idx = groups.findIndex((g) => jump.line >= g.startId && jump.line <= g.endId);
    if (idx >= 0) vref.current?.scrollToIndex(idx + 1, { align: "center" }); // +1 for the top vpad
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
    const gi = groups.findIndex((g) => headId >= g.startId && headId <= g.endId);
    if (gi < 0) return;
    const first = v.findItemIndex(v.scrollOffset);
    const last = v.findItemIndex(v.scrollOffset + v.viewportSize);
    const idx = gi + 1; // +1 for the top vpad
    if (idx <= first) v.scrollToIndex(idx, { align: "start" });
    else if (idx >= last) v.scrollToIndex(idx, { align: "end" });
  }, [headId, groups]);

  // Tooltips open upward, but the list is a scroller and clips them — and with the
  // headroom, the line you're reading is usually parked at the very top. Flip the tip
  // below when there isn't room above it. Delegated: the rows are virtualized, so
  // per-row listeners would churn. Lane bars are side-positioned; leave them alone.
  useEffect(() => {
    const el = tviewRef.current;
    if (!el) return;
    const onOver = (e: globalThis.MouseEvent) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      if (!t || t.classList.contains("laneBar")) return;
      const room = t.getBoundingClientRect().top - el.getBoundingClientRect().top;
      t.classList.toggle("tipbelow", room < fontSize * 4.5); // ~ a two-line tip + gap
    };
    el.addEventListener("mouseover", onOver);
    return () => el.removeEventListener("mouseover", onOver);
  }, [fontSize]);

  // sync the minimap viewport box on mount and whenever the list content changes
  useEffect(() => { const id = requestAnimationFrame(syncMinimap); return () => cancelAnimationFrame(id); });

  // PageUp/PageDown/Home/End scroll the transcript list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const v = vref.current;
      if (!v) return;
      if (e.key === "PageDown") { e.preventDefault(); v.scrollBy(v.viewportSize * 0.9); }
      else if (e.key === "PageUp") { e.preventDefault(); v.scrollBy(-v.viewportSize * 0.9); }
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
    pushUndo();
    const move = (ev: globalThis.MouseEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(".lineRow") as HTMLElement | null;
      if (!row?.dataset.lid) return;
      const gs = +row.dataset.lid, ge = +(row.dataset.end ?? row.dataset.lid);
      if (which === "start" && gs <= seg.end) setSegmentRange(seg.sid, gs, seg.end);
      if (which === "end" && ge >= seg.start) setSegmentRange(seg.sid, seg.start, ge);
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // click selects; click+drag selects a range (Shift extends, Ctrl toggles — no drag)
  const onRowDown = (e: MouseEvent, id: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".lanes,.ts,.lineEdit")) return;
    if (e.detail > 1) return; // second press of a double-click: that's an edit, not a re-select
    if (e.shiftKey) { selectLine(id, { extend: true }); return; }
    if (e.ctrlKey || e.metaKey) { selectLine(id, { toggle: true }); return; }
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
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  if (!transcript) {
    return <div className="empty">Import transcript CSVs to begin (Import files…).</div>;
  }

  // uniform column widths sized to the longest displayed label in this transcript
  const spkLen = (s: string) => (speakerNames === "short" ? shortSpeaker(s) : s.trim()).length;
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
      <div className="tview" ref={tviewRef}>
      <VList ref={vref} className="tviewlist" onScroll={syncMinimap}
        tabIndex={0} onKeyDown={onListKeyDown}
        aria-label={`Transcript ${active}. Press the down arrow to select a line, then 1 to 9 to apply a code.`}
        style={{ height: "100%", flex: 1, minWidth: 0, fontSize, "--txt-fs": `${fontSize}px`, "--spk-w": spkWidth, "--lid-w": lidWidth, "--lane-w": `${LANE_W[laneWidth]}px` } as CSSProperties}>
        {[
          <div className="vpad vpad-top" key="vpad-top" style={{ height: pad }} />, // headroom before the first line
          ...groups.map((g) => (
            <Row
              key={g.startId}
              group={g}
              selected={g.ids.some((id) => selLines?.has(id))}
              cols={cols}
              laned={laned}
              codebook={codebook}
              onRowDown={(e) => onRowDown(e, g.startId)}
              onLaneClick={(seg, e) => setPop({ sid: seg.sid, x: e.clientX, y: e.clientY })}
              onGripDown={dragEdge}
              onLaneHover={onLaneHover}
              hl={hl}
              closeCallSids={closeCallSids}
              warnCls={warnCls}
              showLid={showLineNumbers}
              speakerNames={speakerNames}
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
          <div className="vpad vpad-bot" key="vpad-bot" style={{ height: pad }} />, // headroom after the last line
        ]}
      </VList>
      <Resizer side="right" onWidth={(w) => setUi({ minimapWidth: Math.max(44, Math.min(160, w)) })} />
      <Minimap ref={mmRef} groups={groups} laned={laned} cols={cols} codebook={codebook}
        closeCallSids={closeCallSids} detail={minimapDetail} vref={vref} />
      </div>
      {pop && <SegmentPopover sid={pop.sid} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
    </>
  );
}

function Row({ group, selected, cols, laned, codebook, onRowDown, onLaneClick, onGripDown, onLaneHover, hl, closeCallSids, warnCls, showLid, speakerNames, searchQuery, current, editingId, onEditStart, onEditEnd, nextTsOf, flagsByLine }: {
  group: Group;
  selected: boolean;
  cols: number;
  laned: LanedSeg[];
  codebook: Record<string, { color: string }>;
  onRowDown: (e: MouseEvent) => void;
  onLaneClick: (seg: LanedSeg, e: MouseEvent) => void;
  onGripDown: (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => void;
  onLaneHover: (sid: number | null) => void;
  hl: { start: number; end: number; color: string } | null;
  closeCallSids: Set<number>;
  warnCls: string;
  showLid: boolean;
  speakerNames: "full" | "short";
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
    const color = codebook[seg.code]?.color || "#999";
    const isStart = seg.start >= startId && seg.start <= endId;
    const isEnd = seg.end >= startId && seg.end <= endId;
    const cc = closeCallSids.has(seg.sid);
    const cls = "laneBar" + (rej ? " rejected" : ` lp${patternOf(seg.code)}`)
      + (isStart ? " segStart" : "") + (isEnd ? " segEnd" : "");
    // rejected: keep the code color, but faded + striped + outlined to read as inactive.
    // draw top/bottom only on the segment's first/last line so a multi-line reject
    // reads as one continuous outline instead of per-line notches.
    const b = `1.5px solid ${color}`;
    const style: CSSProperties = rej
      ? {
          // vertical (90deg) stripes, 2px on / 2px off — aligns across a multi-line
          // reject since the pattern is invariant along y
          background: `repeating-linear-gradient(90deg, ${color}55, ${color}55 2px, transparent 2px, transparent 4px)`,
          backgroundPosition: "1px 0",
          borderLeft: b, borderRight: b,
          borderTop: isStart ? b : undefined,
          borderBottom: isEnd ? b : undefined,
        }
      : { background: color };
    lanes.push(
      <span key={i} className={cls} data-tip={`${seg.code} (${seg.start}-${seg.end})${rej ? " — rejected" : ""}${cc ? " · ⚠ near-balanced speakers" : ""}`}
        style={style}
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
    <div className={"lineRow" + (isR(group.speaker) ? " rspk" : "") + (selected ? " selected" : "") + (merged ? " merged" : "")}
      data-lid={startId} data-end={endId} onMouseDown={onRowDown}
      style={shadow.length ? { boxShadow: shadow.join(",") } : undefined}>
      {showLid && <span className="lid">{lidLabel(group)}</span>}
      <button className="ts" onClick={(e) => { e.stopPropagation(); seekVideo(group.ts); }}
        title="play from here">
        {group.ts.split(".")[0]}
      </button>
      <span className="spk" title={group.speaker}>{speakerNames === "short" ? shortSpeaker(group.speaker) : group.speaker}</span>
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
                {l.orig !== undefined && <span className="editmark" data-tip={`was: “${l.orig}”`}>✱</span>}
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
// if any — loops this utterance at 0.75× so the fix is made against the audio,
// not from memory. Enter saves, Esc cancels, blur saves (it's a typo fix, losing
// it to a stray click would hurt more than keeping it).
function LineEditor({ line, nextTs, onDone }: { line: Line; nextTs: string | null; onDone: () => void }) {
  const [value, setValue] = useState(line.text);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const looping = useRef<(() => void) | null>(null);
  const [hasAudio, setHasAudio] = useState(false);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`;
    }
    looping.current = loopLine(line.ts, nextTs);
    setHasAudio(looping.current !== null);
    return () => { looping.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (text: string) => {
    const t = text.trim();
    if (t) useStore.getState().editLine(useStore.getState().active, line.id, t);
    onDone();
  };

  return (
    <span className="lineEdit">
      <textarea ref={taRef} rows={1} value={value}
        onChange={(e) => { setValue(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(value); }
          else if (e.key === "Escape") { e.stopPropagation(); onDone(); }
        }}
        onBlur={() => save(value)} />
      <span className="editbar">
        <kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel
        {hasAudio && <span className="editloop">▶ looping {line.ts.split(".")[0]} · 0.75×</span>}
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
