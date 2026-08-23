// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { codeOrigins, originCounts, historyOf, methodsParagraph } from "./provenance";
import type { Decision } from "./state/store";

const d = (
  kind: Decision["kind"], codes: string[], source: Decision["source"] = "you",
  extra: Partial<Decision> = {},
): Decision => ({ at: "2026-08-23T00:00:00.000Z", kind, codes, why: "", source, ...extra });

describe("code provenance", () => {
  it("leaves untouched codes untouched", () => {
    expect(codeOrigins([], ["a", "b"]).get("a")).toBe("untouched");
  });

  it("marks a hand merge as the researcher's", () => {
    const m = codeOrigins([d("merge", ["small text", "tiny text"])], ["small text"]);
    expect(m.get("small text")).toBe("you");
  });

  it("marks an accepted proposal as the model's", () => {
    const m = codeOrigins([d("merge", ["small text", "tiny text"], "ai")], ["small text"]);
    expect(m.get("small text")).toBe("ai");
  });

  it("treats an offline wording match as the researcher's, not the model's", () => {
    const m = codeOrigins([d("merge", ["small text", "tiny text"], "wording")], ["small text"]);
    expect(m.get("small text")).toBe("you");
  });

  it("keeps the model's mark through a later hand rename", () => {
    const m = codeOrigins([
      d("merge", ["small text", "tiny text"], "ai"),
      d("rename", ["unreadable labels", "small text"], "you"),
    ], ["unreadable labels"]);
    expect(m.get("unreadable labels")).toBe("ai");
  });

  it("ignores decisions that were undone", () => {
    const m = codeOrigins([d("merge", ["a", "b"], "ai", { undone: true })], ["a"]);
    expect(m.get("a")).toBe("untouched");
  });

  it("does not mark a code just because its excerpts were rejected", () => {
    expect(codeOrigins([d("remove", ["a"], "ai")], ["a"]).get("a")).toBe("untouched");
  });

  it("counts the three states over the live codebook only", () => {
    const c = originCounts([
      d("merge", ["a", "gone"], "ai"),
      d("rename", ["b", "was b"]),
    ], ["a", "b", "c"]);
    expect(c).toEqual({ untouched: 1, you: 1, ai: 1, total: 3 });
  });

  it("reads a code's history back through its old names", () => {
    const h = historyOf([
      d("merge", ["small text", "tiny text"], "ai"),
      d("rename", ["unreadable labels", "small text"]),
      d("merge", ["something else", "other"]),
    ], "unreadable labels");
    expect(h).toHaveLength(2);
    expect(h[0].codes[0]).toBe("small text");
  });
});

describe("methods paragraph", () => {
  it("says plainly when no model was involved", () => {
    const p = methodsParagraph([d("merge", ["a", "b"]), d("rename", ["c", "d"])], ["a", "c"]);
    expect(p).toContain("2 code");
    expect(p).toContain("1 merge, 1 rename were applied");
    expect(p).toContain("No language model proposed any of them.");
  });

  it("names the model and insists it applied nothing", () => {
    const p = methodsParagraph([d("merge", ["a", "b"], "ai", { model: "Terra" })], ["a"]);
    expect(p).toContain("Terra");
    expect(p).toContain("the model applied nothing");
  });

  it("counts reversed decisions rather than hiding them", () => {
    const p = methodsParagraph([d("merge", ["a", "b"], "you", { undone: true })], ["a", "b"]);
    expect(p).toContain("1 decision was made and then reversed");
  });

  it("stays a single sentence when nothing has been decided", () => {
    expect(methodsParagraph([], ["a"])).toBe("The first author consolidated the codebook to 1 code.");
  });
});

describe("the agreement rate", () => {
  it("reports verdicts formed before the model's was shown", () => {
    const p = methodsParagraph([
      d("merge", ["a", "b"], "ai", { blind: "agreed" }),
      d("merge", ["c", "e"], "ai", { blind: "agreed" }),
      d("dismiss", ["f", "g"], "ai", { blind: "differed" }),
    ], ["a", "c"]);
    expect(p).toContain("On 3 proposals the researcher recorded a verdict before seeing the model's");
    expect(p).toContain("agreeing with it on 2 and differing on 1");
  });

  it("says nothing about agreement when nothing was called blind", () => {
    expect(methodsParagraph([d("merge", ["a", "b"], "ai")], ["a"]))
      .not.toContain("before seeing");
  });
});

describe("the paragraph reads as English", () => {
  it("agrees the verb with how many decisions there were", () => {
    expect(methodsParagraph([d("merge", ["a", "b"])], ["a"])).toContain("1 merge was applied");
    expect(methodsParagraph([d("merge", ["a", "b"]), d("merge", ["c", "e"])], ["a", "c"]))
      .toContain("2 merges were applied");
    // one of each is still two decisions
    expect(methodsParagraph([d("merge", ["a", "b"]), d("rename", ["c", "d"])], ["a", "c"]))
      .toContain("1 merge, 1 rename were applied");
  });
});
