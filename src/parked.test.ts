// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Setting a code aside: it leaves the working codebook and every excerpt stays.
import { describe, it, expect, beforeEach } from "vitest";
import { useStore, liveCodes, parkedCodes } from "./state/store";
import { parseProject } from "./project";

const reset = () => {
  useStore.setState({
    transcripts: { P01: { lines: [{ id: 1, ts: "0:00", speaker: "P", text: "the labels are tiny" }] } },
    segments: [
      { sid: 1, pid: "P01", start: 1, end: 1, code: "small text", notes: "", proposedBy: "me", status: "accepted" },
      { sid: 2, pid: "P01", start: 1, end: 1, code: "stray", notes: "", proposedBy: "me", status: "accepted" },
    ],
    codebook: {
      "small text": { color: "#4477aa", def: "", status: "candidate" },
      stray: { color: "#aa4477", def: "", status: "candidate" },
    },
    hotbar: { mode: "auto", pinned: [] },
    tabs: ["P01"], active: "P01", ledger: [], undoStack: [], redoStack: [],
  });
};

describe("setting a code aside", () => {
  beforeEach(reset);

  it("takes it out of the working codebook and leaves its excerpts alone", () => {
    useStore.getState().setParked("stray", true);
    const s = useStore.getState();
    expect(liveCodes(s.codebook)).toEqual(["small text"]);
    expect(parkedCodes(s.codebook)).toEqual(["stray"]);
    expect(s.segments.filter((x) => x.code === "stray")).toHaveLength(1);
    expect(s.segments.every((x) => x.status === "accepted")).toBe(true);
  });

  it("is not a rejection — rejectCode is still the thing that touches segments", () => {
    useStore.getState().rejectCode("stray");
    expect(useStore.getState().segments.find((x) => x.code === "stray")!.status).toBe("rejected");
    expect(useStore.getState().codebook.stray.parked).toBeUndefined();
  });

  it("stops the hotbar offering it", () => {
    expect(useStore.getState().hotbarCache).toContain("stray");
    useStore.getState().setParked("stray", true);
    expect(useStore.getState().hotbarCache).not.toContain("stray");
  });

  it("keeps a pin through a park, and honours it again on the way back", () => {
    useStore.setState({ hotbar: { mode: "pinned", pinned: ["stray"] } });
    useStore.getState().setParked("stray", true);
    expect(useStore.getState().hotbar.pinned).toEqual(["stray"]);
    expect(useStore.getState().hotbarCache).not.toContain("stray");
    useStore.getState().setParked("stray", false);
    expect(useStore.getState().hotbarCache).toContain("stray");
  });

  it("writes both directions to the ledger", () => {
    useStore.getState().setParked("stray", true);
    useStore.getState().setParked("stray", false);
    expect(useStore.getState().ledger.map((d) => d.kind)).toEqual(["park", "unpark"]);
  });

  it("does nothing, and logs nothing, when the state already matches", () => {
    useStore.getState().setParked("stray", false);
    useStore.getState().setParked("nope", true);
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  it("is undoable", () => {
    useStore.getState().setParked("stray", true);
    useStore.getState().undo();
    expect(parkedCodes(useStore.getState().codebook)).toEqual([]);
  });

  it("says which codes are set aside in codebook.csv", () => {
    useStore.getState().setParked("stray", true);
    const rows = useStore.getState().exportCodebook().trim().split(/\r?\n/);
    expect(rows[0]).toContain("set_aside");
    // sorted by code: "small text" then "stray"
    expect(rows[1].endsWith(",")).toBe(true);      // not set aside — empty cell
    expect(rows[2].endsWith("yes")).toBe(true);
  });

  it("travels in the project file", () => {
    useStore.getState().setParked("stray", true);
    const p = parseProject(useStore.getState().exportProject());
    expect(p.codebook.stray.parked).toBe(true);
  });
});

// The thin tail's "Undo that" identifies the entry its fold pushed, so it can
// tell "nothing has happened since" from "something has". It used to count the
// stack instead — and the stack is CAPPED, so once a real session filled it the
// count stopped moving and the button refused for the rest of the session while
// the toolbar's Undo went on working. The cap is the trap; this pins it.
describe("the undo stack's length is not an identity", () => {
  it("stops growing at the cap while still taking new entries", () => {
    useStore.setState({ undoStack: [], redoStack: [] });
    const push = () => useStore.getState().pushUndo();

    for (let i = 0; i < 80; i++) push();
    const full = useStore.getState().undoStack.length;
    expect(full).toBe(80);

    const topBefore = useStore.getState().undoStack[full - 1];
    push();
    const after = useStore.getState().undoStack;
    // the length says nothing happened...
    expect(after.length).toBe(full);
    // ...while the top of the stack says something did. That difference is
    // exactly what the fold's undo has to read.
    expect(after[after.length - 1]).not.toBe(topBefore);
  });

  it("keeps our entry on top while nothing else pushes, cap or no cap", () => {
    useStore.setState({ undoStack: [], redoStack: [] });
    for (let i = 0; i < 80; i++) useStore.getState().pushUndo();
    useStore.getState().pushUndo();
    const stack = useStore.getState().undoStack;
    const ours = stack[stack.length - 1];
    // reading the store again does not move it; only another push would
    const later = useStore.getState().undoStack;
    expect(later[later.length - 1]).toBe(ours);
  });
});
