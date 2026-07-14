// Guards for the low-vision work. The claim these defend: nothing that carries
// meaning may be carried by COLOUR ALONE (WCAG 1.4.1), and text that carries
// content must clear AA contrast (1.4.3).
import { test, expect } from "vitest";
import { PATTERNS, patternOf } from "./state/store";

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

// --muted is not decoration: it colours line numbers, speaker labels, timecodes and
// code definitions. #8a8a8a (the old value) was 3.45:1 — a fail that shipped.
test("theme colours that carry text clear WCAG AA (4.5:1)", () => {
  expect(contrast("#6b6b6b", "#ffffff")).toBeGreaterThanOrEqual(4.5); // light --muted
  expect(contrast("#4a4a4a", "#ffffff")).toBeGreaterThanOrEqual(4.5); // light --fg-dim
  expect(contrast("#97a3ad", "#161a1e")).toBeGreaterThanOrEqual(4.5); // dark --muted
  expect(contrast("#a8b0b8", "#161a1e")).toBeGreaterThanOrEqual(4.5); // dark --fg-dim
});
