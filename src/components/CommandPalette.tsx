import { useLayoutEffect, useState, type CSSProperties } from "react";
import { useStore } from "../state/store";
import { CodeCombobox } from "./CodeCombobox";

const W = 380, GAP = 8;
const CHROME = 108;  // header + input + padding above the results list
const FULL = 340;    // palette height with a full results list
const LIST_MAX = 240;

// Opened by the 0 key / dock tile. Anchors just above or below the selected
// lines (whichever side has more room); falls back to a centered overlay when
// no selected line is on screen.
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const selCount = useStore((s) => s.selection.lines.size);
  const palettePos = useStore((s) => s.ui.palettePos);
  const setPalette = useStore((s) => s.setPalette);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; listMax: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || palettePos === "centered") { setPos(null); return; } // forced centered
    const els = document.querySelectorAll<HTMLElement>(".lineRow.selected");
    if (!els.length) { setPos(null); return; } // centered fallback
    let top = Infinity, bottom = -Infinity, cx = 0;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      if (i === 0) cx = r.left + r.width / 2;
    });
    const left = Math.max(8, Math.min(window.innerWidth - W - 8, cx - W / 2));
    const below = window.innerHeight - (bottom + GAP);
    const above = top - GAP;
    if (Math.max(below, above) < CHROME + 120) { setPos(null); return; } // too tight -> centered
    // prefer the side that fits the full palette; else the roomier side
    const placeBelow = below >= FULL ? true : above >= FULL ? false : below >= above;
    const avail = placeBelow ? below : above;
    const listMax = Math.max(120, Math.min(LIST_MAX, avail - CHROME)); // cap list so it can't clip
    setPos(placeBelow
      ? { top: bottom + GAP, left, listMax }
      : { bottom: window.innerHeight - top + GAP, left, listMax });
  }, [open, palettePos]);

  if (!open) return null;
  const anchored = pos !== null;
  // the combobox autofocused on open; on close hand focus back to the transcript
  // list (it would fall to <body>), so the arrow-key selection flow keeps working
  const close = () => { setPalette(false); document.querySelector<HTMLElement>(".tviewlist")?.focus(); };
  return (
    <div className={"palette-backdrop" + (anchored ? " anchored" : "")} onMouseDown={close}>
      <div className={"palette" + (anchored ? " palette-anchored" : "")}
        style={anchored ? {
          position: "fixed", left: pos!.left, top: pos!.top, bottom: pos!.bottom, width: W,
          "--ac-max": `${pos!.listMax}px`,
        } as CSSProperties : undefined}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          {selCount > 0
            ? `Code ${selCount} selected line${selCount > 1 ? "s" : ""}`
            : "No lines selected — this will just create the code"}
        </div>
        <CodeCombobox autoFocus placeholder="Search or create a code…" onClose={close} />
      </div>
    </div>
  );
}
