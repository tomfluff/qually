import { useEffect, useMemo, useRef, useState, type MouseEvent, type CSSProperties } from "react";
import { VList, type VListHandle } from "virtua";
import { useStore, laneAssign, type Line } from "../state/store";
import { SegmentPopover } from "./SegmentPopover";
import { seekVideo } from "../video/seek";

type LanedSeg = ReturnType<typeof laneAssign>[number];
const isR = (sp: string) => sp.trim().toUpperCase().startsWith("R");

export function TranscriptView() {
  const active = useStore((s) => s.active);
  const transcript = useStore((s) => s.transcripts[s.active]);
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const selLines = useStore((s) => (s.selection.pid === s.active ? s.selection.lines : null));
  const fontSize = useStore((s) => s.ui.fontSize);
  const selectLine = useStore((s) => s.selectLine);
  const startSelection = useStore((s) => s.startSelection);
  const pushUndo = useStore((s) => s.pushUndo);
  const setSegmentRange = useStore((s) => s.setSegmentRange);
  const jump = useStore((s) => s.jump);
  const clearJump = useStore((s) => s.clearJump);
  const vref = useRef<VListHandle>(null);
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);
  const [hoverSid, setHoverSid] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // debounce clearing so moving between a segment's bars doesn't flicker the brackets
  const onLaneHover = (sid: number | null) => {
    clearTimeout(hoverTimer.current);
    if (sid === null) hoverTimer.current = setTimeout(() => setHoverSid(null), 40);
    else setHoverSid(sid);
  };

  // Browse -> jump: scroll the virtualized list to the requested line, then clear
  useEffect(() => {
    if (!jump || jump.pid !== active || !transcript) return;
    const idx = transcript.lines.findIndex((l) => l.id === jump.line);
    if (idx >= 0) vref.current?.scrollToIndex(idx, { align: "center" });
    clearJump();
  }, [jump, active, transcript, clearJump]);

  // lane assignment for the active transcript (greedy interval graph)
  // rejected segments stay in the lanes (styled distinctly) so they can be re-accepted
  const laned = useMemo(
    () => laneAssign(segments.filter((s) => s.pid === active)),
    [segments, active]
  );
  // reserve 5 lanes; grow past that so text contracts instead of the strip scrolling
  const cols = Math.max(5, laned.reduce((m, s) => Math.max(m, s.lane + 1), 0));

  // drag a segment edge to another line (elementFromPoint -> nearest row's line id)
  const dragEdge = (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => {
    e.preventDefault(); e.stopPropagation();
    pushUndo();
    const move = (ev: globalThis.MouseEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(".lineRow") as HTMLElement | null;
      if (!row?.dataset.lid) return;
      const lid = +row.dataset.lid;
      if (which === "start" && lid <= seg.end) setSegmentRange(seg.sid, lid, seg.end);
      if (which === "end" && lid >= seg.start) setSegmentRange(seg.sid, seg.start, lid);
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

  // uniform speaker-column width sized to the longest label in this transcript
  const spkChars = transcript.lines.reduce((m, l) => Math.max(m, l.speaker.trim().length), 0);
  const spkWidth = `${Math.max(2.5, spkChars)}ch`;

  // bracket the hovered (or popover-open) segment's first/last lines
  const activeSid = hoverSid ?? pop?.sid ?? null;
  const hlSeg = activeSid !== null ? laned.find((s) => s.sid === activeSid) : undefined;
  const hl = hlSeg ? { start: hlSeg.start, end: hlSeg.end, color: codebook[hlSeg.code]?.color || "#999" } : null;

  return (
    <>
      <VList ref={vref} style={{ height: "100%", fontSize, "--spk-w": spkWidth } as CSSProperties}>
        {transcript.lines.map((l) => (
          <Row
            key={l.id}
            line={l}
            selected={!!selLines?.has(l.id)}
            cols={cols}
            laned={laned}
            codebook={codebook}
            onRowDown={(e) => onRowDown(e, l.id)}
            onLaneClick={(seg, e) => setPop({ sid: seg.sid, x: e.clientX, y: e.clientY })}
            onGripDown={dragEdge}
            onLaneHover={onLaneHover}
            hl={hl}
          />
        ))}
      </VList>
      {pop && <SegmentPopover sid={pop.sid} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
    </>
  );
}

function Row({ line, selected, cols, laned, codebook, onRowDown, onLaneClick, onGripDown, onLaneHover, hl }: {
  line: Line;
  selected: boolean;
  cols: number;
  laned: LanedSeg[];
  codebook: Record<string, { color: string }>;
  onRowDown: (e: MouseEvent) => void;
  onLaneClick: (seg: LanedSeg, e: MouseEvent) => void;
  onGripDown: (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => void;
  onLaneHover: (sid: number | null) => void;
  hl: { start: number; end: number; color: string } | null;
}) {
  const lanes = [];
  for (let i = 0; i < cols; i++) {
    const seg = laned.find((s) => s.lane === i && s.start <= line.id && line.id <= s.end);
    if (!seg) { lanes.push(<span key={i} className="laneEmpty" />); continue; }
    const rej = seg.status === "rejected";
    const color = codebook[seg.code]?.color || "#999";
    const cls = "laneBar" + (rej ? " rejected" : "") + (seg.start === line.id ? " segStart" : "") + (seg.end === line.id ? " segEnd" : "");
    // rejected: keep the code color, but faded + striped + outlined to read as inactive
    const style = rej
      ? { background: `repeating-linear-gradient(45deg, ${color}55, ${color}55 3px, transparent 3px, transparent 6px)`, border: `1.5px solid ${color}` }
      : { background: color };
    lanes.push(
      <span key={i} className={cls} data-tip={`${seg.code} (${seg.start}-${seg.end})${rej ? " — rejected" : ""}`}
        style={style}
        onMouseEnter={() => onLaneHover(seg.sid)} onMouseLeave={() => onLaneHover(null)}
        onClick={(e) => { e.stopPropagation(); onLaneClick(seg, e); }}>
        {seg.start === line.id && <span className="grip gripTop" onMouseDown={(e) => onGripDown(e, seg, "start")} />}
        {seg.end === line.id && <span className="grip gripBot" onMouseDown={(e) => onGripDown(e, seg, "end")} />}
      </span>
    );
  }
  // inset shadow brackets the hovered segment: top border on its first line, bottom on its last
  const shadow: string[] = [];
  const bracket = `${hl?.color}a6`; // 0xa6 ≈ 65% opacity (codebook colors are #RRGGBB)
  if (hl && line.id === hl.start) shadow.push(`inset 0 2px 0 ${bracket}`);
  if (hl && line.id === hl.end) shadow.push(`inset 0 -2px 0 ${bracket}`);

  return (
    <div className={"lineRow" + (isR(line.speaker) ? " rspk" : "") + (selected ? " selected" : "")}
      data-lid={line.id} onMouseDown={onRowDown}
      style={shadow.length ? { boxShadow: shadow.join(",") } : undefined}>
      <span className="lid">{line.id}</span>
      <button className="ts" onClick={(e) => { e.stopPropagation(); seekVideo(line.ts); }}
        title="play from here">
        {line.ts.split(".")[0]}
      </button>
      <span className="spk">{line.speaker}</span>
      <span className="txt">{line.text}</span>
      <span className="lanes">{lanes}</span>
    </div>
  );
}
