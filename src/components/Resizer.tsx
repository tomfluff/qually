// Draggable vertical gutter between two panels. Reports the target width for
// the panel immediately to its left, computed as startWidth + (cursorX - startX)
// so the bar stays under the cursor and re-aligns correctly at the clamp edges.
export function Resizer({ onWidth }: { onWidth: (w: number) => void }) {
  const down = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const panel = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null;
    if (!panel) return;
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => onWidth(startW + (ev.clientX - startX));
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
