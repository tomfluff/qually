// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The search filter: which lines a query — and a Replace All — may touch.
// One speaker's words, or one stretch of the session.
import { beforeAll, test, expect } from "vitest";
import { parseRange, scopeFilter } from "./search";

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
1,00:00:10,R,which system did you prefer,
2,00:00:20,P,the first system was quicker,pace
3,00:05:00,R,and the first system after the break,
4,00:05:30,P,the first system still won,pace
`,
  ], "P02.csv")]);
});

const L = (id: number, ts: string, speaker: string) => ({ id, ts, speaker });

test("a range reads as lines, or as a stretch of the session", () => {
  expect(parseRange("12-40")).toEqual({ time: false, a: 12, b: 40 });
  expect(parseRange("3:00-12:30")).toEqual({ time: true, a: 180, b: 750 });
  expect(parseRange("00:03:00-00:12:30")).toEqual({ time: true, a: 180, b: 750 });
});

test("one end may be left off, and typing it backwards means the same stretch", () => {
  expect(parseRange("12-")).toEqual({ time: false, a: 12, b: Infinity });
  expect(parseRange("-40")).toEqual({ time: false, a: 0, b: 40 });
  expect(parseRange("12")).toEqual({ time: false, a: 12, b: Infinity }); // bare: from there on
  expect(parseRange("40-12")).toEqual({ time: false, a: 12, b: 40 });
});

test("nonsense is null, so the bar can say so instead of searching everything", () => {
  expect(parseRange("")).toBeNull();
  expect(parseRange("   ")).toBeNull();
  expect(parseRange("-")).toBeNull();
  expect(parseRange("abc")).toBeNull();
  expect(parseRange("1-2-3")).toBeNull();
  expect(parseRange("12-abc")).toBeNull();
  // mixed ends are refused, not guessed at: "3:00-12" read as 0:12–3:00 would
  // hand Replace All the wrong stretch of the session
  expect(parseRange("12-3:00")).toBeNull();
  expect(parseRange("3:00-12")).toBeNull();
});

test("a blank filter takes every line", () => {
  const f = scopeFilter({ speaker: "", range: "" });
  expect(f(L(1, "", "P"))).toBe(true);
  expect(f(L(999, "01:00:00", "R"))).toBe(true);
});

test("a speaker filter matches the name however it was typed in the file", () => {
  const f = scopeFilter({ speaker: "p", range: "" });
  expect(f(L(1, "00:00:10", " P "))).toBe(true);
  expect(f(L(2, "00:00:10", "R"))).toBe(false);
});

test("a time range leaves out the lines with no timecode", () => {
  const f = scopeFilter({ speaker: "", range: "3:00-6:00" });
  expect(f(L(1, "00:05:00", "P"))).toBe(true);
  expect(f(L(2, "00:00:20", "P"))).toBe(false);
  // blank ts is not 0:00 — an unplaceable line is outside every stretch
  expect(f(L(3, "", "P"))).toBe(false);
});

test("speaker and range both narrow, together", () => {
  const f = scopeFilter({ speaker: "P", range: "2-3" });
  expect(f(L(2, "00:00:20", "P"))).toBe(true);
  expect(f(L(3, "00:05:00", "R"))).toBe(false); // in range, wrong speaker
  expect(f(L(4, "00:05:30", "P"))).toBe(false); // right speaker, out of range
});

test("a range typed but unreadable holds everything back, rather than searching it all", () => {
  const f = scopeFilter({ speaker: "", range: "12--40" });
  expect(f(L(1, "00:00:10", "P"))).toBe(false);
  expect(f(L(40, "00:05:00", "R"))).toBe(false);
  // and the sweep obeys the same predicate, so a typo cannot rewrite the file
  expect(useStore.getState()
    .replaceInTranscript("P02", "the first system", "[Beacon]", { speaker: "", range: "12--40" })).toBe(0);
  expect(useStore.getState().transcripts.P02.lines[1].text).toBe("the first system was quicker");
});

test("Replace All rewrites only what the filter was counting", () => {
  const n = useStore.getState()
    .replaceInTranscript("P02", "the first system", "[Beacon]", { speaker: "P", range: "" });
  expect(n).toBe(2);
  const lines = useStore.getState().transcripts.P02.lines;
  expect(lines[1].text).toBe("[Beacon] was quicker");
  expect(lines[3].text).toBe("[Beacon] still won");
  expect(lines[2].text).toBe("and the first system after the break"); // the interviewer's, untouched
  expect(lines[2].orig).toBeUndefined();
});

test("a time range bounds the sweep to that stretch of the session", () => {
  useStore.getState().undo(); // back to the imported wording
  const n = useStore.getState()
    .replaceInTranscript("P02", "the first system", "[Beacon]", { speaker: "", range: "4:00-" });
  expect(n).toBe(2); // both after the break, either speaker
  const lines = useStore.getState().transcripts.P02.lines;
  expect(lines[1].text).toBe("the first system was quicker"); // before the break
  expect(lines[2].text).toBe("and [Beacon] after the break");
  expect(lines[3].text).toBe("[Beacon] still won");
});
