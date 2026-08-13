// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { mergeGroups } from "./merge";
import type { Line } from "./state/store";

const L = (id: number, speaker: string, text: string): Line => ({ id, ts: "", speaker, text });

describe("mergeGroups", () => {
  it("returns singletons when disabled", () => {
    const g = mergeGroups([L(1, "P", "hi"), L(2, "P", "there")], false);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("merges a partial line into the next same-speaker line", () => {
    const g = mergeGroups([L(1, "P", "I zoom in then I"), L(2, "P", "pan across.")], true);
    expect(g.map((x) => x.ids)).toEqual([[1, 2]]);
  });

  it("stops the run at a terminated line", () => {
    const g = mergeGroups([L(1, "P", "one"), L(2, "P", "two."), L(3, "P", "three.")], true);
    expect(g.map((x) => x.ids)).toEqual([[1, 2], [3]]);
  });

  it("never merges across a speaker change", () => {
    const g = mergeGroups([L(1, "P", "then I"), L(2, "R", "mm"), L(3, "R", "go on")], true);
    expect(g.map((x) => x.ids)).toEqual([[1], [2, 3]]);
  });

  it("treats . ? ! … (with trailing quotes) as complete", () => {
    const g = mergeGroups([L(1, "P", "really?"), L(2, "P", 'it "helps."'), L(3, "P", "lost the…"), L(4, "P", "done")], true);
    expect(g.map((x) => x.ids)).toEqual([[1], [2], [3], [4]]);
  });

  it("carries first ts/speaker and full range", () => {
    const g = mergeGroups([{ id: 5, ts: "00:03", speaker: "P", text: "a" }, L(6, "P", "b.")], true);
    expect(g[0]).toMatchObject({ startId: 5, endId: 6, ts: "00:03", speaker: "P" });
  });
});

const T = (id: number, ts: string, speaker: string, text: string): Line => ({ id, ts, speaker, text });

describe("mergeGroups gap rule", () => {
  it("merges terminated same-speaker lines whose pause is within the gap", () => {
    const g = mergeGroups([T(1, "00:00:01", "P", "one."), T(2, "00:00:03", "P", "two.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1, 2]]);
  });

  it("splits when the pause after the previous line exceeds the gap", () => {
    const g = mergeGroups([T(1, "00:00:01", "P", "one."), T(2, "00:00:10", "P", "two.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("the gap is a PAUSE, not start-to-start: a long line's speaking time is spent first", () => {
    // 25 words ≈ 10s of speech from 00:00, so the next line at 00:12 is only a
    // ~2s silence — well inside a 3s gap even though the starts are 12s apart
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ") + ".";
    const g = mergeGroups([T(1, "00:00:00", "P", long), T(2, "00:00:12", "P", "yes.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1, 2]]);
  });

  it("never merges across a speaker change even inside the gap", () => {
    const g = mergeGroups([T(1, "00:00:01", "P", "one."), T(2, "00:00:02", "R", "two.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("gap counts from the RUN's last line, not its first", () => {
    // 1→2 within gap, 2→3 within gap, but 1→3 is not: still one run of three
    const g = mergeGroups([T(1, "00:00:00", "P", "a."), T(2, "00:00:03", "P", "b."), T(3, "00:00:06", "P", "c.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1, 2, 3]]);
  });

  it("a real end_timestamp beats the speaking-time estimate", () => {
    // long text would ESTIMATE ~10s of speech, but the data says it ended at
    // 00:02 — the 10s to the next line is a real silence, so no merge
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ") + ".";
    const g = mergeGroups([
      { id: 1, ts: "00:00:00", end: "00:00:02", speaker: "P", text: long },
      T(2, "00:00:12", "P", "yes."),
    ], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("a line that starts before the one above it never gap-merges", () => {
    // a broken timeline reads as a NEGATIVE gap, which would clear every
    // threshold and fold the whole transcript into one unit
    const g = mergeGroups([T(1, "00:00:12", "P", "later."), T(2, "00:00:02", "P", "earlier.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("overlapping speech still merges — a start inside the previous line is not a pause", () => {
    const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ") + ".";
    const g = mergeGroups([T(1, "00:00:00", "P", long), T(2, "00:00:05", "P", "yes.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1, 2]]);
  });

  it("untimed lines never gap-merge", () => {
    const g = mergeGroups([L(1, "P", "a."), L(2, "P", "b.")], false, 3);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });

  it("either rule joins when both are on", () => {
    // 1→2 by partial text (gap too big), 2→3 by gap (text terminated)
    const g = mergeGroups([T(1, "00:00:00", "P", "then I"), T(2, "00:00:20", "P", "zoomed."), T(3, "00:00:22", "P", "done.")], true, 3);
    expect(g.map((x) => x.ids)).toEqual([[1, 2, 3]]);
  });

  it("null gap keeps the old behaviour", () => {
    const g = mergeGroups([T(1, "00:00:01", "P", "one."), T(2, "00:00:02", "P", "two.")], true, null);
    expect(g.map((x) => x.ids)).toEqual([[1], [2]]);
  });
});
