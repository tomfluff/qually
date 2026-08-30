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

  // Only "unfinished" merges, so a terminator we fail to recognise is the
  // damaging direction: every line of that language reads as mid-sentence and
  // the transcript folds into one group per speaker. This was exactly the state
  // of every non-Latin script, and of English typed with curly quotes.
  describe("sentence terminators across scripts", () => {
    const finished = (text: string) =>
      mergeGroups([L(1, "P", text), L(2, "P", "next")], true).length === 2;

    it("recognises the mark each script actually ends a sentence with", () => {
      for (const [name, text] of [
        ["English", "I zoom in."],
        ["English, curly quotes", "\u201cI zoom in.\u201d"],   // what Word and most transcribers emit
        ["English, single curly", "he said \u2018yes.\u2019"],
        ["Japanese", "\u62e1\u5927\u3057\u307e\u3059\u3002"],           // 。
        ["Japanese question", "\u4f7f\u3044\u307e\u3059\u304b\uff1f"],  // ？
        ["Japanese exclamation", "\u3059\u3054\u3044\uff01"],             // ！
        ["Japanese quoted", "\u300c\u306f\u3044\u3002\u300d"],           // 「…。」
        ["Chinese", "\u6211\u653e\u5927\u4e86\u3002"],
        ["Hebrew", "\u05d0\u05e0\u05d9 \u05de\u05d2\u05d3\u05d9\u05dc."],
        // RTL text routinely carries a direction mark AFTER its full stop, which
        // sat between the terminator and the end of the string
        ["Hebrew with a trailing RLM", "\u05d0\u05e0\u05d9 \u05de\u05d2\u05d3\u05d9\u05dc.\u200f"],
        ["Arabic question", "\u0647\u0644 \u062a\u0633\u062a\u062e\u062f\u0645\u061f"],
        ["Urdu", "\u0645\u06cc\u06ba \u062f\u06cc\u06a9\u06be\u062a\u0627 \u06c1\u0648\u06ba\u06d4"],
        ["German", "Ich vergr\u00f6\u00dfere."],
        // German CLOSES with the mark English opens with
        ["German quoted", "Er sagte: \u201eJa.\u201c"],
        ["French guillemets", "Il a dit\u00a0: \u00abOui.\u00bb"],
        ["Spanish", "\u00bfLo usas?"],
        ["Hindi danda", "\u092e\u0948\u0902 \u0915\u0930\u0924\u093e \u0939\u0942\u0901\u0964"],
        ["Greek question mark U+037E", "\u03a4\u03bf \u03c7\u03c1\u03b7\u03c3\u03b9\u03bc\u03bf\u03c0\u03bf\u03b9\u03b5\u03af\u03c2\u037e"],
        ["Armenian", "\u0535\u057d \u056f\u0561\u0580\u0564\u0578\u0582\u0574 \u0565\u0574\u0589"],
        ["Ethiopic", "\u12a5\u1290\u1265\u1263\u1208\u1201\u1362"],
      ] as const) {
        expect(finished(text), `${name}: ${text}`).toBe(true);
      }
    });

    it("still reads a genuinely unfinished line as unfinished", () => {
      for (const [name, text] of [
        ["mid-clause English", "and then I"],
        ["trailing comma", "I zoom, then"],
        ["Japanese continuing", "\u305d\u308c\u3067\u3001"],
        ["Hebrew continuing", "\u05d5\u05d0\u05d6 \u05d0\u05e0\u05d9"],
        ["an OPENING quote is not a close", "He said \u201c"],
        // ASCII ";" is Greek's question mark on most keyboards AND an English
        // clause break. It stays unrecognised on purpose: guessing it terminal
        // would stop English lines merging where they should.
        ["ASCII semicolon", "I zoom in;"],
        ["empty", ""],
      ] as const) {
        expect(finished(text), `${name}: ${text}`).toBe(false);
      }
    });
  });
});
