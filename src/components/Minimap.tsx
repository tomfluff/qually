import { forwardRef, useEffect, useImperativeHandle, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { VListHandle } from "virtua";
import { laneAssign, speakerColor, weightOf } from "../state/store";
import type { Ui } from "../state/store";
import type { Group } from "../merge";

type LanedSeg = ReturnType<typeof laneAssign>[number];
export interface MinimapHandle { setRange: (start: number, end: number) => void; }
const WARN = "#e0a020";

// A zoomed-out lane view down the right edge. Drawn from the store (virtua only
// mounts visible rows) onto a canvas; the viewport box is updated imperatively on
// scroll so the big list never re-renders. Everything maps by group index — the
// same axis virtua scrolls — so nav is exact regardless of row-height variation.
export const Minimap = forwardRef<MinimapHandle, {
  groups: Group[];
  laned: LanedSeg[];
  cols: number;
  codebook: Record<string, { color: string }>;
  closeCallSids: Set<number>;
  detail: "detailed" | "simplified";
  ui: Ui; // speaker colours + weights; the minimap was the LAST place still hardcoding "R"
  vref: RefObject<VListHandle | null>;
}>(function Minimap({ groups, laned, cols, codebook, closeCallSids, detail, ui, vref }, ref) {
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
      const m = lineToGi.current;
      const simple = detail === "simplified";
      // columns: [0..warnW] warnings gutter · text · lane columns (flush right).
      // simplified widens everything and enforces min sizes so marks stay obvious.
      const warnW = simple ? 6 : 4;
      // speaker rail: WHO is talking, as its own channel. Deliberately a separate strip
      // rather than tinting the text bars — the text bars stay a pure "how much was
      // said" signal, and the two colour systems (speaker, code) never share a column.
      const railW = simple ? 6 : 4;
      const railX = warnW + 2;
      const laneAreaW = Math.min(w * (simple ? 0.6 : 0.5), cols * (simple ? 10 : 7));
      const laneX = w - laneAreaW - 2;
      const colW = laneAreaW / Math.max(1, cols);
      const textX = railX + railW + 3;
      // The rail costs the text bars width. At the narrowest minimap (44px, simplified)
      // textX runs PAST laneX and the bars would be drawn on top of the code lanes — so
      // below a usable width, drop the bars entirely: "who" and "which code" are worth
      // more than "how much was said" when there are only 44 pixels to say it in.
      const textAvail = laneX - textX - 3;
      const showText = textAvail >= 3;
      const textW = Math.max(4, textAvail);
      const codeMinH = simple ? 5 : 1.5;
      const warnMinH = simple ? 6 : 2.5;
      const muted = getComputedStyle(cv).getPropertyValue("--muted").trim() || "#888";

      ctx.fillStyle = muted;
      if (simple) {
        // blocky text: bucket the height; block width ≈ the bucket's text amount
        // (avg line fill), tinted by the bucket's dominant speaker
        const bh = 6;
        const CAP = 80; // chars for a "full" line
        const nb = Math.max(1, Math.ceil(h / bh));
        // Each bucket keeps its DOMINANT speaker (most characters spoken in it) rather
        // than a P-vs-R split — that split assumed two speakers and the "R" convention,
        // and collapsed a whole focus group into "not the researcher".
        const buckets = Array.from({ length: nb }, () => ({
          chars: 0, n: 0, by: new Map<string, number>(),
        }));
        for (let i = 0; i < N; i++) {
          const g = groups[i];
          const k = Math.min(nb - 1, Math.floor(((i / N) * h) / bh));
          const len = g.lines.reduce((s, l) => s + l.text.trim().length, 0);
          const b = buckets[k];
          b.chars += len; b.n++;
          b.by.set(g.speaker, (b.by.get(g.speaker) ?? 0) + len);
        }
        for (let k = 0; k < nb; k++) {
          const b = buckets[k];
          if (!b.n || !b.chars) continue;
          let top = "", best = -1;
          for (const [sp, c] of b.by) if (c > best) { best = c; top = sp; }
          const quiet = weightOf(ui, top) === "quiet";
          ctx.globalAlpha = quiet ? 0.45 : 0.95;
          ctx.fillStyle = speakerColor(ui, top);
          ctx.fillRect(railX, k * bh, railW, bh - 1);
          if (showText) {
            ctx.globalAlpha = quiet ? 0.3 : 0.55;
            ctx.fillStyle = muted;
            ctx.fillRect(textX, k * bh, Math.max(3, Math.min(1, b.chars / (b.n * CAP)) * textW), bh - 1);
          }
        }
      } else {
        // detailed: a speaker rail beside one faint text bar per group (width ∝ length).
        // Quiet speakers fade in BOTH channels — driven by the weight you actually set,
        // not by whether the label happens to start with "R".
        const CAP = 80;
        for (let i = 0; i < N; i++) {
          const g = groups[i];
          const quiet = weightOf(ui, g.speaker) === "quiet";
          const y = (i / N) * h, bh = Math.max(0.6, (h / N) * 0.7);
          ctx.globalAlpha = quiet ? 0.45 : 0.95;
          ctx.fillStyle = speakerColor(ui, g.speaker);
          ctx.fillRect(railX, y, railW, Math.max(0.8, bh));
          if (showText) {
            const len = g.lines.reduce((s, l) => s + l.text.trim().length, 0);
            ctx.globalAlpha = quiet ? 0.28 : 0.5;
            ctx.fillStyle = muted;
            ctx.fillRect(textX, y, Math.max(2, Math.min(1, len / CAP) * textW), bh);
          }
        }
      }

      // segment lanes + close-call markers in the left gutter
      for (const s of laned) {
        const gi0 = m.get(s.start) ?? 0;
        const gi1 = m.get(s.end) ?? gi0;
        const y0 = (gi0 / N) * h;
        const y1 = ((gi1 + 1) / N) * h;
        ctx.globalAlpha = s.status === "rejected" ? 0.3 : s.status !== "accepted" ? 0.55 : 0.9;
        ctx.fillStyle = codebook[s.code]?.color || "#999";
        ctx.fillRect(laneX + s.lane * colW, y0, Math.max(1, colW - 1.5), Math.max(codeMinH, y1 - y0));
        if (s.status !== "rejected" && closeCallSids.has(s.sid)) {
          ctx.globalAlpha = 1; ctx.fillStyle = WARN;
          ctx.fillRect(0, y0, warnW, Math.max(warnMinH, y1 - y0));
        }
      }
      ctx.globalAlpha = 1;
    };
    draw();
    syncFromList();
    const ro = new ResizeObserver(() => { draw(); syncFromList(); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [groups, laned, cols, codebook, closeCallSids, detail, N,
      ui.speakerColors, ui.speakerWeight]); // recolour the rail when the speaker map changes

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
