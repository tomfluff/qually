// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Draggable vertical gutter between two panels. Reports the target width for an
// adjacent panel: the one to its left (default) or right (side="right"), so the
// bar stays under the cursor and re-aligns correctly at the clamp edges.
export function Resizer({ onWidth, side = "left" }: { onWidth: (w: number) => void; side?: "left" | "right" }) {
  const down = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const panel = (side === "right" ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
    if (!panel) return;
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => onWidth(side === "right" ? startW - (ev.clientX - startX) : startW + (ev.clientX - startX));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return <div className="resizer" onMouseDown={down} />;
}
