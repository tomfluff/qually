// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, it, expect } from "vitest";
import { codeOrigins, foldDecisions, originCounts, historyOf, methodsParagraph } from "./provenance";
import { AI_PROPOSED_BY_PREFIX, type Decision } from "./state/store";

const d = (
  kind: Decision["kind"], codes: string[], source: Decision["source"] = "you",
  extra: Partial<Decision> = {},
): Decision => ({ at: "2026-08-23T00:00:00.000Z", kind, codes, why: "", source, ...extra });

type Disposition = Parameters<typeof methodsParagraph>[2];
const paragraph = (ledger: Decision[], codes: string[], disposition: Disposition = {
  segments: [], stretches: [],
}) => methodsParagraph(ledger, codes, disposition);

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

  it("does not let coding or section verdicts change code identity", () => {
    const m = codeOrigins([
      d("accept-coding", ["a"], "ai"),
      d("accept-section", ["phase: intro"], "ai"),
    ], ["a"]);
    expect(m.get("a")).toBe("untouched");
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

  it("keeps section labels out of a same-named code's history", () => {
    const h = historyOf([
      d("accept-section", ["phase: intro"], "ai"),
      d("accept-coding", ["phase: intro"], "ai"),
    ], "phase: intro");
    expect(h.map((row) => row.kind)).toEqual(["accept-coding"]);
  });
});

