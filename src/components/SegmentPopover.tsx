import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { speakerGroupedText } from "../format";
import { Icon } from "./Icon";

export function SegmentPopover({ sid, x, y, onClose }: {
  sid: number; x: number; y: number; onClose: () => void;
}) {
  const seg = useStore((s) => s.segments.find((z) => z.sid === sid));
  const codebook = useStore((s) => s.codebook);
  const deleteSegment = useStore((s) => s.deleteSegment);
  const toggleReject = useStore((s) => s.toggleReject);
  const setNotes = useStore((s) => s.setNotes);
  const ref = useRef<HTMLDivElement>(null);

  // the segment's lines as speaker-grouped text (fresh from the store)
  const segText = (): string => {
    const s = useStore.getState();
    const sg = s.segments.find((z) => z.sid === sid);
    const tr = sg ? s.transcripts[sg.pid] : undefined;
    if (!sg || !tr) return "";
    return speakerGroupedText(tr.lines.filter((l) => l.id >= sg.start && l.id <= sg.end)
      .map((l) => ({ speaker: l.speaker, text: l.text })));
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Ctrl+C while the popover is open copies the segment (App's copy handler defers to us)
    const onCopy = (e: ClipboardEvent) => {
      const t = document.activeElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // let native copy in the notes field
      const txt = segText();
      if (!txt) return;
      e.clipboardData?.setData("text/plain", txt);
      e.preventDefault();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    document.addEventListener("copy", onCopy);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("copy", onCopy);
    };
  }, [onClose]);

  if (!seg) return null;
  const range = seg.start === seg.end ? `${seg.start}` : `${seg.start}-${seg.end}`;

  return (
    <div className="pop" ref={ref}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 220) }}>
      <div>
        <span className="swatch" style={{ display: "inline-block", width: 11, height: 11, borderRadius: 3, background: codebook[seg.code]?.color || "#999", marginRight: 6 }} />
        <strong>{seg.code}</strong>
        <span className="meta">  ·  {seg.pid}:{range}  ·  {seg.proposedBy}/{seg.status}</span>
      </div>
      <textarea value={seg.notes} placeholder="notes" onChange={(e) => setNotes(sid, e.target.value)} />
      <div className="row">
        <button className="btn danger" onClick={() => { deleteSegment(sid); onClose(); }}>Delete</button>
        <button className={"btn " + (seg.status === "rejected" ? "ok" : "warn")}
          onClick={() => { toggleReject(sid); onClose(); }}>
          {seg.status === "rejected" ? "Accept" : "Reject"}
        </button>
        <button className="btn copy" onClick={() => { const t = segText(); if (t) navigator.clipboard.writeText(t); }}
          title="copy the segment (Ctrl+C)"><Icon name="copy" size={16} /></button>
        <button className="btn iconclose" onClick={onClose} title="close"><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}
