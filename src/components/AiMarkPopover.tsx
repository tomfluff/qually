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
export function AiMarkPopover({ pid, line, span, x, y, onClose, onCycle }: {
  pid: string; line: number; span: Flag; x: number; y: number; onClose: () => void;
  onCycle?: () => void; // M pressed inside the popover: advance to the line's next mark
}) {
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const applyFix = useStore((s) => s.applyFix);
  // reading words nobody spoke: the repair below writes the spoken line
  const lang = useStore((s) => s.ui.lang);
  const readingTranslated = useStore((s) =>
    lang === "en" && !!s.transcripts[pid]?.lines.some((l) => l.en?.trim()));
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
  // a mousedown on any AI mark is the toggle's business, not an outside click
  useDismiss(ref, onClose, { ignore: (e) => !!(e.target as Element | null)?.closest?.("[data-ai]") });

  return (
    <div className="pop aipop" ref={setRef} role="dialog" tabIndex={-1}
      // focus lives in here while open, so the transcript's own M handler can't
      // hear the key — forward it to keep the open→cycle→cycle rhythm working
      onKeyDown={(e) => { if (e.key === "m" || e.key === "M") { e.preventDefault(); onCycle?.(); } }}
      aria-label={`${lens?.label ?? "AI observation"} on line ${line}`}
      style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 200), fontSize: sidebarFontSize }}>
      <div className="row aipop-head">
        <span className="swatch" style={{ background: lens?.color ?? "#999" }} aria-hidden="true" />
        <strong>{lens?.label ?? spanLens(span)}</strong>
        <button className="btn iconclose" onClick={() => {
          dismissNotice(pid, line, spanLens(span), span.quote);
          announce("Mark dismissed");
          onClose();
        }} data-tip="Dismiss this mark (it won't return on re-scan)"
          aria-label="Dismiss this observation"><Icon name="trash" size={16} /></button>
        <button className="btn iconclose" onClick={onClose} data-tip="close" aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
      <div className="aipop-quote">“{span.quote}”</div>
      <div className="aipop-reason">{span.reason}</div>
      {isError && span.fix && (
        <div className="row">
          {/* A repair rewrites what was SPOKEN, so it cannot run while a
              translation is on screen — the store refuses, which is what keeps
              a translation out of the source. The button used to fire anyway
              and announce "Fixed", so the app claimed to have changed the
              transcript and had not. Now it says which switch to throw, and
              the announcement follows what actually happened in every case,
              including a mark whose quote an edit has since moved. */}
          <button className="btn primary" disabled={readingTranslated}
            title={readingTranslated ? "Switch to Source to correct the transcript" : undefined}
            onClick={() => {
              const done = applyFix(pid, line, span.quote, span.fix!);
              announce(done
                ? `Fixed: “${span.quote}” is now “${span.fix}”`
                : `Could not apply: “${span.quote}” is no longer in this line`);
              onClose();
            }}>Apply fix: “{span.fix}”</button>
          {readingTranslated && (
            <span className="aipop-note">Switch to <b>Source</b> to correct the transcript.</span>
          )}
        </div>
      )}
    </div>
  );
}