describe("methods paragraph", () => {
  it("says plainly when no model was involved", () => {
    const p = paragraph([d("merge", ["a", "b"]), d("rename", ["c", "d"])], ["a", "c"]);
    expect(p).toContain("2 code");
    expect(p).toContain("1 merge, 1 rename were applied");
    expect(p).toContain("No language model proposed any of them.");
  });

  it("names the model and insists it applied nothing", () => {
    const p = paragraph([d("merge", ["a", "b"], "ai", { model: "Terra" })], ["a"]);
    expect(p).toContain("Terra");
    expect(p).toContain("the model applied nothing");
  });

  it("counts reversed decisions rather than hiding them", () => {
    const p = paragraph([d("merge", ["a", "b"], "you", { undone: true })], ["a", "b"]);
    expect(p).toContain("1 decision was made and then reversed");
  });

  it("stays a single sentence when nothing has been decided", () => {
    expect(paragraph([], ["a"])).toBe("The first author consolidated the codebook to 1 code.");
  });

  it("keeps coding rows out of every codebook-consolidation count", () => {
    const codingRows = Array.from({ length: 100 }, () =>
      d("accept-coding", ["a"], "ai", { model: "Terra", moved: 1 }));
    const p = paragraph([
      d("merge", ["a", "b"], "ai", { model: "Terra" }),
      ...codingRows,
    ], ["a"], { segments: Array.from({ length: 100 }, () => ({
      status: "accepted", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra",
    })), stretches: [] });
    expect(p).toContain("1 merge was applied");
    expect(p).toContain("1 began as a proposal from a large language model");
    expect(p).not.toContain("101 began as a proposal");
    expect(p).toContain("analysis as it stands, the first author has accepted 100 codings proposed by a language model");
  });

  it("counts current AI codings and sections from their live disposition, not history rows", () => {
    const p = paragraph([
      d("accept-coding", ["a"], "ai", { moved: 3 }),
      d("reject-coding", ["b"], "ai", { moved: 2 }),
      d("accept-section", ["phase: intro"], "ai", { moved: 4 }),
      d("reject-section", ["phase: task"], "ai", { moved: 1 }),
      d("reject-coding", ["c"], "you", { moved: 99 }),
    ], ["a"], {
      segments: [
        ...Array.from({ length: 3 }, () => ({ status: "accepted", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" })),
        ...Array.from({ length: 2 }, () => ({ status: "rejected", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" })),
        { status: "rejected", proposedBy: "Researcher" },
      ],
      stretches: [
        ...Array.from({ length: 4 }, () => ({ status: "accepted" as const, proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" })),
        { status: "rejected", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" },
      ],
    });
    expect(p).toContain("analysis as it stands, the first author has accepted 3 codings proposed by a language model and rejected 2");
    expect(p).toContain("analysis as it stands, the first author has accepted 4 sections proposed by a language model and rejected 1");
  });

  it("drops a deleted accepted proposal from the current-corpus claim", () => {
    const p = paragraph([d("accept-coding", ["a"], "ai", { moved: 1 })], ["a"]);
    expect(p).not.toContain("analysis as it stands");
  });

  it("reports no-verdict discards separately without counting them as rejections", () => {
    const p = paragraph([
      d("discard-coding", ["a"], "ai", { moved: 6 }),
      d("discard-section", ["phase: intro"], "ai", { moved: 2 }),
    ], ["a"]);
    expect(p).toContain("clearing 6 codings proposed by a language model without recording a verdict");
    expect(p).toContain("clearing 2 sections proposed by a language model without recording a verdict");
    expect(p).not.toContain("as rejected");
  });
});

describe("ledger folding for display", () => {
  it("folds each run-shaped disposition with the same reason and keeps that reason", () => {
    const kinds: Decision["kind"][] = [
      "accept-coding", "reject-coding", "discard-coding",
      "accept-section", "reject-section", "discard-section",
    ];
    for (const kind of kinds) {
      const folded = foldDecisions([
        d(kind, ["a"], "ai", { model: "Terra", moved: 1, why: "No reason recorded",
          at: "2026-08-23T00:00:00.000Z" }),
        d(kind, ["a"], "ai", { model: "Terra", moved: 2, why: "No reason recorded",
          at: "2026-08-23T00:01:00.000Z" }),
      ]);
      expect(folded, kind).toHaveLength(1);
      expect(folded[0], kind).toMatchObject({
        moved: 3, why: "No reason recorded", at: "2026-08-23T00:01:00.000Z",
      });
    }
  });

  it("keeps adjacent verdicts with different researcher reasons as separate rows", () => {
    const folded = foldDecisions([
      d("reject-coding", ["a"], "ai", { model: "Terra", moved: 1, why: "Too broad" }),
      d("reject-coding", ["a"], "ai", { model: "Terra", moved: 1, why: "Wrong speaker" }),
    ]);
    expect(folded.map((row) => row.why)).toEqual(["Too broad", "Wrong speaker"]);
  });

  it("does not fold across an intervening or differing row", () => {
    const terra = d("reject-coding", ["a"], "ai", { model: "Terra", moved: 1 });
    const luna = d("reject-coding", ["a"], "ai", { model: "Luna", moved: 1 });
    const folded = foldDecisions([terra, luna, terra]);
    expect(folded).toHaveLength(3);
    expect(folded.map((x) => x.model)).toEqual(["Terra", "Luna", "Terra"]);
  });

  it("leaves adjacent codebook decisions separate with their rationales intact", () => {
    const kinds: Decision["kind"][] = [
      "merge", "rename", "remove", "delete", "keep", "park", "unpark", "dismiss", "define",
    ];
    for (const kind of kinds) {
      const folded = foldDecisions([
        d(kind, ["a"], "you", { why: "first", moved: 1, now: 1, blind: "agreed" }),
        d(kind, ["a"], "you", { why: "second", moved: 1, now: 1, blind: "agreed" }),
      ]);
      expect(folded.map((row) => row.why), kind).toEqual(["first", "second"]);
    }
  });
});

describe("the agreement rate", () => {
  it("reports verdicts formed before the model's was shown", () => {
    const p = paragraph([
      d("merge", ["a", "b"], "ai", { blind: "agreed" }),
      d("merge", ["c", "e"], "ai", { blind: "agreed" }),
      d("dismiss", ["f", "g"], "ai", { blind: "differed" }),
    ], ["a", "c"]);
    expect(p).toContain("On 3 proposals the researcher recorded a verdict before seeing the model's");
    expect(p).toContain("agreeing with it on 2 and differing on 1");
  });

  it("says nothing about agreement when nothing was called blind", () => {
    expect(paragraph([d("merge", ["a", "b"], "ai")], ["a"]))
      .not.toContain("before seeing");
  });
});

describe("the paragraph reads as English", () => {
  it("agrees the verb with how many decisions there were", () => {
    expect(paragraph([d("merge", ["a", "b"])], ["a"])).toContain("1 merge was applied");
    expect(paragraph([d("merge", ["a", "b"]), d("merge", ["c", "e"])], ["a", "c"]))
      .toContain("2 merges were applied");
    // one of each is still two decisions
    expect(paragraph([d("merge", ["a", "b"]), d("rename", ["c", "d"])], ["a", "c"]))
      .toContain("1 merge, 1 rename were applied");
  });
});

// A zero side is left out rather than stated: "accepted 0 codings and rejected 1"
// is true, but it reads as filler in a paragraph written to be pasted into a paper.
describe("the standing-disposition sentence", () => {
  const seg = (sid: number, status: string) => ({ sid, pid: "P01", start: sid, end: sid,
    code: "c", notes: "", proposedBy: "AI · Terra", status });
  it("names only the side that has anything on it", () => {
    const one = methodsParagraph([], ["c"], { segments: [seg(1, "accepted")], stretches: [] });
    expect(one).toContain("has accepted 1 coding proposed by a language model.");
    expect(one).not.toContain("rejected 0");
  });
  it("keeps both sides when both are non-zero, because the contrast is the point", () => {
    const both = methodsParagraph([], ["c"],
      { segments: [seg(1, "accepted"), seg(2, "rejected")], stretches: [] });
    expect(both).toContain("has accepted 1 coding proposed by a language model and rejected 1.");
  });
});
