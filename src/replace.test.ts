// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Find and replace: the substitution convention ("the first system" becomes
// "[Beacon]"), the provenance it leaves, and its one-gesture undo.
import { beforeAll, test, expect } from "vitest";
import { findMatches, replaceOccurrence, replaceAllIn } from "./search";
import { subSpans, withSubs } from "./markup";
import type { ReactElement, ReactNode } from "react";

let useStore: typeof import("./state/store").useStore;

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));
  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text,codes
1,00:00:03,P,the first system was slower than the first one,pace
2,00:00:09,P,but the first system had better labels,labels
3,00:00:14,P,the second system never lost my place,pace
`,
  ], "P01.csv")]);
});

test("one occurrence at a time, counted the way the bar counts them", () => {
  const t = "the first system was slower than the first one";
  expect(findMatches(t, "the first").length).toBe(2);
  expect(replaceOccurrence(t, "the first", 1, "[Beacon]"))
    .toBe("the first system was slower than [Beacon] one");
});

test("replaceAllIn is one left-to-right pass, so a replacement holding the query is not re-eaten", () => {
  const { text, n } = replaceAllIn("system and system", "system", "[system A]");
  expect(n).toBe(2);
  expect(text).toBe("[system A] and [system A]");
});

test("case-insensitive, like the search that found them", () => {
  expect(replaceAllIn("First system. FIRST SYSTEM.", "first system", "[Beacon]").n).toBe(2);
});

test("replacing across a transcript keeps the words as transcribed", () => {
  const st = useStore.getState();
  const n = st.replaceInTranscript("P01", "the first system", "[Beacon]");
  expect(n).toBe(2);
  const lines = useStore.getState().transcripts.P01.lines;
  expect(lines[0].text).toBe("[Beacon] was slower than the first one");
  expect(lines[0].orig).toBe("the first system was slower than the first one");
  expect(lines[1].text).toBe("but [Beacon] had better labels");
  expect(lines[2].text).toBe("the second system never lost my place"); // untouched
  expect(lines[2].orig).toBeUndefined();
});

test("the whole sweep is ONE undo, and redo puts it back", () => {
  // self-contained: this test does its own sweep rather than leaning on the
  // one above, so it passes run alone as well as in file order
  useStore.getState().replaceInTranscript("P01", "the first system", "[Beacon]");
  const before = useStore.getState().transcripts.P01.lines.map((l) => l.text);
  useStore.getState().undo();
  const after = useStore.getState().transcripts.P01.lines;
  expect(after[0].text).toBe("the first system was slower than the first one");
  expect(after[1].text).toBe("but the first system had better labels");
  expect(after[0].orig).toBeUndefined(); // the provenance mark goes back with it
  useStore.getState().redo();
  expect(useStore.getState().transcripts.P01.lines.map((l) => l.text)).toEqual(before);
});

test("a replace that changes nothing costs no history", () => {
  const depth = useStore.getState().undoStack.length;
  expect(useStore.getState().replaceInTranscript("P01", "no such words", "[x]")).toBe(0);
  expect(useStore.getState().undoStack.length).toBe(depth);
});

test("substitutions are found for markup wherever they sit in the line", () => {
  expect(subSpans("[Beacon] was slower than the first one")).toEqual([[0, 8]]);
  expect(subSpans("she liked [Beacon] and [Harbor] both")).toEqual([[10, 18], [23, 31]]);
  expect(subSpans("no brackets here")).toEqual([]);
  expect(subSpans("an empty [] is not a substitution")).toEqual([]);
});

test("a substitution split across two slices is styled on both sides of the cut", () => {
  const full = "she said [Beacon] loud";
  const spans = subSpans(full);
  expect(spans).toEqual([[9, 17]]);
  // the two halves a search hit on "acon" would cut the line into
  const left = withSubs(full.slice(0, 13), 0, spans) as ReactElement[];
  const right = withSubs(full.slice(13), 13, spans) as ReactElement[];
  const styled = (n: ReactNode) =>
    typeof n === "object" && n !== null && "props" in n
      ? (n as ReactElement<{ className?: string; children?: ReactNode }>) : null;
  expect(left.map((n) => styled(n)?.props.children ?? n)).toEqual(["she said ", "[Bea"]);
  expect(styled(left[1])?.props.className).toBe("subst");
  expect(right.map((n) => styled(n)?.props.children ?? n)).toEqual(["con]", " loud"]);
  expect(styled(right[0])?.props.className).toBe("subst");
});

test("undoing a sweep on a closed tab brings the transcript back into view", () => {
  const st = useStore.getState();
  st.replaceInTranscript("P01", "the second system", "[Harbor]");
  st.closeTab("P01");
  expect(useStore.getState().tabs).not.toContain("P01");
  useStore.getState().undo();
  const after = useStore.getState();
  expect(after.tabs).toContain("P01");       // no silent off-screen edit
  expect(after.active).toBe("P01");
  expect(after.transcripts.P01.lines[2].text).toBe("the second system never lost my place");
});

// toLowerCase is not length-preserving: Turkish dotted capital I (U+0130)
// lowercases to two UTF-16 units. Offsets taken from the lowered string drift
// by one for everything after it, and in replaceAllIn that drift landed on a
// WRITE — it ate a character and still reported a successful replacement.
test("a case fold that changes length still replaces the right span", () => {
  expect(replaceAllIn("İstanbul was mentioned", "was", "X"))
    .toEqual({ text: "İstanbul X mentioned", n: 1 });
  expect(replaceAllIn("Ordu İl was there", "was", "X"))
    .toEqual({ text: "Ordu İl X there", n: 1 });
});

test("and finds it at the right offset in the first place", () => {
  expect(findMatches("İstanbul was mentioned", "was")).toEqual([[9, 12]]);
  expect(findMatches("İstanbul", "İst")).toEqual([[0, 3]]);
});
