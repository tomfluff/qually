// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Guards for the low-vision work. The claim these defend: nothing that carries
// meaning may be carried by COLOUR ALONE (WCAG 1.4.1), and text that carries
// content must clear AA contrast (1.4.3).
import { test, expect } from "vitest";
import { PATTERNS, patternOf, inkOn, guessQuiet } from "./state/store";
import { shortLabels } from "./components/TranscriptView";
import { PALETTES } from "./palettes";

// sRGB relative luminance, per WCAG 2.x
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("a code's pattern is stable, so the sidebar swatch always matches its lane", () => {
  expect(patternOf("magnification")).toBe(patternOf("magnification"));
  expect(patternOf("magnification")).toBe(patternOf("  Magnification ")); // norm()'d
  expect(patternOf("magnification")).toBeLessThan(PATTERNS);
});

// The whole point of the second channel: the 12-colour rotation repeats, so two
// codes CAN share a colour. If they shared a pattern too, they'd be indistinguishable
// without colour vision — which is the failure we set out to fix.
test("distinct codes are spread across the pattern set", () => {
  const codes = ["magnification", "lost context", "frustration", "workaround",
    "member check", "desire", "tension", "in vivo", "pan and scan", "axis labels",
    "heat map", "zoom"];
  const used = new Set(codes.map(patternOf));
  expect(used.size).toBeGreaterThanOrEqual(4); // not all collapsing onto one pattern
});

// Accent-filled controls (primary button, active tab) hardcode white text in the light
// theme and near-black in the dark one. So EVERY selectable primary has to clear AA, or
// choosing that colour quietly breaks contrast across the whole app. Teal (3.96) and
// green (4.26) were failing, which made the README's "AA in both themes" a false claim.
test("every selectable primary clears AA against the text drawn on it", () => {
  for (const p of PALETTES) {
    expect(contrast("#ffffff", p.light), `${p.name} light: white text on ${p.light}`)
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast("#12161a", p.dark), `${p.name} dark: dark text on ${p.dark}`)
      .toBeGreaterThanOrEqual(4.5);
  }
});

// --muted is not decoration: it colours line numbers, speaker labels, timecodes and
// code definitions. #8a8a8a (the old value) was 3.45:1 — a fail that shipped.
test("theme colours that carry text clear WCAG AA (4.5:1)", () => {
  expect(contrast("#6b6b6b", "#ffffff")).toBeGreaterThanOrEqual(4.5); // light --muted
  expect(contrast("#4a4a4a", "#ffffff")).toBeGreaterThanOrEqual(4.5); // light --fg-dim
  expect(contrast("#97a3ad", "#161a1e")).toBeGreaterThanOrEqual(4.5); // dark --muted
  expect(contrast("#a8b0b8", "#161a1e")).toBeGreaterThanOrEqual(4.5); // dark --fg-dim
});

// The "researcher is R" convention was removed because it dimmed a participant called
// Rachel. A prefix test (^r\b) reintroduced it through the back door: it matched
// "R. Singh" and "Rae". The guess must be a WHOLE-LABEL match or nothing.
test("the interviewer guess never dims a participant", () => {
  expect(guessQuiet(["R", "P1", "P2"])).toEqual(["R"]);
  expect(guessQuiet(["Interviewer", "Rachel"])).toEqual(["Interviewer"]);
  expect(guessQuiet(["Moderator", "R2"])).toEqual(["Moderator", "R2"]); // R2 = 2nd researcher
  // none of these are the researcher, and all of them used to be caught
  expect(guessQuiet(["Rachel", "Rae", "R. Singh", "R (participant)", "Robin"])).toEqual([]);
});

// "Short" mode sliced 3 characters blind, so Alice/Alicia/Alina all became "Ali" —
// leaving COLOUR as the only thing telling them apart, the very failure this fixes.
test("short speaker labels stay unique", () => {
  const s = shortLabels(["Alice", "Alicia", "Alina", "Bob"]);
  expect(new Set(Object.values(s)).size).toBe(4);
  expect(s.Bob).toBe("Bob");
  expect(s.Alice).not.toBe(s.Alicia);
});

// The chip's label was hardcoded white. The colour picker accepts anything.
test("a speaker chip's label stays readable on any colour the user picks", () => {
  // includes the mathematical worst case (L ~ 0.2), where a soft near-black ink failed
  for (const bg of ["#ffffff", "#ffe58a", "#6d28d9", "#000000", "#0f766e",
                    "#808080", "#767676", "#8a6d3b", "#5a5a5a"]) {
    expect(contrast(inkOn(bg), bg), `label on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});
