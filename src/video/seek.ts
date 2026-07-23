// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Bridge between the timecode chip (in TranscriptView) and whatever <video>
// the VideoDock currently has loaded. Kept module-local so the chip doesn't
// need a ref or context.

let el: HTMLVideoElement | null = null;
let offset = 0;

export function registerVideo(v: HTMLVideoElement | null, off: number) {
  el = v;
  offset = off;
}

// whether any media is loaded — the line editor shows its loop button only then
export const hasVideo = () => el !== null;

// live rate change while a loop is running (the edit bar's speed button)
export function setPlaybackRate(r: number) { if (el) el.playbackRate = r; }

export function tsToSec(ts: string): number | null {
  const p = (ts || "").split(".")[0].split(":").map(Number);
  if (!p.length || p.some(isNaN)) return null;
  return p.reduce((a, b) => a * 60 + b, 0);
}

export function seekVideo(ts: string): boolean {
  if (!el) return false;
  const s = tsToSec(ts);
  if (s === null) return false;
  el.currentTime = Math.max(0, s + offset);
  void el.play();
  return true;
}

// Loop one utterance while its line is being retyped (transcript repair).
// endTs is usually the next line's timestamp; without one, loop a 6s window.
// Plays at `rate` (the ui.loopSpeed setting), restoring the dock's own rate on
// stop — so the loop can run slow without the dock losing its speed.
// Returns a stop function that pauses.
export function loopLine(startTs: string, endTs: string | null, rate: number): (() => void) | null {
  if (!el) return null;
  const s = tsToSec(startTs);
  if (s === null) return null;
  const e = (endTs !== null ? tsToSec(endTs) : null) ?? s + 6;
  const v = el;
  const from = Math.max(0, s + offset);
  const to = Math.max(from + 1, e + offset); // a sub-second range would stutter
  const prevRate = v.playbackRate;
  const onTime = () => { if (v.currentTime >= to) v.currentTime = from; };
  v.playbackRate = rate;
  v.currentTime = from;
  v.addEventListener("timeupdate", onTime);
  void v.play();
  return () => {
    v.removeEventListener("timeupdate", onTime);
    v.playbackRate = prevRate;
    v.pause(); // ponytail: always pause on exit; resuming a pre-existing playback isn't tracked
  };
}
