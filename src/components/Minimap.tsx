import { forwardRef, useEffect, useImperativeHandle, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { VListHandle } from "virtua";
import { laneAssign } from "../state/store";
import type { Group } from "../merge";

type LanedSeg = ReturnType<typeof laneAssign>[number];
export interface MinimapHandle { setRange: (start: number, end: number) => void; }

// A zoomed-out lane view down the right edge. Drawn from the store (virtua only
// mounts visible rows) onto a canvas; the viewport box is updated imperatively on
// scroll so the big list never re-renders. Everything maps by group index — the
// same axis virtua scrolls — so nav is exact regardless of row-height variation.
export const Minimap = forwardRef<MinimapHandle, {
  groups: Group[];
  laned: LanedSeg[];
  cols: number;
  codebook: Record<string, { color: string }>;
  vref: RefObject<VListHandle | null>;
}>(function Minimap({ groups, laned, cols, codebook, vref }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lineToGi = useRef(new Map<number, number>());
  const N = groups.length;

  // virtua child indices include the top vpad (index 0), so groups start at 1
  const applyBox = (start: number, end: number) => {
    const box = boxRef.current;
    if (!box || !N) return;
    const s = Math.max(0, start - 1);
    const e = Math.min(N - 1, end - 1);
    box.style.top = `${(s / N) * 100}%`;
    box.style.height = `${(Math.max(1, e - s + 1) / N) * 100}%`;
  };
  useImperativeHandle(ref, () => ({ setRange: applyBox }));
  // recompute the box from the list directly (used for mount/resize, when the
  // list's own scroll handler hasn't fired yet)
  const syncFromList = () => {
    const v = vref.current;
    if (v && v.viewportSize) applyBox(v.findItemIndex(v.scrollOffset), v.findItemIndex(v.scrollOffset + v.viewportSize));
  };

  useEffect(() => {
    const m = new Map<number, number>();
    groups.forEach((g, i) => g.ids.forEach((id) => m.set(id, i)));
    lineToGi.current = m;
  }, [groups]);

  // draw the lane-mirror density map (redraws on data / size / theme change)
  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const draw = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!N) return;
      const pad = 3;
      const colW = (w - pad * 2) / Math.max(1, cols);
      const m = lineToGi.current;
      for (const s of laned) {
        const gi0 = m.get(s.start) ?? 0;
        const gi1 = m.get(s.end) ?? gi0;
        const y0 = (gi0 / N) * h;
        const y1 = ((gi1 + 1) / N) * h;
        ctx.globalAlpha = s.status === "rejected" ? 0.3 : 0.9;
        ctx.fillStyle = codebook[s.code]?.color || "#999";
        ctx.fillRect(pad + s.lane * colW, y0, Math.max(1, colW - 1.5), Math.max(1.5, y1 - y0));
      }
      ctx.globalAlpha = 1;
    };
    draw();
    syncFromList();
    const ro = new ResizeObserver(() => { draw(); syncFromList(); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [groups, laned, cols, codebook, N]);

  const scrubTo = (clientY: number) => {
    const wrap = wrapRef.current, v = vref.current;
    if (!wrap || !v || !N) return;
    const r = wrap.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    v.scrollToIndex(Math.min(N - 1, Math.floor(f * N)) + 1, { align: "center" });
  };
  const onDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    scrubTo(e.clientY);
    const move = (ev: MouseEvent) => scrubTo(ev.clientY);
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  return (
    <div className="minimap" ref={wrapRef} onMouseDown={onDown} title="Click or drag to navigate">
      <canvas ref={canvasRef} />
      <div className="minimap-box" ref={boxRef} />
    </div>
  );
});
