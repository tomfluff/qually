import { useMemo, useState, type MouseEvent } from "react";
import { VList } from "virtua";
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
  const pushUndo = useStore((s) => s.pushUndo);
  const setSegmentRange = useStore((s) => s.setSegmentRange);
  const [pop, setPop] = useState<{ sid: number; x: number; y: number } | null>(null);

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

  if (!transcript) {
    return <div className="empty">Import transcript CSVs to begin (Import files…).</div>;
  }

  return (
    <>
      <VList style={{ height: "100%", fontSize }}>
        {transcript.lines.map((l) => (
          <Row
            key={l.id}
            line={l}
            selected={!!selLines?.has(l.id)}
            cols={cols}
            laned={laned}
            codebook={codebook}
            onSelect={(e) => selectLine(l.id, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
            onLaneClick={(seg, e) => setPop({ sid: seg.sid, x: e.clientX, y: e.clientY })}
            onGripDown={dragEdge}
          />
        ))}
      </VList>
      {pop && <SegmentPopover sid={pop.sid} x={pop.x} y={pop.y} onClose={() => setPop(null)} />}
    </>
  );
}

function Row({ line, selected, cols, laned, codebook, onSelect, onLaneClick, onGripDown }: {
  line: Line;
  selected: boolean;
  cols: number;
  laned: LanedSeg[];
  codebook: Record<string, { color: string }>;
  onSelect: (e: MouseEvent) => void;
  onLaneClick: (seg: LanedSeg, e: MouseEvent) => void;
  onGripDown: (e: MouseEvent, seg: LanedSeg, which: "start" | "end") => void;
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
        onClick={(e) => { e.stopPropagation(); onLaneClick(seg, e); }}>
        {seg.start === line.id && <span className="grip gripTop" onMouseDown={(e) => onGripDown(e, seg, "start")} />}
        {seg.end === line.id && <span className="grip gripBot" onMouseDown={(e) => onGripDown(e, seg, "end")} />}
      </span>
    );
  }
  return (
    <div className={"lineRow" + (isR(line.speaker) ? " rspk" : "") + (selected ? " selected" : "")}
      data-lid={line.id} onClick={onSelect}>
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
