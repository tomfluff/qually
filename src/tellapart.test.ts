// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The distinguishing sentence, at the store level: what each answer leaves
// behind. (The dialog itself is exercised in the app; these are the effects
// that have to survive a reload.)
import { beforeAll, beforeEach, test, expect } from "vitest";

let useStore: typeof import("./state/store").useStore;

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore } = await import("./state/store"));
});

beforeEach(() => {
  useStore.setState({
    transcripts: { P01: { lines: [
      { id: 1, ts: "0:00", speaker: "P", text: "the labels are tiny" },
      { id: 2, ts: "0:04", speaker: "P", text: "hard to see the boundary" },
    ] } },
    segments: [
      { sid: 1, pid: "P01", start: 1, end: 1, code: "difficult to see", notes: "", proposedBy: "me", status: "accepted" },
      { sid: 2, pid: "P01", start: 2, end: 2, code: "hard to see", notes: "", proposedBy: "me", status: "accepted" },
    ],
    codebook: {
      "difficult to see": { color: "#4477aa", def: "", status: "c" },
      "hard to see": { color: "#aa4477", def: "", status: "c" },
    },
    ledger: [], undoStack: [], redoStack: [], codeClusters: [],
  });
});

test("keeping both writes the sentence as BOTH definitions, in one step", () => {
  const line = "The first is the whole chart; the second is one boundary.";
  useStore.getState().defineBoth("difficult to see", "hard to see", line);
  const s = useStore.getState();
  expect(s.codebook["difficult to see"].def).toBe(line);
  expect(s.codebook["hard to see"].def).toBe(line);
  // the sentence IS the reason: a keep with no stated line is not this decision
  expect(s.ledger[0].why).toBe(line);
  expect(s.ledger[0].codes).toEqual(["difficult to see", "hard to see"]);
  // one act, so one step back — never a state where one code is defined and
  // the other is not
  useStore.getState().undo();
  const back = useStore.getState();
  expect(back.codebook["difficult to see"].def).toBe("");
  expect(back.codebook["hard to see"].def).toBe("");
});

test("refuses to define a pair that is not two live codes", () => {
  const before = useStore.getState().ledger.length;
  useStore.getState().defineBoth("difficult to see", "difficult to see", "same code twice");
  useStore.getState().defineBoth("difficult to see", "not a code", "one of them is gone");
  useStore.getState().defineBoth("difficult to see", "hard to see", "   ");
  expect(useStore.getState().ledger).toHaveLength(before);
});

test("a definition written by hand is not marked as the model's", () => {
  useStore.getState().defineBoth("difficult to see", "hard to see", "Mine, typed.");
  expect(useStore.getState().codebook["hard to see"].defAi).toBe(false);
  expect(useStore.getState().codebook["difficult to see"].defAi).toBe(false);
});

test("failing to separate them records that as the reason", () => {
  useStore.getState().mergeCode("hard to see", "difficult to see",
    "Could not write a sentence that separates them", "you");
  const s = useStore.getState();
  expect(s.codebook["hard to see"]).toBeUndefined();
  expect(s.ledger[0].kind).toBe("merge");
  expect(s.ledger[0].source).toBe("you");
  expect(s.ledger[0].why).toContain("Could not write a sentence");
  expect(s.ledger[0].moved).toBe(1); // the excerpt that came across
});
