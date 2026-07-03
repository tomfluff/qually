import { useEffect, useRef } from "react";
import { useStore } from "../state/store";

export function SegmentPopover({ sid, x, y, onClose }: {
  sid: number; x: number; y: number; onClose: () => void;
}) {
  const seg = useStore((s) => s.segments.find((z) => z.sid === sid));
  const codebook = useStore((s) => s.codebook);
  const deleteSegment = useStore((s) => s.deleteSegment);
  const toggleReject = useStore((s) => s.toggleReject);
  const setNotes = useStore((s) => s.setNotes);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
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
        <button className="btn close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
