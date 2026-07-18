// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, COLORS } from "./state/store";
import { useDialogFocus } from "./useDialogFocus";
import { useDismiss, useClampToViewport } from "./usePopover";

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
  // focus in on open (first swatch), Tab cycles inside, focus RESTORED to the
  // opener on close — without the restore, closing the picker dropped keyboard
  // focus on <body>
  const dialogRef = useDialogFocus();
  const setRef = useCallback((el: HTMLDivElement | null) => { ref.current = el; return dialogRef(el); }, [dialogRef]);
  useEffect(() => { openFn = setReq; return () => { openFn = null; }; }, []);

  useClampToViewport(ref, [req, fs]);
  // capture: the settings dialog stopPropagation-s its mousedowns, so a bubble
  // listener would never hear clicks inside it and the popover would survive
  // its own opener closing
  const close = useCallback(() => setReq(null), []);
  useDismiss(ref, close, { capture: true, enabled: !!req });

  if (!req) return null;
  const pick = (c: string) => { req.onPick(c); setReq(null); };
  return (
    <div className="clrpop" ref={setRef} role="dialog" aria-label="Pick a color"
      style={{ left: req.x, top: req.y, fontSize: fs }}>
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
