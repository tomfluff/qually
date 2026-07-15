// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "../state/store";
import { speakerGroupedText } from "../format";
import { excerptOf } from "../contract/excerpt";
import { Icon } from "./Icon";

export function SegmentPopover({ sid, x, y, onClose }: {
  sid: number; x: number; y: number; onClose: () => void;
}) {
  const seg = useStore((s) => s.segments.find((z) => z.sid === sid));
  const codebook = useStore((s) => s.codebook);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const deleteSegment = useStore((s) => s.deleteSegment);
  const setStatus = useStore((s) => s.setStatus);
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

  // The popover grows with the sidebar text size, so a fixed clamp can't keep it
  // on screen — measure the real box and pull it back inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    if (r.right > window.innerWidth - pad)
      el.style.left = Math.max(pad, window.innerWidth - r.width - pad) + "px";
    if (r.bottom > window.innerHeight - pad)
      el.style.top = Math.max(pad, window.innerHeight - r.height - pad) + "px";
  }, [sidebarFontSize]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // stopPropagation so App's global Esc doesn't also clear the line selection
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Ctrl+C while the popover is open copies the segment (App's copy handler defers to us)
    const onCopy = (e: ClipboardEvent) => {
      const t = document.activeElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // let native copy in the notes field
      if (window.getSelection()?.toString().trim()) return; // let a real text selection copy itself
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
  // read-only transcript, no need to subscribe
  const tr = useStore.getState().transcripts[seg.pid];
  const closeCall = tr
    ? excerptOf(tr.lines.filter((l) => l.id >= seg.start && l.id <= seg.end).map((l) => ({ text: l.text, speaker: l.speaker }))).closeCall
    : false;

  return (
    <div className="pop" ref={ref}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 220), fontSize: sidebarFontSize }}>
      <div>
        <span className="swatch" style={{ display: "inline-block", width: 11, height: 11, borderRadius: 3, background: codebook[seg.code]?.color || "#999", marginRight: 6 }} />
        <strong>{seg.code}</strong>
        <span className="meta">  ·  {seg.pid}:{range}  ·  {seg.proposedBy}/{seg.status}</span>
      </div>
      {closeCall && (
        <div className="pop-warn">⚠ Near-balanced speakers — the excerpt keeps only the dominant speaker's lines, so the other speaker's substance drops out. Check this segment.</div>
      )}
      <textarea value={seg.notes} placeholder="notes" onChange={(e) => setNotes(sid, e.target.value)} />
      <div className="row">
        <button className="btn danger" onClick={() => { deleteSegment(sid); onClose(); }}>Delete</button>
        {seg.status !== "accepted" && seg.status !== "rejected" ? (
          // a suggestion under review gets a real verdict pair, not a reject-toggle
          <>
            <button className="btn ok" onClick={() => { setStatus(sid, "accepted"); onClose(); }}>Accept</button>
            <button className="btn warn" onClick={() => { setStatus(sid, "rejected"); onClose(); }}>Reject</button>
          </>
        ) : (
          <button className={"btn " + (seg.status === "rejected" ? "ok" : "warn")}
            onClick={() => { setStatus(sid, seg.status === "rejected" ? "accepted" : "rejected"); onClose(); }}>
            {seg.status === "rejected" ? "Accept" : "Reject"}
          </button>
        )}
        <button className="btn copy" onClick={() => { const t = segText(); if (t) navigator.clipboard.writeText(t); }}
          title="copy the segment (Ctrl+C)"><Icon name="copy" size={16} /></button>
        <button className="btn iconclose" onClick={onClose} title="close"><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}
