// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The decision ledger: every analysis decision lands one row, undo flags rather
// than erases, and the whole thing round-trips through the project file.
import { describe, it, expect, beforeEach } from "vitest";
import { AI_PROPOSED_BY_PREFIX, liveCodes, useStore } from "./state/store";
import { parseProject, VERSION } from "./project";
import { methodsParagraph } from "./provenance";

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
    tabs: ["P01"], active: "P01", ledger: [], stretches: [], aiGrounds: {},
    studyBrief: {}, undoStack: [], redoStack: [],
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

  it("redo restores the exact live and reversed rows after two undos", () => {
    useStore.getState().renameCode("small text", "large labels");
    useStore.getState().renameCode("tiny text", "legible axis");
    useStore.getState().undo();
    useStore.getState().undo();
    useStore.getState().redo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([false, true]);
    expect(Object.keys(useStore.getState().codebook).sort()).toEqual(["large labels", "tiny text"]);
  });

  it("keeps the length-only fallback for an older in-memory snapshot", () => {
    useStore.getState().renameCode("tiny text", "legible axis");
    const legacy = { ...useStore.getState().undoStack[0] } as Record<string, unknown>;
    delete legacy.ledgerUndone;
    useStore.setState({ undoStack: [legacy as never] });
    useStore.getState().undo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([true]);
    expect(useStore.getState().codebook).toHaveProperty("tiny text");
  });

  it("exports one row per decision, undone ones marked", () => {
    useStore.getState().mergeCode("tiny text", "small text", "one idea", "ai", "Terra");
    useStore.getState().undo();
    const csv = useStore.getState().exportLedger();
    const [head, row] = csv.trim().split(/\r?\n/);
    expect(head).toBe("at,kind,codes,why,source,model,count,excerpts_after,blind,undone");
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

  it("stamps old ledger kinds by the existing v1/v2 rules and new kinds as v3", () => {
    useStore.getState().renameCode("tiny text", "legible axis");
    expect(JSON.parse(useStore.getState().exportProject()).version).toBe(1);
    useStore.setState({ studyBrief: { "": "Compare the two tasks." } });
    expect(JSON.parse(useStore.getState().exportProject()).version).toBe(2);

    useStore.setState({ segments: [{ sid: 10, pid: "P01", start: 1, end: 1, code: "small text",
      notes: "", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" }] });
    useStore.getState().setStatus(10, "accepted");
    expect(VERSION).toBe(3);
    expect(JSON.parse(useStore.getState().exportProject()).version).toBe(VERSION);
  });
});

describe("proposed coding decisions", () => {
  beforeEach(reset);

  it("keeps every AI verdict flip in history while the paragraph reports current disposition", () => {
    useStore.setState({
      segments: [{ sid: 10, pid: "P01", start: 1, end: 1, code: "small text",
        notes: "fallback note", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" }],
      aiGrounds: { 10: { hash: "h", quotes: ["the labels are tiny"] } },
    });
    useStore.getState().setStatus(10, "accepted");
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "accept-coding", codes: ["small text"], source: "ai", model: "Terra",
      why: "fallback note", moved: 1,
    });
    expect(parseProject(useStore.getState().exportProject()).ledger![0].kind).toBe("accept-coding");
    expect(useStore.getState().exportLedger()).toContain(",accept-coding,");

    useStore.getState().setStatus(10, "rejected");
    const s = useStore.getState();
    expect(s.ledger.map((d) => d.kind)).toEqual(["accept-coding", "reject-coding"]);
    const paragraph = methodsParagraph(s.ledger, liveCodes(s.codebook), {
      segments: s.segments, stretches: s.stretches,
    });
    expect(paragraph).toContain("has rejected 1 coding proposed by a language model");
  });

  it("does not turn hand-marked status changes into proposal verdicts", () => {
    useStore.setState({ segments: [{ sid: 11, pid: "P01", start: 1, end: 1, code: "small text",
      notes: "marked during review", proposedBy: "Researcher", status: "candidate" }] });
    useStore.getState().setStatus(11, "rejected");
    expect(useStore.getState().ledger).toHaveLength(0);

    useStore.setState({ segments: [{ sid: 12, pid: "P01", start: 2, end: 2, code: "tiny text",
      notes: "", proposedBy: "Researcher", status: "candidate" }] });
    useStore.getState().setStatus(12, "accepted");
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  it("logs a single proposed candidate deleted from its popover as a discard", () => {
    useStore.setState({ segments: [{ sid: 13, pid: "P01", start: 1, end: 1, code: "small text",
      notes: "", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" }] });
    useStore.getState().deleteSegment(13);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "discard-coding", codes: ["small text"], source: "ai", model: "Terra", moved: 1,
      why: "No reason recorded",
    });
  });

  it("logs one row for a same-model batch with stable distinct codes", () => {
    useStore.setState({ segments: [
      { sid: 20, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" },
      { sid: 21, pid: "P01", start: 2, end: 2, code: "tiny text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" },
      { sid: 22, pid: "P01", start: 1, end: 2, code: "small text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" },
    ] });
    expect(useStore.getState().deleteSegmentsBy({ status: "candidate" })).toBe(3);
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "discard-coding", codes: ["small text", "tiny text"], source: "ai", model: "Terra", moved: 3,
      why: "No reason recorded",
    });
  });

  it("keeps mixed-model batches attributed to AI without claiming one model", () => {
    useStore.setState({ segments: [
      { sid: 20, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" },
      { sid: 21, pid: "P01", start: 2, end: 2, code: "tiny text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Luna", status: "candidate" },
    ] });
    useStore.getState().deleteSegmentsBy({ status: "candidate" });
    expect(useStore.getState().ledger[0].source).toBe("ai");
    expect(useStore.getState().ledger[0].model).toBeUndefined();
  });

  // A hand-marked candidate is not a proposal, so a mixed batch records only the
  // proposals in it. Attributing the whole batch to the researcher instead would
  // both credit them with the model's suggestions and hide those discards from
  // the methods paragraph, which counts source "ai" rows.
  it("records only the AI-proposed members of a mixed batch", () => {
    useStore.setState({ segments: [
      { sid: 20, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" },
      { sid: 21, pid: "P01", start: 2, end: 2, code: "tiny text", notes: "",
        proposedBy: "Researcher", status: "candidate" },
    ] });
    expect(useStore.getState().deleteSegmentsBy({ status: "candidate" })).toBe(2);
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "discard-coding", codes: ["small text"], source: "ai", model: "Terra", moved: 1,
    });
  });

  it("writes no row when a cleared batch holds no proposal at all", () => {
    useStore.setState({ segments: [
      { sid: 22, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: "Researcher", status: "candidate" },
    ] });
    expect(useStore.getState().deleteSegmentsBy({ status: "candidate" })).toBe(1);
    expect(useStore.getState().ledger).toHaveLength(0);
  });
});

describe("proposed section decisions", () => {
  beforeEach(reset);

  it("logs every AI section verdict without attributing the model's pitch to the researcher", () => {
    useStore.setState({ stretches: [{ pid: "P01", start: 1, end: 2, dim: "phase", value: "intro",
      status: "candidate", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", why: "opening exchange" }] });
    useStore.getState().setStretchStatus(0, "accepted");
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "accept-section", codes: ["phase: intro"], source: "ai", model: "Terra",
      why: "No reason recorded", moved: 1,
    });
    expect(useStore.getState().stretches[0].why).toBe("opening exchange");
    useStore.getState().setStretchStatus(0, "rejected");
    expect(useStore.getState().ledger.map((d) => d.kind)).toEqual(["accept-section", "reject-section"]);
    expect(useStore.getState().ledger[1].why).toBe("No reason recorded");
  });

  it("does not log status changes on a hand-marked section", () => {
    useStore.setState({ stretches: [{ pid: "P01", start: 1, end: 2, dim: "phase", value: "intro",
      status: "accepted" }] });
    useStore.getState().setStretchStatus(0, "rejected");
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  it("logs one row when all candidates on a transcript are accepted", () => {
    useStore.setState({ stretches: [
      { pid: "P01", start: 1, end: 1, dim: "phase", value: "intro", status: "candidate",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", why: "opening" },
      { pid: "P01", start: 2, end: 2, dim: "phase", value: "task", status: "candidate",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", why: "work begins" },
    ] });
    expect(useStore.getState().acceptSections("P01")).toBe(2);
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "accept-section", codes: ["phase: intro", "phase: task"],
      source: "ai", model: "Terra", moved: 2, why: "No reason recorded",
    });
  });

  it("logs one discard row, not a rejection, when sections are cleared without verdicts", () => {
    useStore.setState({ stretches: [
      { pid: "P01", start: 1, end: 1, dim: "phase", value: "intro", status: "candidate",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" },
      { pid: "P01", start: 2, end: 2, dim: "phase", value: "intro", status: "candidate",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" },
    ] });
    expect(useStore.getState().deleteStretchesBy({ status: "candidate" })).toBe(2);
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "discard-section", codes: ["phase: intro"], source: "ai", model: "Terra", moved: 2,
      why: "No reason recorded",
    });
  });

  // Clearing settled memory is not another verdict. The original row remains
  // the history; inventing a discard here would claim a judgement the button
  // did not ask the researcher to make.
  it("writes no row when a single hand-marked candidate is deleted", () => {
    useStore.setState({ segments: [
      { sid: 23, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: "Researcher", status: "candidate" },
    ] });
    useStore.getState().deleteSegment(23);
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  // the section twin of the coding mixed-batch rule
  it("records only the AI-proposed sections of a mixed cleared batch", () => {
    useStore.setState({ stretches: [
      { pid: "P01", start: 1, end: 1, dim: "phase", value: "intro", status: "candidate",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" },
      { pid: "P01", start: 2, end: 2, dim: "phase", value: "task", status: "candidate",
        proposedBy: "Researcher" },
    ] });
    // the action still reports the full batch to the UI; only the row is subset
    expect(useStore.getState().deleteStretchesBy({ status: "candidate" })).toBe(2);
    expect(useStore.getState().ledger).toHaveLength(1);
    expect(useStore.getState().ledger[0]).toMatchObject({
      kind: "discard-section", codes: ["phase: intro"], source: "ai", model: "Terra", moved: 1,
    });
  });

  it("writes no section row when a cleared batch holds no proposal", () => {
    useStore.setState({ stretches: [
      { pid: "P01", start: 1, end: 1, dim: "phase", value: "intro", status: "candidate",
        proposedBy: "Researcher" },
    ] });
    expect(useStore.getState().deleteStretchesBy({ status: "candidate" })).toBe(1);
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  it("logs nothing when a batch discards sections that were already rejected", () => {
    useStore.setState({ stretches: [
      { pid: "P01", start: 1, end: 1, dim: "phase", value: "intro", status: "rejected",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" },
    ] });
    expect(useStore.getState().deleteStretchesBy({ status: "rejected" })).toBe(1);
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  // Deleting accepted evidence removes it from the current-corpus count, but is
  // not itself a second verdict; the earlier accepted row remains in history.
  it("logs nothing when a batch clears codings that were already accepted", () => {
    useStore.setState({ segments: [
      { sid: 90, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
        proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "accepted" },
    ] });
    expect(useStore.getState().deleteSegmentsBy({ status: "accepted" })).toBe(1);
    expect(useStore.getState().ledger).toHaveLength(0);
  });

  it("undoes and redoes new coding decisions without erasing their rows", () => {
    useStore.setState({ segments: [{ sid: 30, pid: "P01", start: 1, end: 1, code: "small text", notes: "",
      proposedBy: AI_PROPOSED_BY_PREFIX + "Terra", status: "candidate" }] });
    useStore.getState().setStatus(30, "accepted");
    useStore.getState().undo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([true]);
    useStore.getState().redo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([false]);
  });

  it("undoes and redoes new section decisions without erasing their rows", () => {
    useStore.setState({ stretches: [{ pid: "P01", start: 1, end: 2, dim: "phase", value: "intro",
      status: "candidate", proposedBy: AI_PROPOSED_BY_PREFIX + "Terra" }] });
    useStore.getState().setStretchStatus(0, "rejected");
    useStore.getState().undo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([true]);
    useStore.getState().redo();
    expect(useStore.getState().ledger.map((d) => !!d.undone)).toEqual([false]);
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
