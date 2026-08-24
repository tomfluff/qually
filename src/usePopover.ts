// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from "react";
import type React from "react";

// The two halves every popover repeats (SegmentPopover, AiMarkPopover, the
// color picker, CodeMenu) — extracted so the conventions live in one place.

// Every overlay that owns the keyboard while open. App's global keydown and
// VideoDock's media keys both suppress themselves against this ONE list —
// add new overlay classes here, not in either handler.
export const OVERLAY_SELECTOR = ".about-backdrop, .pop, .ctxmenu, .exmenu, .palette-backdrop, .clrpop, .vspeedmenu, .noticemenu, .focusmenu, .mapFind";

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
      // "Inside" is judged by where the press LANDED, not where its target is
      // now: React flushes a discrete event's state update before this
      // document-level listener runs, so a combobox suggestion (which closes
      // its list on pick) is already detached by the time we ask, and
      // `contains` said "outside" and shut the whole popover — swallowing the
      // pick. composedPath() is frozen when the event starts dispatching, so
      // it still holds the pressed node's ancestry — while a press on an
      // OUTSIDE control that removed itself (a backdrop, a selection grip)
      // still reads as outside and dismisses as it should.
      if (ref.current && !e.composedPath().includes(ref.current) && !ignore?.(e)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A combobox with its suggestions open owns the FIRST Escape: closing the
      // list is the innermost layer, and peeling straight past it to close the
      // popover throws away what the researcher was in the middle of choosing.
      // The list's own handler does that work; it just needs to be let through,
      // which the field already advertises via aria-expanded.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="combobox"][aria-expanded="true"]')) return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener("mousedown", down, capture);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", down, capture);
      document.removeEventListener("keydown", esc, true);
    };
  }, [ref, onClose, onEscape, capture, enabled, ignore]);
}

// A button that toggles a menu next to it: open state, the two refs, and the
// dismiss wiring (outside-click closes, but a click on the toggle button is
// ignored so it toggles instead of close-then-reopen). Used by the sidebar AI
// menu and the Codebook AI/View menus — the same three lines each had inline.
export function useToggleMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, () => setOpen(false), {
    enabled: open,
    ignore: (e) => !!btnRef.current?.contains(e.target as Node),
  });
  // The keyboard contract, for every menu this hook drives — handled HERE rather
  // than at the call sites, because a convention only holds if it can't be
  // forgotten. (Menus that keep their own open state call useMenuToggleFocus.)
  useMenuToggleFocus(open, menuRef, btnRef);
  // spread onto the menu element: Up/Down walk its items
  const arrows = useMenuArrows(menuRef);
  return { open, setOpen, btnRef, menuRef, arrows };
}

/** Opening moves focus into the menu; closing hands it back to the trigger.
    For a menu that lives inside its parent's render (so it has no mount of its
    own to hang useMenuFocus on) and tracks `open` itself. */
