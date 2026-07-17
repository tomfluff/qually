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
