// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useLayoutEffect, type DependencyList, type RefObject } from "react";

// The two halves every popover repeats (SegmentPopover, AiMarkPopover, the
// color picker, CodeMenu) — extracted so the conventions live in one place.

// Every overlay that owns the keyboard while open. App's global keydown and
// VideoDock's media keys both suppress themselves against this ONE list —
// add new overlay classes here, not in either handler.
export const OVERLAY_SELECTOR = ".about-backdrop, .pop, .ctxmenu, .exmenu, .palette-backdrop, .clrpop, .vspeedmenu, .noticemenu, .focusmenu";

// Dismiss: mousedown outside the ref closes; Escape closes. Escape listens in
// the CAPTURE phase with stopPropagation so App's global Esc (clear selection)
// never sees it, and closing peels one layer instead of several.
// capture: put the mousedown in the capture phase too — needed when the popover
// opens above a modal whose own handlers stopPropagation (the color picker over
// Settings), harmless otherwise. enabled: for hosts that stay mounted while
// closed (the color picker host renders null but its hooks still run).
// onEscape: when Escape should do something gentler than a full close (CodeMenu
// steps a sub-form back to the menu; an outside click still closes outright).
// ignore: outside-mousedowns this predicate claims are left alone — for a
// trigger that toggles the popover itself (the segment's own lane bar), where
// dismiss-on-mousedown would close it just before the click reopens it.
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  opts?: { capture?: boolean; enabled?: boolean; onEscape?: () => void; ignore?: (e: MouseEvent) => boolean },
) {
  const capture = opts?.capture ?? false;
  const enabled = opts?.enabled ?? true;
  const onEscape = opts?.onEscape ?? onClose;
  const ignore = opts?.ignore;
  useEffect(() => {
    if (!enabled) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !ignore?.(e)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onEscape(); } };
    document.addEventListener("mousedown", down, capture);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", down, capture);
      document.removeEventListener("keydown", esc, true);
    };
  }, [ref, onClose, onEscape, capture, enabled, ignore]);
}

// Clamp: the popovers are em-sized and scale with the sidebar text setting, so
// a fixed clamp can't keep them on screen — measure the real box after render
// and pull it back inside the viewport.
export function useClampToViewport(ref: RefObject<HTMLElement | null>, deps: DependencyList) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    if (r.right > window.innerWidth - pad)
      el.style.left = Math.max(pad, window.innerWidth - r.width - pad) + "px";
    if (r.bottom > window.innerHeight - pad)
      el.style.top = Math.max(pad, window.innerHeight - r.height - pad) + "px";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
