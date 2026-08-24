// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Draggable vertical gutter between two panels. Reports the target width for an
// adjacent panel: the one to its left (default) or right (side="right"), so the
// bar stays under the cursor and re-aligns correctly at the clamp edges.
//
// While the drag runs, the width is previewed IMPERATIVELY (panel.style.width):
// a store write per mousemove re-rendered every subscriber of `ui` on every
// pixel — the sidebar's 150 rows, the transcript — and fast drags dropped
// frames. The browser's own reflow is the whole cost now, and onWidth commits
// exactly once, on release. `clamp` bounds the preview too, so the panel never
// overshoots its limits mid-drag and snaps back on commit.
export function Resizer({ onWidth, side = "left", clamp = (w) => w, onPreview }:
  { onWidth: (w: number) => void; side?: "left" | "right"; clamp?: (w: number) => number;
    /** ride along with the preview (e.g. a CSS var siblings position by) */
    onPreview?: (w: number) => void }) {
  const down = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const panel = (side === "right" ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
    if (!panel) return;
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let last = startW;
    const move = (ev: MouseEvent) => {
      // button released outside the window: the mouseup never reached us, so this
      // stray move is the first we hear of it — commit instead of dragging on
      if (ev.buttons === 0) { up(); return; }
      last = clamp(side === "right" ? startW - (ev.clientX - startX) : startW + (ev.clientX - startX));
      panel.style.width = `${last}px`;
      onPreview?.(last);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      onWidth(last); // one store write per drag; React reconciles to the same width
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  // Keyboard route: a focusable separator, arrows nudge the panel by a fixed step.
  // Discrete presses commit directly — no preview needed.
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const panel = (side === "right" ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
    if (!panel) return;
    const grow = e.key === (side === "right" ? "ArrowLeft" : "ArrowRight"); // arrows move the bar like a drag
    const w = clamp(panel.getBoundingClientRect().width + (grow ? 16 : -16));
    // set the element too: a mouse drag leaves an inline width behind, which
    // outranks a CSS-var width (the minimap) — the store write alone wouldn't move it
    panel.style.width = `${w}px`;
    onWidth(w);
  };
  return <div className="resizer" role="separator" aria-orientation="vertical"
    aria-label="Resize panel" tabIndex={0} onMouseDown={down} onKeyDown={keys} />;
}
