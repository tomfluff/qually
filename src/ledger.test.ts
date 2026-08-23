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
    expect(head).toBe("at,kind,codes,why,source,model,excerpts_moved,excerpts_after,blind,undone");
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

describe("decisions made through the Code map's proposals", () => {
  beforeEach(reset);

  it("logs a whole merge capsule as one row, naming whose idea it was", () => {
    useStore.setState({ codeClusters: [{
      survivor: "small text", codes: ["small text", "tiny text"],
      rationale: "One concept under two names.", source: "ai", model: "Terra",
    }] });
    useStore.getState().applyCluster(0);
    const [d] = useStore.getState().ledger;
    expect(d.kind).toBe("merge");
    expect(d.codes).toEqual(["small text", "tiny text"]);
    expect(d.source).toBe("ai");
    expect(d.model).toBe("Terra");
    expect(d.why).toBe("One concept under two names.");
    expect(d.moved).toBe(1);   // tiny text's one coding
    expect(d.now).toBe(2);     // small text carries both afterwards
  });

  it("names the merged concept when the capsule renames it", () => {
    useStore.setState({ codeClusters: [{
      survivor: "small text", codes: ["small text", "tiny text"],
      newName: "unreadable labels", rationale: "", source: "you",
    }] });
    useStore.getState().applyCluster(0);
    expect(useStore.getState().ledger[0].codes[0]).toBe("unreadable labels");
  });

  it("records the survivor as folded away when the typed name lands on an existing code", () => {
    // "Small Text" norm-collides with nothing here, but the typed name
    // norm-collides with "Unreadable Labels": the capsule's survivor merges
    // INTO it, so the row must name the real code and list the survivor's
    // name among the folded — or its verdicts and history stop following
    useStore.setState({
      codebook: { ...useStore.getState().codebook,
        "Unreadable Labels": { color: "#447744", def: "", status: "candidate" } },
      codeClusters: [{
        survivor: "small text", codes: ["small text", "tiny text"],
        newName: "unreadable labels", rationale: "", source: "you",
      }],
    });
    useStore.getState().applyCluster(0);
    const st = useStore.getState();
    expect(st.codebook["small text"]).toBeUndefined();
    expect(st.codebook["Unreadable Labels"]).toBeDefined();
    const [d] = st.ledger;
    expect(d.codes).toEqual(["Unreadable Labels", "tiny text", "small text"]);
    expect(d.moved).toBe(2); // both original codes' excerpts moved into the existing name
  });

  it("keeps the proposals you turned down", () => {
    useStore.setState({ codeClusters: [{
      survivor: "small text", codes: ["small text", "tiny text"],
      rationale: "Near-duplicates.", source: "ai", model: "Terra",
    }] });
    useStore.getState().dismissCluster(0);
    const [d] = useStore.getState().ledger;
    expect(d.kind).toBe("dismiss");
    expect(d.source).toBe("ai");
    expect(d.why).toBe("Near-duplicates.");
    expect(useStore.getState().codeClusters).toHaveLength(0);
  });

  it("stamps a landing run's provenance onto its proposals", () => {
    useStore.getState().applyReconcilePlan(
      [{ survivor: "small text", codes: ["small text", "tiny text"], rationale: "r" }],
      [{ code: "small text", action: "rename", newName: "labels", rationale: "clearer" }],
      false, "ai", "Terra");
    const st = useStore.getState();
    expect(st.codeClusters[0].source).toBe("ai");
    expect(st.codeClusters[0].model).toBe("Terra");
    expect(st.codePlan[0].source).toBe("ai");
  });

  it("counts what a merge moved even after the folded code is gone", () => {
    useStore.getState().mergeCode("tiny text", "small text");
    const [d] = useStore.getState().ledger;
    expect(d.moved).toBe(1);
    expect(d.now).toBe(2);
    expect(useStore.getState().codebook["tiny text"]).toBeUndefined();
  });
});
