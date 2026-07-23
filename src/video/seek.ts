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

// whether a loop currently owns the playback rate — the dock's own rate effect
// checks this so the two writers never fight over el.playbackRate
let loopActive = false;
export const isLooping = () => loopActive;

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

// The window a loop plays: this line's start to the next line's (6s fallback),
// never under 1s (a sub-second range would stutter). ONE definition — the edit
// bar's duration label derives from the same math (loopWindow, not a copy).
export function loopWindow(startTs: string, endTs: string | null): { s: number; e: number } | null {
  const s = tsToSec(startTs);
  if (s === null) return null;
  const e = (endTs !== null ? tsToSec(endTs) : null) ?? s + 6;
  return { s, e: Math.max(s + 1, e) };
}

// Loop one utterance while its line is being retyped (transcript repair).
// Plays at `rate` (the ui.loopSpeed setting), restoring the dock's own rate on
// stop — so the loop can run slow without the dock losing its speed.
// Returns a stop function that pauses.
export function loopLine(startTs: string, endTs: string | null, rate: number): (() => void) | null {
  if (!el) return null;
  const win = loopWindow(startTs, endTs);
  if (win === null) return null;
  const v = el;
  const from = Math.max(0, win.s + offset);
  const to = Math.max(from + 1, win.e + offset);
  const prevRate = v.playbackRate;
  const onTime = () => { if (v.currentTime >= to) v.currentTime = from; };
  loopActive = true;
  v.playbackRate = rate;
  v.currentTime = from;
  v.addEventListener("timeupdate", onTime);
  void v.play();
  return () => {
    v.removeEventListener("timeupdate", onTime);
    loopActive = false;
    v.playbackRate = prevRate;
    v.pause(); // ponytail: always pause on exit; resuming a pre-existing playback isn't tracked
  };
}
