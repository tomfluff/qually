// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useLayoutEffect, useRef } from "react";
import { useStore } from "../state/store";
import { lensOf, spanLens, type Flag } from "../ai/flag";
import { useDialogFocus } from "../useDialogFocus";
import { useDismiss, useClampToViewport } from "../usePopover";
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

  // reset the inline anchor before the clamp measures: if this instance is ever
  // reused for a new mark, React can skip the style write when the inline value
  // is unchanged, leaving the previous clamp's manual left/top in place
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = Math.min(x, window.innerWidth - 300) + "px";
    el.style.top = Math.min(y, window.innerHeight - 200) + "px";
  }, [sidebarFontSize, x, y]);
  useClampToViewport(ref, [sidebarFontSize, x, y]);
  useDismiss(ref, onClose);

  return (
    <div className="pop aipop" ref={setRef} role="dialog" tabIndex={-1}
      aria-label={`${lens?.label ?? "AI mark"} on line ${line}`}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 200), fontSize: sidebarFontSize }}>
      <div className="row aipop-head">
        <span className="swatch" style={{ background: lens?.color ?? "#999" }} aria-hidden="true" />
        <strong>{lens?.label ?? spanLens(span)}</strong>
        <button className="btn iconclose" onClick={() => {
          dismissNotice(pid, line, spanLens(span), span.quote);
          announce("Mark dismissed");
          onClose();
        }} data-tip="Dismiss this mark (it won't return on re-scan)"
          aria-label="Dismiss this mark"><Icon name="trash" size={16} /></button>
        <button className="btn iconclose" onClick={onClose} data-tip="close" aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
      <div className="aipop-quote">“{span.quote}”</div>
      <div className="aipop-reason">{span.reason}</div>
      {isError && span.fix && (
        <div className="row">
          <button className="btn primary" onClick={() => {
            applyFix(pid, line, span.quote, span.fix!);
            announce(`Fixed: “${span.quote}” is now “${span.fix}”`);
            onClose();
          }}>Apply fix: “{span.fix}”</button>
        </div>
      )}
    </div>
  );
}
