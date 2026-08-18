// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { forwardRef, useEffect, useImperativeHandle, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { VListHandle } from "virtua";
import { laneAssign, speakerColor, weightOf } from "../state/store";
import type { Ui } from "../state/store";
import { lensOf, spanLens, type Flag } from "../ai/flag";
import { markerColor, markerKey } from "../markers";
import type { Item } from "./TranscriptView";

type LanedSeg = ReturnType<typeof laneAssign>[number];
export interface MinimapHandle { setRange: (start: number, end: number) => void; }
const WARN = "#e0a020";
// The glyph header naming each zone (design lab option 1, "Ruled zones"): 12px
// spent once so the columns explain themselves — ◆ events · ¶ speech · ✦ AI
// notices · ▮ code lanes. Every y below maps into the space UNDER it.
const HDR = 12;
// canvas needs concrete colours: blend `c` over `bg` at `p` (both computed rgb/hex)
const parseC = (c: string): [number, number, number] => {
  const m = c.match(/\d+(\.\d+)?/g);
  if (c.startsWith("#")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
  return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
};
const blend = (c: string, bg: string, p: number) => {
  const a = parseC(c), b = parseC(bg);
  return `rgb(${a.map((v, i) => Math.round(v * p + b[i] * (1 - p))).join(",")})`;
};

// A zoomed-out lane view down the right edge. Drawn from the store (virtua only
// mounts visible rows) onto a canvas; the viewport box is updated imperatively on
// scroll so the big list never re-renders. Everything maps by group index — the
// same axis virtua scrolls — so nav is exact regardless of row-height variation.
export const Minimap = forwardRef<MinimapHandle, {
  // the SAME rows the list holds (lines and session events), so an index here and
  // an index there mean the same place
  items: Item[];
  laned: LanedSeg[];
  cols: number;
  codebook: Record<string, { color: string }>;
  closeCallSids: Set<number>;
  flagsByLine: Map<number, Flag[]>; // the transcript's VISIBLE marks (already lens-filtered)
  detail: "detailed" | "simplified";
  ui: Ui; // speaker colours + weights; the minimap was the LAST place still hardcoding "R"
  vref: RefObject<VListHandle | null>;
  onNav?: () => void; // stop the list's scroll animations before a scrub jump, or they overwrite it
}>(function Minimap({ items, laned, cols, codebook, closeCallSids, flagsByLine, detail, ui, vref, onNav }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<(() => void) | null>(null); // latest draw closure, for the mount-only observer
  const syncRef = useRef<(() => void) | null>(null); // ditto — syncFromList closes over N
  const lineToGi = useRef(new Map<number, number>());
  const N = items.length;

  // virtua child indices include the top vpad (index 0), so groups start at 1
  const applyBox = (start: number, end: number) => {
    const box = boxRef.current, wrap = wrapRef.current;
    if (!box || !wrap || !N) return;
    const s = Math.max(0, start - 1);
    const e = Math.min(N - 1, end - 1);
    // px, not %: the content area starts under the glyph header
    const mh = wrap.clientHeight - HDR;
    box.style.top = `${HDR + (s / N) * mh}px`;
    box.style.height = `${(Math.max(1, e - s + 1) / N) * mh}px`;
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
    items.forEach((it, i) => { if (it.kind === "g") it.g.ids.forEach((id) => m.set(id, i)); });
    lineToGi.current = m;
  }, [items]);

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
      // Session events: ONE COLUMN PER TYPE, before the speaker rail. Sharing a
      // single lane meant two types at the same scroll position drew over each
      // other, and a type had no fixed x to scan down — "where did the breaks
      // happen" was unanswerable. Columns follow first appearance (i.e. time),
      // the same order the sidebar's Events list groups by.
      const mkKeys: string[] = [];
      const mkCol = new Map<string, number>();
      for (const it of items) {
        if (it.kind !== "m") continue;
        const k = markerKey(it.m);
        if (!mkCol.has(k)) { mkCol.set(k, mkKeys.length); mkKeys.push(k); }
      }
      // The band is capped as a share of the width — a study with a dozen event
      // types must not crowd out the code lanes — so columns thin out rather than
      // the band growing. No events, no band: the space goes back to the text bars.
      // Sized by PITCH, so the band can never exceed its budget: a minimum column
      // width would have won against the cap and pushed the band straight over the
      // code lanes once a study ran past ~8 event types. Columns thin (and the gap
      // with them) instead; widening the minimap widens the budget.
      const mkBandMax = w * (simple ? 0.3 : 0.26);
      const mkPitch = mkKeys.length
        ? Math.min((simple ? 5 : 3) + 1, mkBandMax / mkKeys.length) : 0;
      const mkGap = Math.min(1, mkPitch * 0.25);
      const mkW = mkKeys.length ? Math.max(0.8, mkPitch - mkGap) : 0;
      const mkBandW = mkKeys.length * mkPitch;
      const mkX = warnW + 2;
      // speaker rail: WHO is talking, as its own channel. Deliberately a separate strip
      // rather than tinting the text bars — the text bars stay a pure "how much was
      // said" signal, and the two colour systems (speaker, code) never share a column.
      const railW = simple ? 6 : 4;
      const railX = mkX + mkBandW + (mkBandW ? 2 : 0);
      // AI-mark channel: WHERE the machine noticed something, next to WHO said it.
      // Its own thin strip in the lens's colour (amber = transcription error), so
      // machine marks never share a column with human coding.
      const noticeW = simple ? 5 : 3;
      const noticeX = railX + railW + 2;
      const textX = noticeX + noticeW + 3;
      // lanes are sized from the right but must never cross INTO the notice
      // strip: at 66px simplified with an events band the old math let the two
      // overlap, and the new zone rules turned that quiet collision into a mess
      const laneAreaW = Math.max(simple ? 8 : 6, Math.min(
        w * (simple ? 0.6 : 0.5), cols * (simple ? 10 : 7), w - (noticeX + noticeW + 4)));
      const laneX = w - laneAreaW - 2;
      const colW = laneAreaW / Math.max(1, cols);
      // The rail costs the text bars width. At the narrowest minimap (44px, simplified)
      // textX runs PAST laneX and the bars would be drawn on top of the code lanes — so
      // below a usable width, drop the bars entirely: "who" and "which code" are worth
      // more than "how much was said" when there are only 44 pixels to say it in.
      const textAvail = laneX - textX - 3;
      const showText = textAvail >= 3;
      const textW = Math.max(4, textAvail);
      const codeMinH = simple ? 5 : 1.5;
      const warnMinH = simple ? 6 : 2.5;
      const cs = getComputedStyle(cv);
      const muted = cs.getPropertyValue("--muted").trim() || "#888";
      const lineC = cs.getPropertyValue("--line").trim() || "#444";
      const accentC = cs.getPropertyValue("--accent").trim() || "#6d28d9";
      const panelC = cs.getPropertyValue("--panel").trim() || "#f6f6f6";
      // content rows live UNDER the glyph header
      const mh = h - HDR;
      const yOf = (i: number) => HDR + (i / N) * mh;

      // ── zone furniture (lab option 1, "Ruled zones"): a whisper of accent
      // tint behind the machine zones (events 2.5%, AI + lanes 5%), a hairline
      // between every zone, and a glyph cap naming each column group.
      const tint5 = blend(accentC, panelC, 0.05), tint25 = blend(accentC, panelC, 0.025);
      if (mkBandW) { ctx.fillStyle = tint25; ctx.fillRect(mkX - 1, 0, mkBandW + 2, h); }
      ctx.fillStyle = tint5;
      ctx.fillRect(noticeX - 1, 0, noticeW + 2, h);
      ctx.fillRect(laneX - 1, 0, laneAreaW + 2, h);
      ctx.fillStyle = lineC;
      for (const rx of [mkX - 2, railX - 2, noticeX - 2, laneX - 2])
        if (rx > 0) ctx.fillRect(Math.round(rx), 0, 1, h);
      ctx.fillStyle = muted;
      ctx.font = "9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (mkBandW) ctx.fillText("\u25c6", mkX + mkBandW / 2, HDR / 2 - 1);      // ◆ events
      if (showText) ctx.fillText("\u00b6", railX + (textX + textW - railX) / 2, HDR / 2 - 1); // ¶ speech
      ctx.fillText("\u2726", noticeX + noticeW / 2, HDR / 2 - 1);                // ✦ AI
      ctx.fillText("\u25ae", laneX + laneAreaW / 2, HDR / 2 - 1);                // ▮ codes

      ctx.fillStyle = muted;
      if (simple) {
        // blocky text: bucket the height; block width ≈ the bucket's text amount
        // (avg line fill), tinted by the bucket's dominant speaker
        const bh = 6;
        const CAP = 80; // chars for a "full" line
        const nb = Math.max(1, Math.ceil(mh / bh));
        // Each bucket keeps its DOMINANT speaker (most characters spoken in it) rather
        // than a P-vs-R split — that split assumed two speakers and the "R" convention,
        // and collapsed a whole focus group into "not the researcher".
        const buckets = Array.from({ length: nb }, () => ({
          chars: 0, n: 0, by: new Map<string, number>(),
        }));
        for (let i = 0; i < N; i++) {
          const it = items[i];
          if (it.kind !== "g") continue; // event rows draw their own full-width mark below
          const g = it.g;
          const k = Math.min(nb - 1, Math.floor(((i / N) * mh) / bh));
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
          const w = weightOf(ui, top);
          ctx.globalAlpha = 0.95; // rail = pure speaker identity; weight lives in the bar
          ctx.fillStyle = speakerColor(ui, top);
          ctx.fillRect(railX, HDR + k * bh, railW, bh - 1);
          if (showText) {
            // the bar's WIDTH is how much was said; its ALPHA is the speaker's
            // weight (quiet < normal < bold) — the one channel that carries weight
            ctx.globalAlpha = w === "bold" ? 0.85 : w === "quiet" ? 0.3 : 0.55;
            ctx.fillStyle = muted;
            ctx.fillRect(textX, HDR + k * bh, Math.max(3, Math.min(1, b.chars / (b.n * CAP)) * textW), bh - 1);
          }
        }
      } else {
        // detailed: a speaker rail (pure identity — WHO) beside one text bar per
        // group. The bar's WIDTH is how much was said; its ALPHA is the speaker's
        // weight (quiet < normal < bold). Weight rides one channel — the bar — not
        // the rail, so "who" and "how emphasised" never share a mark. (The rail no
        // longer dims for the interviewer; the bar carries that now.)
        const CAP = 80;
        for (let i = 0; i < N; i++) {
          const it = items[i];
          if (it.kind !== "g") continue; // ditto
          const g = it.g;
          const w = weightOf(ui, g.speaker);
          const y = yOf(i), bh = Math.max(0.6, (mh / N) * 0.7);
          ctx.globalAlpha = 0.95; // rail = pure speaker identity
          ctx.fillStyle = speakerColor(ui, g.speaker);
          ctx.fillRect(railX, y, railW, Math.max(0.8, bh));
          if (showText) {
            const len = g.lines.reduce((s, l) => s + l.text.trim().length, 0);
            ctx.globalAlpha = w === "bold" ? 0.8 : w === "quiet" ? 0.28 : 0.5;
            ctx.fillStyle = muted;
            ctx.fillRect(textX, y, Math.max(2, Math.min(1, len / CAP) * textW), bh);
          }
        }
      }

      // AI marks (the ticks mirror what the transcript currently SHOWS — the eye
      // and per-lens filters apply here too, via flagsByLine). A group with marks
      // from several lenses splits its tick vertically into their colours.
      const noticeMinH = simple ? 5 : 2;
      for (let i = 0; i < N; i++) {
        const it = items[i];
        if (it.kind !== "g") continue;
        const colors: string[] = [];
        for (const id of it.g.ids) for (const f of flagsByLine.get(id) ?? []) {
          const c = lensOf(spanLens(f))?.color ?? WARN;
          if (!colors.includes(c)) colors.push(c);
        }
        if (!colors.length) continue;
        const y = yOf(i), bh = Math.max(noticeMinH, (mh / N) * 0.85);
        const seg = bh / Math.min(colors.length, 4);
        colors.slice(0, 4).forEach((c, k) => {
          ctx.globalAlpha = 1; ctx.fillStyle = c;
          ctx.fillRect(noticeX, y + k * seg, noticeW, Math.max(1, seg - 0.5));
        });
      }

      // segment lanes + close-call markers in the left gutter
      for (const s of laned) {
        const gi0 = m.get(s.start) ?? 0;
        const gi1 = m.get(s.end) ?? gi0;
        const y0 = yOf(gi0);
        const y1 = yOf(gi1 + 1);
        ctx.globalAlpha = s.status === "rejected" ? 0.3 : s.status !== "accepted" ? 0.55 : 0.9;
        ctx.fillStyle = codebook[s.code]?.color || "#999";
        ctx.fillRect(laneX + s.lane * colW, y0, Math.max(1, colW - 1.5), Math.max(codeMinH, y1 - y0));
        if (s.status !== "rejected" && closeCallSids.has(s.sid)) {
          ctx.globalAlpha = 1; ctx.fillStyle = WARN;
          ctx.fillRect(0, y0, warnW, Math.max(warnMinH, y1 - y0));
        }
      }

      // session events: a tick in the type's own column, sized like the AI-notice
      // ticks so a single event stays findable at any transcript length
      const mkMinH = simple ? 5 : 3;
      for (let i = 0; i < N; i++) {
        const it = items[i];
        if (it.kind !== "m") continue;
        const key = markerKey(it.m);
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = markerColor(key, ui.markerColors);
        ctx.fillRect(mkX + (mkCol.get(key) ?? 0) * mkPitch, yOf(i),
          mkW, Math.max(mkMinH, (mh / N) * 0.85));
      }
      ctx.globalAlpha = 1;
    };
    draw();
    syncFromList();
    drawRef.current = draw; syncRef.current = syncFromList; // the mount-only observer calls through these
  }, [items, laned, cols, codebook, closeCallSids, flagsByLine, detail, N,
      ui.speakerColors, ui.speakerWeight, // recolour the rail when the speaker map changes
      ui.markerColors, // and the event lane when a type is recoloured
      ui.dark]); // repaint on theme flip so the muted amount-bars pick up the new --muted

  // ONE observer for the component's lifetime: re-creating it on every data-dep
  // change made each repaint cost two full draws (the fresh observe() fires the
  // callback immediately on top of the effect's own draw)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => { drawRef.current?.(); syncRef.current?.(); });
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrubTo = (clientY: number) => {
    const wrap = wrapRef.current, v = vref.current;
    if (!wrap || !v || !N) return;
    onNav?.();
    const r = wrap.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientY - r.top - HDR) / (r.height - HDR)));
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
      {/* pure visual duplicate of the transcript — hidden from screen readers
          (the wrapper stays exposed: it's the mouse scrub target) */}
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="minimap-box" ref={boxRef} aria-hidden="true" />
    </div>
  );
});
