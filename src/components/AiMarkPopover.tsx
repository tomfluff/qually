// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "../state/store";
import { lensOf, spanLens, type Flag } from "../ai/flag";
import { useDialogFocus } from "../useDialogFocus";
import { announce } from "../announce";
import { Icon } from "./Icon";

// Clicking an AI mark opens this instead of a pinned tooltip: the tooltip is
// pointer-events:none by design, and this needs buttons (apply fix, dismiss)
// and selectable text. Same conventions as SegmentPopover: fixed at the mark,
// sized from the sidebar text setting, outside-click / Escape to close.
export function AiMarkPopover({ pid, line, span, x, y, onClose }: {
  pid: string; line: number; span: Flag; x: number; y: number; onClose: () => void;
}) {
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const applyFix = useStore((s) => s.applyFix);
  const ref = useRef<HTMLDivElement>(null);
  const dialogRef = useDialogFocus({ initialFocus: "container" });
  const setRef = useCallback((el: HTMLDivElement | null) => { ref.current = el; return dialogRef(el); }, [dialogRef]);

  const isError = spanLens(span) === "transcription";
  const lens = lensOf(spanLens(span));

  // measure and pull back inside the viewport (the box scales with the text size)
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
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    // stopPropagation so App's global Esc doesn't also clear the line selection
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [onClose]);

  return (
    <div className="pop aipop" ref={setRef} role="dialog" tabIndex={-1}
      aria-label={`${lens?.label ?? "AI mark"} on line ${line}`}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 200), fontSize: sidebarFontSize }}>
      <div className="row aipop-head">
        <span className="swatch" style={{ background: lens?.color ?? "#999" }} aria-hidden="true" />
        <strong>{lens?.label ?? spanLens(span)}</strong>
        <button className="btn iconclose" onClick={onClose} title="close"><Icon name="x" size={16} /></button>
      </div>
      <div className="aipop-quote">“{span.quote}”</div>
      <div className="aipop-reason">{span.reason}</div>
      <div className="row">
        {isError && span.fix && (
          <button className="btn primary" onClick={() => {
            applyFix(pid, line, span.quote, span.fix!);
            announce(`Fixed: “${span.quote}” is now “${span.fix}”`);
            onClose();
          }}>Apply fix: “{span.fix}”</button>
        )}
        <button className="btn" onClick={() => {
          dismissNotice(pid, line, spanLens(span), span.quote);
          announce("Mark dismissed");
          onClose();
        }}>Dismiss</button>
      </div>
    </div>
  );
}