export function useMenuToggleFocus(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  btnRef?: RefObject<HTMLElement | null>,
) {
  const wasOpen = useRef(false);
  // whatever held focus when the menu opened — the restore target when there is
  // no trigger button (the map's right-click menus open from a canvas node)
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const act = document.activeElement;
      opener.current = act instanceof HTMLElement && act !== document.body ? act : null;
      // an autoFocus inside the menu has first claim — don't yank it away
      if (!menuRef.current?.contains(act)) menuItems(menuRef.current)[0]?.focus();
    }
    // Only reclaim focus when nothing else holds it. Escape, or picking an item,
    // unmounts the focused element and leaves the caret on <body> — that's ours
    // to hand back. Clicking straight into another control is not: the user has
    // already said where they want to be.
    else if (!open && wasOpen.current && document.activeElement === document.body) {
      const btn = btnRef?.current;
      (btn?.isConnected ? btn : opener.current?.isConnected ? opener.current : null)?.focus();
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// The keyboard half of a menu, lifted out of CodeMenu (which had the only
// working copy) so every menu gets the same contract:
//
//   opening moves focus INTO the menu, closing puts it back where it came from,
//   and Up/Down walk the items.
//
// Without this a keyboard user opens a menu and focus stays behind it — the
// arrows scroll the page, Tab wanders into the menu from the far end, and on
// close the caret drops to <body>, losing their place entirely.

/** Focus in on open, back to the opener on close.
    `home`: CSS selector for the container to fall back to when the opener is
    gone by the time we restore — an action that renames or deletes re-renders a
    list whose rows are keyed by name, so the button that opened the menu is
    detached, and focus()ing a detached node is a silent no-op that drops the
    caret to <body>. Landing in the list keeps the user where they were working.
    `into`: what to focus inside the menu; default is its first enabled control
    (a menu opening onto a text field passes its own input instead). */
export function useMenuFocus(
  ref: RefObject<HTMLElement | null>,
  opts?: { home?: string; into?: () => HTMLElement | null | undefined; enabled?: boolean },
) {
  const { home, into, enabled = true } = opts ?? {};
  // read once, on mount: later renders must not re-capture (by then the opener
  // IS the menu) and must not re-steal focus while the user is typing in it
  const intoRef = useRef(into);
  intoRef.current = into;
  // The opener is captured during RENDER, not in the effect: by effect time an
  // autoFocus inside the menu (a confirm button, the mark form's value field)
  // has already taken focus, and the effect would mistake a menu item for the
  // opener — restore would then aim at a node that dies with the menu.
  // <body> is not an opener — it's what you get when the menu was opened by a
  // right-click, which moves no focus. Restoring "to" it would leave the caret
  // exactly nowhere, so treat it as absent and use the home fallback instead.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (enabled && openerRef.current === undefined) {
    const act = document.activeElement;
    openerRef.current = act instanceof HTMLElement && act !== document.body ? act : null;
  }
  useEffect(() => {
    if (!enabled) return;
    const opener = openerRef.current ?? null;
    const back = home ? opener?.closest<HTMLElement>(home)
      ?? document.querySelector<HTMLElement>(home) : null;
    // an autoFocus inside the menu has first claim — don't yank it away
    if (!ref.current?.contains(document.activeElement))
      (intoRef.current?.() ?? menuItems(ref.current)[0])?.focus();
    return () => {
      // if focus already moved somewhere real (the colour picker opening out of
      // this menu, a click straight into another control), it isn't ours to move
      const act = document.activeElement;
      if (act && act !== document.body && act.isConnected) return;
      if (opener?.isConnected) { opener.focus(); return; }
      if (!back?.isConnected) return;
      back.tabIndex = -1; // a scroll container isn't focusable on its own
      back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

/** The menu's focusable items, in DOM order. Anything focus() cannot actually
    land on is skipped, because focus() on it is a silent no-op and the walk
    sticks there forever: a real `disabled`, something `hidden` (the tab menu
    keeps an invisible file input its "Load events" row clicks), anything taken
    out of the tab order on purpose, and anything hidden from assistive tech.
    `aria-disabled` is deliberately NOT skipped — that marks an item that is
    inert but still reachable, precisely so a keyboard user can land on it and
    hear WHY it is unavailable (see CodeMenu's hotbar row). */
const menuItems = (el: HTMLElement | null): HTMLElement[] =>
  Array.from(el?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea") ?? [])
    .filter((b) => !b.hasAttribute("disabled") && !b.hidden
      && b.tabIndex >= 0 && b.getAttribute("aria-hidden") !== "true");

/** Up/Down walk the items, wrapping at both ends. Returns the handler to spread
    onto the menu element. Keys inside a text field are left alone — there the
    arrows belong to the caret (and to comboboxes, which own their own list). */
export function useMenuArrows(ref: RefObject<HTMLElement | null>) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).matches("input, textarea, select")) return;
    e.preventDefault();
    const items = menuItems(ref.current);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length].focus();
  };
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
