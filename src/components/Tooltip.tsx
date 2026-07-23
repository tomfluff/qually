// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../state/store";

// One tooltip for the whole app. The old approach drew a CSS ::after on each
// [data-tip] host, which two things defeated: overflow:hidden on a host (the
// speaker chip's ellipsis cap) clipped the bubble to nothing, and z-index can't
// lift a bubble above a SIBLING stacking context (hotbar, video dock), so tips
// rendered behind panels. A single element portaled to <body> sidesteps both —
// it is nobody's child, and one z-index (owned by .tooltip) sits above
// everything. It reads the same data-tip attributes the hosts already carry.
//   Hover/focus only, read-only, pointer-events:none. Anything interactive
// (buttons, selectable text) is a popover's job — see AiMarkPopover.
//   Sized from the SIDEBAR text setting: tips are chrome, not transcript content,
// and shouldn't balloon when the reading text is cranked up.
type Tip = { node: ReactNode; cx: number; edge: number; below: boolean };

const GAP = 7;

function contentFor(el: HTMLElement): ReactNode {
  const del = el.getAttribute("data-tipdel");
  if (del !== null) { // edited-line diff: only the span that changed
    return (
      <span className="tipdiff">
        {el.hasAttribute("data-tippre") && "…"}
        {del && <s>{del}</s>}
        {el.getAttribute("data-tipins") && <span className="tipins">{el.getAttribute("data-tipins")}</span>}
        {el.hasAttribute("data-tipsuf") && "…"}
      </span>
    );
  }
  return el.getAttribute("data-tip");
}

export function Tooltip() {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // the host whose tip is showing: mouseover fires again on every boundary
    // crossing between a host's own children (icon → label → count), and
    // re-opening for the same host is a layout read + portal re-render for nothing
    let cur: HTMLElement | null = null;
    const openFor = (el: HTMLElement) => {
      cur = el;
      const r = el.getBoundingClientRect();
      // flip below when the tip won't fit above; threshold scales with the tip's
      // own text size (it was a hardcoded 90, which a large-text tip outgrew)
      const below = r.top < useStore.getState().ui.sidebarFontSize * 4.5;
      setTip({ node: contentFor(el), cx: r.left + r.width / 2, edge: below ? r.bottom + GAP : r.top - GAP, below });
    };
    const close = () => { cur = null; setTip(null); };
    const host = (t: EventTarget | null) => (t as HTMLElement)?.closest?.<HTMLElement>("[data-tip], [data-tipdel]");

    // no read-only tip on top of an open interactive overlay (the tooltip's
    // z-index beats the popovers') — unless the host lives INSIDE the overlay
    // (the popovers' own buttons carry tips too)
    const covered = (el: HTMLElement) => {
      const ov = document.querySelector(".pop, .ctxmenu, .clrpop");
      return !!ov && !ov.contains(el);
    };
    // an EMPTY data-tip is an opt-out: it stops the closest() walk (so an inner
    // element can suppress its row's tip in favour of a native title) without
    // opening an empty bubble
    const blank = (el: HTMLElement) => el.getAttribute("data-tip") === "" && !el.hasAttribute("data-tipdel");
    const onOver = (e: MouseEvent) => {
      const el = host(e.target);
      if (el === cur) return;
      if (el && !blank(el) && !covered(el)) openFor(el); else close();
    };
    const onFocus = (e: FocusEvent) => {
      const el = host(e.target);
      if (el && el !== cur && !blank(el) && !covered(el)) openFor(el);
    };
    const onBlur = () => close();
    // a click means attention moved to whatever was clicked (often a popover
    // opening over the hovered mark) — get the tip out of the way
    const onClick = () => close();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("click", onClick);
    document.addEventListener("scroll", close, true); // capture: catches virtua's inner scroller
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("click", onClick);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Keep the bubble inside the viewport horizontally. It's centred on its host,
  // which pushes it off-screen for hosts near an edge (the far-right lane bars).
  // Always REASSIGN the full transform, never append: React re-renders with an
  // identical transform string when the tip hops host-to-host, skips the style
  // write, and an appended correction from the previous host would survive (and
  // stack) — the measurement below would then be of the already-shifted box.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const base = `translateX(-50%)${tip.below ? "" : " translateY(-100%)"}`;
    el.style.transform = base;
    const r = el.getBoundingClientRect();
    const pad = 6;
    const dx = r.left < pad ? pad - r.left
      : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0;
    if (dx) el.style.transform = `${base} translateX(${dx}px)`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" style={{
      left: tip.cx, top: tip.edge, fontSize: fs,
      transform: `translateX(-50%)${tip.below ? "" : " translateY(-100%)"}`,
    }}>{tip.node}</div>,
    document.body,
  );
}
