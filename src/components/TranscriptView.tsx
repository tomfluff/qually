import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type CSSProperties } from "react";
import { VList, type VListHandle } from "virtua";
import { useStore, laneAssign } from "../state/store";
import { mergeGroups, type Group } from "../merge";
import { SegmentPopover } from "./SegmentPopover";
import { Minimap, type MinimapHandle } from "./Minimap";
import { Resizer } from "./Resizer";
import { seekVideo } from "../video/seek";
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

const lidLabel = (g: Group) => g.startId === g.endId ? `${g.startId}` : `${g.startId}–${g.endId}`;
const shortSpeaker = (s: string) => s.trim().slice(0, 3);
const LANE_W = { xs: 10, sm: 14, md: 18, lg: 24 } as const; // lane bar width px

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
  const scrollByPid = useRef<Record<string, number>>({}); // each transcript's own scroll offset
  const syncMinimap = () => {
    const v = vref.current;
    if (!v) return;
    scrollByPid.current[active] = v.scrollOffset;
    if (v.viewportSize) mmRef.current?.setRange(v.findItemIndex(v.scrollOffset), v.findItemIndex(v.scrollOffset + v.viewportSize));
  };
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);
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

  // Browse -> jump: scroll the virtualized list to the unit containing the line
  useEffect(() => {
    if (!jump || jump.pid !== active || !transcript) return;
    const idx = groups.findIndex((g) => jump.line >= g.startId && jump.line <= g.endId);
    if (idx >= 0) vref.current?.scrollToIndex(idx + 1, { align: "center" }); // +1 for the top vpad
    clearJump();
  }, [jump, active, transcript, groups, clearJump]);

  // sync the minimap viewport box on mount and whenever the list content changes
  useEffect(() => { const id = requestAnimationFrame(syncMinimap); return () => cancelAnimationFrame(id); });

  // restore each transcript's own scroll position when switching tabs
  useEffect(() => {
    if (jump) return; // a Browse -> line jump takes precedence over the saved position
    const off = scrollByPid.current[active] ?? 0;
    const id = requestAnimationFrame(() => vref.current?.scrollTo(off));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // PageUp/PageDown/Home/End scroll the transcript list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const v = vref.current;
      if (!v) return;
      if (e.key === "PageDown") { e.preventDefault(); v.scrollBy(v.viewportSize * 0.9); }
      else if (e.key === "PageUp") { e.preventDefault(); v.scrollBy(-v.viewportSize * 0.9); }
      else if (e.key === "Home") { e.preventDefault(); v.scrollTo(0); }
      else if (e.key === "End") { e.preventDefault(); v.scrollTo(v.scrollSize); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    if (e.button !== 0 || (e.target as HTMLElement).closest(".lanes,.ts")) return;
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
      <div className="tview">
      <VList ref={vref} className="tviewlist" onScroll={syncMinimap}
        style={{ height: "100%", flex: 1, minWidth: 0, fontSize, "--spk-w": spkWidth, "--lid-w": lidWidth, "--lane-w": `${LANE_W[laneWidth]}px` } as CSSProperties}>
        {[
          <div className="vpad vpad-top" key="vpad-top" />, // headroom before the first line
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
            />
          )),
          <div className="vpad vpad-bot" key="vpad-bot" />, // headroom after the last line
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

function Row({ group, selected, cols, laned, codebook, onRowDown, onLaneClick, onGripDown, onLaneHover, hl, closeCallSids, warnCls, showLid, speakerNames, searchQuery, current }: {
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
    const cls = "laneBar" + (rej ? " rejected" : "") + (isStart ? " segStart" : "") + (isEnd ? " segEnd" : "");
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
            {searchQuery ? renderText(l.text, searchQuery, current && current.line === l.id ? current.occ : -1) : l.text}
          </Fragment>
        ))}
      </span>
      <span className="lanes">{lanes}</span>
    </div>
  );
}
