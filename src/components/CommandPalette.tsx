// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useLayoutEffect, useState, type CSSProperties } from "react";
import { useStore } from "../state/store";
import { CodeCombobox } from "./CodeCombobox";

// Shared with AddEventModal — the two anchored cards must stay the same size
// family or a tweak to one silently desynchronises the pair.
export const GAP = 8;
// sized in the panel ramp's own units, not fixed px: at 22px panel text a 380px
// palette crowds its hint line and clips long code names in the list
export const widthFor = (fs: number) => Math.max(320, Math.min(Math.round(fs * 29), window.innerWidth - 16));
const CHROME = 8.3;   // header + input + padding above the results list, in em
const FULL = 26;      // palette height with a full results list, in em
const LIST_MAX = 240; // px, deliberately absolute: caps the LIST, not the chrome

// Opened by the 0 key / dock tile. Anchors just above or below the selected
// lines (whichever side has more room); falls back to a centered overlay when
// no selected line is on screen.
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const selCount = useStore((s) => s.selection.lines.size);
  const palettePos = useStore((s) => s.ui.palettePos);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const setPalette = useStore((s) => s.setPalette);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; listMax: number } | null>(null);

  const W = widthFor(sidebarFontSize);
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
    const chrome = CHROME * sidebarFontSize, full = FULL * sidebarFontSize;
    const left = Math.max(8, Math.min(window.innerWidth - W - 8, cx - W / 2));
    const below = window.innerHeight - (bottom + GAP);
    const above = top - GAP;
    if (Math.max(below, above) < chrome + 120) { setPos(null); return; } // too tight -> centered
    // prefer the side that fits the full palette; else the roomier side
    const placeBelow = below >= full ? true : above >= full ? false : below >= above;
    const avail = placeBelow ? below : above;
    const listMax = Math.max(120, Math.min(LIST_MAX, avail - chrome)); // cap list so it can't clip
    setPos(placeBelow
      ? { top: bottom + GAP, left, listMax }
      : { bottom: window.innerHeight - top + GAP, left, listMax });
  }, [open, palettePos, sidebarFontSize, W]);

  if (!open) return null;
  const anchored = pos !== null;
  // the combobox autofocused on open; on close hand focus back to the transcript
  // list (it would fall to <body>), so the arrow-key selection flow keeps working
  const close = () => { setPalette(false); document.querySelector<HTMLElement>(".tviewlist")?.focus(); };
  return (
    <div className={"palette-backdrop" + (anchored ? " anchored" : "")} onMouseDown={close}>
      <div className={"palette" + (anchored ? " palette-anchored" : "")}
        role="dialog" aria-label="Code palette"
        style={{
          fontSize: sidebarFontSize, // sized like the sidebar/popovers (children are em-based)
          ...(anchored ? {
            position: "fixed", left: pos!.left, top: pos!.top, bottom: pos!.bottom, width: W,
            "--ac-max": `${pos!.listMax}px`,
          } : null),
        } as CSSProperties}
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
