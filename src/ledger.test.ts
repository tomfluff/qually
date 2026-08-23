// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The decision ledger: every codebook decision lands one row, undo flags rather
// than erases, and the whole thing round-trips through the project file.
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./state/store";
import { parseProject } from "./project";

const reset = () => {
  useStore.setState({
    transcripts: { P01: { lines: [
      { id: 1, ts: "0:00", speaker: "P", text: "the labels are tiny" },
      { id: 2, ts: "0:04", speaker: "P", text: "i cannot read the axis" },
    ] } },
    segments: [
      { sid: 1, pid: "P01", start: 1, end: 1, code: "small text", notes: "", proposedBy: "me", status: "accepted" },
      { sid: 2, pid: "P01", start: 2, end: 2, code: "tiny text", notes: "", proposedBy: "me", status: "accepted" },
    ],
    codebook: {
      "small text": { color: "#4477aa", def: "", status: "candidate" },
      "tiny text": { color: "#aa4477", def: "", status: "candidate" },
    },
    tabs: ["P01"], active: "P01", ledger: [], undoStack: [], redoStack: [],
  });
};

describe("decision ledger", () => {
  beforeEach(reset);

  it("logs a merge with the reason and the source", () => {
    useStore.getState().mergeCode("tiny text", "small text", "same wording", "wording");
    const [d] = useStore.getState().ledger;
    expect(d.kind).toBe("merge");
    expect(d.codes).toEqual(["small text", "tiny text"]); // survivor first
    expect(d.why).toBe("same wording");
    expect(d.source).toBe("wording");
    expect(d.at).toMatch(/^\d{4}-/);
  });

  it("defaults the source to the researcher and writes its own reason", () => {
    useStore.getState().deleteCode("tiny text");
    const [d] = useStore.getState().ledger;
    expect(d.source).toBe("you");
    expect(d.kind).toBe("delete");
    expect(d.why).toContain("1 coding");
  });

  it("records a rename, newest name first", () => {
    useStore.getState().renameCode("tiny text", "minuscule text");
    const [d] = useStore.getState().ledger;
    expect(d.kind).toBe("rename");
    expect(d.codes).toEqual(["minuscule text", "tiny text"]);
  });

  it("calls a rename onto an existing code what it is — a merge", () => {
    useStore.getState().renameCode("tiny text", "small text");
    expect(useStore.getState().ledger.map((d) => d.kind)).toEqual(["merge"]);
  });

  it("counts the excerpts a removal rejected", () => {
    useStore.getState().rejectCode("small text");
    const [d] = useStore.getState().ledger;
    expect(d.kind).toBe("remove");
    expect(d.why).toContain("1 excerpt");
  });

  it("flags an undone decision instead of erasing it, and unflags on redo", () => {
    const st = useStore.getState();
    st.mergeCode("tiny text", "small text");
    expect(useStore.getState().ledger).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0].undone).toBe(true);
    useStore.getState().redo();
    expect(useStore.getState().ledger[0].undone).toBe(false);
  });

  it("leaves earlier decisions alone when a later one is undone", () => {
    useStore.getState().renameCode("tiny text", "minuscule text");
    useStore.getState().deleteCode("minuscule text");
    useStore.getState().undo();
    const l = useStore.getState().ledger;
    expect(l.map((d) => !!d.undone)).toEqual([false, true]);
  });

  it("exports one row per decision, undone ones marked", () => {
    useStore.getState().mergeCode("tiny text", "small text", "one idea", "ai", "Terra");
    useStore.getState().undo();
    const csv = useStore.getState().exportLedger();
    const [head, row] = csv.trim().split(/\r?\n/);
    expect(head).toBe("at,kind,codes,why,source,model,undone");
    expect(row).toContain("small text | tiny text");
    expect(row).toContain("Terra");
    expect(row.endsWith("yes")).toBe(true);
  });

  it("travels in the project file", () => {
    useStore.getState().mergeCode("tiny text", "small text", "one idea", "ai", "Terra");
    const p = parseProject(useStore.getState().exportProject());
    expect(p.ledger).toHaveLength(1);
    expect(p.ledger![0].model).toBe("Terra");
    reset();
    useStore.getState().openProject(p);
    expect(useStore.getState().ledger).toHaveLength(1);
  });

  it("loads a project written before the ledger existed", () => {
    const old = JSON.parse(useStore.getState().exportProject());
    delete old.ledger;
    expect(parseProject(JSON.stringify(old)).ledger).toEqual([]);
  });
});
