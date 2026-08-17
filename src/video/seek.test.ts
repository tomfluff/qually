// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The playhead reading both event entry points depend on (VideoDock's Mark,
// App's E with nothing selected): null means "no media", 0 means "the start" —
// a 0 that leaked as null would silently drop the event being added.
import { test, expect } from "vitest";
import { registerVideo, playheadSec, playheadSecFor, hasVideo } from "./seek";

const fake = (currentTime: number) => ({ currentTime }) as HTMLVideoElement;

test("no media loaded: the playhead has no reading", () => {
  registerVideo(null, 0);
  expect(hasVideo()).toBe(false);
  expect(playheadSec()).toBeNull();
});

test("the playhead reads on the transcript clock, never below zero", () => {
  registerVideo(fake(30), 10);
  expect(playheadSec()).toBe(20); // video 30s − offset 10 = transcript 20s
  registerVideo(fake(4), 10);
  expect(playheadSec()).toBeNull(); // pre-roll: before the transcript exists — no reading
  registerVideo(fake(0), 0);
  expect(playheadSec()).toBe(0);  // zero is a time, not "no media"
  registerVideo(null, 0);         // leave the module state clean for other suites
});

test("the pid-checked reading refuses another transcript's video", () => {
  registerVideo(fake(30), 0, "P01"); // P01's media (e.g. pinned via picture-in-picture)
  expect(playheadSecFor("P01")).toBe(30);
  expect(playheadSecFor("P02")).toBeNull(); // E on P02 must not file at P01's playhead
  registerVideo(null, 0);
});
