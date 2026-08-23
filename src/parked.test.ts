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

  it("travels in the project file", () => {
    useStore.getState().setParked("stray", true);
    const p = parseProject(useStore.getState().exportProject());
    expect(p.codebook.stray.parked).toBe(true);
  });
});
