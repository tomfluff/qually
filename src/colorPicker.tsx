// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState } from "react";
import { useStore, COLORS } from "./state/store";

// In-app color picker popover, anchored to the swatch that opened it. The native
// <input type=color> could not be anchored when opened PROGRAMMATICALLY — Chrome
// ignores the position of an invisible input for both click() and showPicker()
// and drops the popup at the viewport's top-left corner. So: our own popover for
// the anchoring and the presets, with a real, visible native input inside it for
// custom colors — a genuine user click on a rendered input, which Chrome anchors.
type Req = { value: string; onPick: (c: string) => void; x: number; y: number };
let openFn: ((r: Req) => void) | null = null;

// anchor: the element to open under, or explicit coords (CodeMenu passes its own
// anchor point so the popover lands where the menu was — by the code row — rather
// than under a menu item that no longer exists once the menu closes)
export function openColorPicker(value: string, onPick: (color: string) => void, anchor?: HTMLElement | { x: number; y: number }) {
  const p = anchor instanceof HTMLElement
    ? { x: anchor.getBoundingClientRect().left, y: anchor.getBoundingClientRect().bottom + 4 }
    : anchor ?? { x: 40, y: 40 };
  openFn?.({ value, onPick, ...p });
}

export function ColorPickerHost() {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const [req, setReq] = useState<Req | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { openFn = setReq; return () => { openFn = null; }; }, []);

  // keyboard route (CodeMenu → "Change color…"): focus lands on the first swatch
  useEffect(() => { if (req) ref.current?.querySelector("button")?.focus(); }, [req]);

  useEffect(() => {
    if (!req) return;
    // capture, not bubble: the settings dialog (and other modals) stopPropagation
    // on mousedown, so a bubble listener never hears clicks inside them and the
    // popover survived its own opener closing
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setReq(null); };
    // capture + stopPropagation so App's global Esc doesn't also clear the line selection
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setReq(null); } };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", esc, true); };
  }, [req]);

  if (!req) return null;
  const pick = (c: string) => { req.onPick(c); setReq(null); };
  return (
    <div className="clrpop" ref={ref} role="dialog" aria-label="Pick a color"
      style={{ left: Math.min(req.x, window.innerWidth - 190), top: Math.min(req.y, window.innerHeight - 140), fontSize: fs }}>
      <div className="clrgrid">
        {COLORS.map((c) => (
          <button key={c} className={"clrsw" + (c === req.value.toLowerCase() ? " on" : "")}
            style={{ background: c }} aria-label={`Color ${c}`} onClick={() => pick(c)} />
        ))}
      </div>
      <label className="clrcustom">
        {/* uncontrolled: onInput live-previews while the native picker is open,
            onChange (commit) closes the popover */}
        <input type="color" defaultValue={req.value}
          onInput={(e) => req.onPick((e.target as HTMLInputElement).value)}
          onChange={() => setReq(null)} />
        custom…
      </label>
    </div>
  );
}
