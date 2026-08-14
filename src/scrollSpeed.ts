// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// One wheel handler for the whole app.
//
// The Settings "scroll distance" knob used to reach exactly one list — the
// transcript — because that list owned the only wheel listener. Everything else
// (the codebook, the Assist worklists, the events log, the session record, every
// dialog body) scrolled at whatever the device does, and on a high-resolution
// trackpad or a free-spinning wheel that is far too fast to read a transcript
// with. Rather than bolt a listener onto every scrollable div — there are two
// dozen, and the next one added would be forgotten — this listens once on the
// document during CAPTURE and scales whichever container the event was going to
// scroll anyway.
//
// It can only govern the WHEEL. Keyboard paging, a scrollbar drag and the app's
// own scrollToIndex calls are absolute moves, not speeds, and are left alone.
import { useStore } from "./state/store";

// The multiplier is halved against the device: the shipped 100% moves half as
// far as the browser would, which is the pace this app is meant to be read at.
// The slider still reaches the device's own speed, at 200%.
export const SCROLL_BASE = 0.5;

/** One wheel event in pixels. deltaMode is per-device: 0 pixels, 1 lines, 2
 *  pages. Lines resolve against the CONTAINER's line-height, so a large-text
 *  transcript steps by its own rows and a dense sidebar by its own. */
export function wheelPixels(deltaY: number, deltaMode: number, lineHeight: number, clientHeight: number): number {
  if (deltaMode === 1) return deltaY * lineHeight;
  if (deltaMode === 2) return deltaY * clientHeight;
  return deltaY;
}

/** Can this container still move in that direction? The question scroll
 *  CHAINING turns on: a wheel over a list already at its end has to hand the
 *  scroll to the pane behind it, which is what the browser does natively and
 *  what we are standing in for. */
export function hasRoom(scrollTop: number, scrollHeight: number, clientHeight: number, down: boolean): boolean {
  return down ? scrollTop < scrollHeight - clientHeight - 1 : scrollTop > 0;
}

/** Where the container lands, clamped to its own ends. */
export function nextTop(scrollTop: number, px: number, scrollHeight: number, clientHeight: number): number {
  return Math.max(0, Math.min(scrollTop + px, Math.max(0, scrollHeight - clientHeight)));
}

// per-container accumulation: deltas land ONCE per frame, because a scrollTop
// write per wheel tick forces layout, which is expensive on a virtualized list
const pending = new Map<HTMLElement, number>();
let raf = 0;

function flush() {
  raf = 0;
  for (const [el, px] of pending) el.scrollTop = nextTop(el.scrollTop, px, el.scrollHeight, el.clientHeight);
  pending.clear();
}

/** Drop any scaled write still in flight — a navigation must not be overwritten
 *  by the frame the wheel had already queued. */
export function stopScrollAnim() {
  cancelAnimationFrame(raf);
  raf = 0;
  pending.clear();
}

// the container this wheel event would have scrolled: the nearest scrollable
// ancestor with room left in this direction
function targetOf(node: EventTarget | null, down: boolean): HTMLElement | null {
  let el = node instanceof Element ? (node as HTMLElement) : null;
  for (; el; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if (o !== "auto" && o !== "scroll") continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (hasRoom(el.scrollTop, el.scrollHeight, el.clientHeight, down)) return el;
  }
  const doc = document.scrollingElement as HTMLElement | null;
  return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
}

export function installScrollSpeed(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.defaultPrevented) return; // ctrl+wheel is browser zoom, not ours to take
    if (!e.deltaY) return;                       // pure-horizontal events aren't ours to eat
    const mult = SCROLL_BASE * (useStore.getState().ui.scrollSpeed || 1);
    if (mult === 1) return;                      // exactly device speed: leave it native
    const el = targetOf(e.target, e.deltaY > 0);
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const px = wheelPixels(e.deltaY, e.deltaMode, lh, el.clientHeight) * mult;
    if (!px) return;
    e.preventDefault();
    pending.set(el, (pending.get(el) ?? 0) + px);
    if (!raf) raf = requestAnimationFrame(flush);
  };
  // capture: a scroll container between the target and the document must not be
  // able to swallow the event before we see it
  document.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    document.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    stopScrollAnim();
  };
}
