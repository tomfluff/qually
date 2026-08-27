// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { test, expect } from "vitest";
import { speakerGroupedText, speakerGroups } from "./format";

test("speaker grouping merges consecutive lines without changing clipboard text", () => {
  const lines = [
    { speaker: "P", text: " first " },
    { speaker: "P", text: "second" },
    { speaker: "R", text: " question " },
    { speaker: "P", text: "answer" },
  ];
  expect(speakerGroups(lines)).toEqual([
    { speaker: "P", text: "first second" },
    { speaker: "R", text: "question" },
    { speaker: "P", text: "answer" },
  ]);
  expect(speakerGroupedText(lines)).toBe("P : first second\nR : question\nP : answer");
});

// The clipboard grouping keys off the RAW speaker label, not a trimmed one: two
// spellings of the same name in a hand-edited transcript are two labels on the
// page, and merging them here would print one speaker's words under the other's.
test("grouping keeps raw speaker labels apart, and survives blank input", () => {
  expect(speakerGroups([])).toEqual([]);
  expect(speakerGroupedText([])).toBe("");
  const lines = [{ speaker: " P ", text: "x" }, { speaker: "P", text: "y" }];
  expect(speakerGroups(lines)).toEqual([
    { speaker: " P ", text: "x" }, { speaker: "P", text: "y" },
  ]);
  expect(speakerGroupedText([{ speaker: "P", text: "kept" }, { speaker: "P", text: "  " }]))
    .toBe("P : kept ");
});
