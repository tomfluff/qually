// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { speakerGroupedText } from "../format";
import { excerptOf } from "../contract/excerpt";
import { useDialogFocus } from "../useDialogFocus";
import { useDismiss, useClampToViewport } from "../usePopover";
import { groundHash } from "../ai/ground";
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
  // focus parks on the popover itself, not the notes field: with the field focused,
  // Ctrl+C would type-copy instead of copying the segment (the reflex this popover
  // advertises). Tab reaches the notes field as the first stop.
  const dialogRef = useDialogFocus({ initialFocus: "container" });
  // one element, two refs: the object ref for layout + outside-click, the focus trap's callback ref
  const setRef = useCallback((el: HTMLDivElement | null) => { ref.current = el; return dialogRef(el); }, [dialogRef]);

  // the segment's lines as speaker-grouped text (fresh from the store)
  const segText = (): string => {
    const s = useStore.getState();
    const sg = s.segments.find((z) => z.sid === sid);
    const tr = sg ? s.transcripts[sg.pid] : undefined;
    if (!sg || !tr) return "";
    return speakerGroupedText(tr.lines.filter((l) => l.id >= sg.start && l.id <= sg.end)
      .map((l) => ({ speaker: l.speaker, text: l.text })));
  };

  useClampToViewport(ref, [sidebarFontSize]);
  // let mousedowns on this segment's own lane through: the lane's click handler
  // toggles the popover, and dismissing here first would make it reopen instead
  const isOwnLane = useCallback(
    (e: MouseEvent) => !!(e.target as Element | null)?.closest?.(`[data-sid="${sid}"]`), [sid]);
  useDismiss(ref, onClose, { ignore: isOwnLane });

  useEffect(() => {
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
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!seg) return null;
  const range = seg.start === seg.end ? `${seg.start}` : `${seg.start}-${seg.end}`;
  // read-only transcript, no need to subscribe
  const tr = useStore.getState().transcripts[seg.pid];
  const ex = tr
    ? excerptOf(tr.lines.filter((l) => l.id >= seg.start && l.id <= seg.end).map((l) => ({ text: l.text, speaker: l.speaker })))
    : null;
  const closeCall = ex?.closeCall ?? false;
  // AI grounding for this segment, valid only while its hash matches (F1)
  const g = useStore.getState().aiGrounds[sid];
  const excerptText = ex?.excerpt.replace(/^\[R:\] /, "") ?? "";
  const grounds = g && excerptText && g.hash === groundHash(seg.code, excerptText) ? g.quotes : [];

  return (
    <div className="pop" ref={setRef} role="dialog" tabIndex={-1}
      aria-label={`Segment ${seg.code}, line${seg.start === seg.end ? ` ${seg.start}` : `s ${seg.start}–${seg.end}`}`}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 220), fontSize: sidebarFontSize }}>
      <div>
        <span className="swatch" style={{ display: "inline-block", width: 11, height: 11, borderRadius: 3, background: codebook[seg.code]?.color || "#999", marginRight: 6 }} />
        <strong>{seg.code}</strong>
        <span className="meta">  ·  {seg.pid}:{range}  ·  {seg.proposedBy}/{seg.status}</span>
      </div>
      {closeCall && (
        <div className="pop-warn">⚠ Near-balanced speakers — the excerpt keeps only the dominant speaker's lines, so the other speaker's substance drops out. Check this segment.</div>
      )}
      {grounds.length > 0 && (
        <div className="pop-grounds">
          <span className="pop-grounds-label">AI grounding:</span>{" "}
          {grounds.map((q, i) => <span key={i} className="pop-ground">“{q}”</span>)}
        </div>
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
