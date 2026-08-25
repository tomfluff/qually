// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, expect, it } from "vitest";
import { stretchLabelPlacement } from "./stretchLabelPosition";

describe("stretch label placement", () => {
  const start = 100, end = 500, height = 93.890625;

  it("has one continuous pin-to-park transition at fractional scroll offsets", () => {
    const scrolls = [401.75, 402, 402.109375, 402.125, 402.375, 402.625];
    const placements = scrolls.map((scroll) => stretchLabelPlacement(start, end, scroll, height));
    const visibleTops = placements.map((p) => p.top + p.translateY);

    expect(placements.map((p) => p.mode)).toEqual([
      "pinned", "pinned", "parked", "parked", "parked", "parked",
    ]);
    expect(visibleTops).toEqual([4, 4, 4, 3.984375, 3.734375, 3.484375]);
    expect(visibleTops.every((top, i) => i === 0 || top <= visibleTops[i - 1])).toBe(true);
  });

  it("keeps the pill bottom welded to the band while parked", () => {
    for (const scroll of [402.109375, 402.25, 402.5, 403]) {
      const p = stretchLabelPlacement(start, end, scroll, height);
      const pillBottom = p.top + p.translateY + height;
      const bandBottom = end - scroll;
      expect(p.mode).toBe("parked");
      expect(pillBottom).toBe(bandBottom);
    }
  });

  it("clips a stretch that is shorter than its label in stable content geometry", () => {
    const p = stretchLabelPlacement(100, 150, 25.5, height);
    expect(p).toEqual({ mode: "clipped", top: 102, translateY: -25.5, clipHeight: 48 });
    expect(p.top + p.translateY + p.clipHeight!).toBe(150 - 25.5);
  });

  it("flows with the start before it reaches the viewport pin", () => {
    expect(stretchLabelPlacement(start, end, 80, height)).toEqual({
      mode: "flowing", top: 102, translateY: -80,
    });
  });
});
