// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Map-side store rules from the review pass: survivor policy, re-layout
// history integrity, rename-to-empty semantics.
import { beforeAll, test, expect } from "vitest";

let useStore: typeof import("./state/store").useStore;
let bestSurvivor: typeof import("./state/store").bestSurvivor;

beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => { for (const k in mem) delete mem[k]; },
    key: () => null, length: 0,
  } as Storage;
  ({ useStore, bestSurvivor } = await import("./state/store"));
  await useStore.getState().importFiles([new File([
    `line_id,timestamp,speaker,text,codes
1,00:00:01,P,one,alpha
2,00:00:02,P,two,beta
3,00:00:03,P,three,alpha
4,00:00:04,P,four,gamma`,
  ], "P01.csv", { type: "text/csv" })]);
});

test("bestSurvivor picks the most-evidenced member, stable on ties", () => {
  const s = useStore.getState();
  expect(bestSurvivor(s, ["beta", "alpha"])).toBe("alpha");   // alpha: 2 accepted
  expect(bestSurvivor(s, ["beta", "gamma"])).toBe("beta");    // tie -> first listed
});

// The trap behind the map's plan strip: applying one proposal rewrites the
// OTHER entries, so anything holding captured references (an "Accept all"
// loop) must key by code, never by object identity.
test("renameCode replaces every codePlan entry object, not just the renamed one", () => {
  const st = useStore.getState();
  st.setCodePlan([
    { code: "alpha", action: "rename", newName: "alpha renamed", rationale: "" },
    { code: "beta", action: "rename", newName: "beta renamed", rationale: "" },
  ]);
  const before = useStore.getState().codePlan;
  st.renameCode("alpha", "alpha renamed");
  const after = useStore.getState().codePlan;
  expect(after.some((x) => x === before[1])).toBe(false); // identity gone
  expect(after.find((x) => x.code === "beta")?.newName).toBe("beta renamed"); // code survives
  st.setCodePlan([]);
  useStore.getState().renameCode("alpha renamed", "alpha"); // put the fixture back
});

test("a cluster with no valid survivor gets the evidence-based one", () => {
  const st = useStore.getState();
  st.setCodeClusters([{ survivor: "ghost", codes: ["beta", "alpha"], rationale: "" }]);
  expect(useStore.getState().codeClusters[0].survivor).toBe("alpha");
  st.setCodeClusters([]);
});

test("a valid survivor holds through a non-structural edit (halo rename, glimpse)", () => {
  const st = useStore.getState();
  st.setCodeClusters([{ survivor: "beta", codes: ["beta", "alpha"], rationale: "" }]);
  // renaming the halo re-enters the whole list; the merge direction must not flip
  const cur = useStore.getState().codeClusters;
  st.setCodeClusters(cur.map((c) => ({ ...c, newName: "merged name" })));
  expect(useStore.getState().codeClusters[0].survivor).toBe("beta");
  st.setCodeClusters([]);
});

test("reconcileDrop leaves OTHER clusters' survivors alone", () => {
  const st = useStore.getState();
  st.setCodeClusters([
    { survivor: "beta", codes: ["beta", "alpha"], rationale: "" },   // deliberate: beta despite less evidence
    { survivor: "gamma", codes: ["gamma", "alpha"], rationale: "" }, // (alpha lands in the first; see below)
  ]);
  const before = useStore.getState().codeClusters;
  expect(before[0].survivor).toBe("beta");
  // drop an unrelated code out of nothing: the untouched cluster keeps its direction
  st.reconcileDrop("gamma", { x: 1, y: 1 }, null);
  expect(useStore.getState().codeClusters[0].survivor).toBe("beta");
  st.setCodeClusters([]);
  st.resetMapLayout("reconcile"); // the drop parked a position; leave the map packed
});

test("a preferred survivor wins when it is a member — merge direction is deliberate", () => {
  const s = useStore.getState();
  expect(bestSurvivor(s, ["beta", "alpha"], "beta")).toBe("beta");   // valid preference holds
  expect(bestSurvivor(s, ["beta", "alpha"], "ghost")).toBe("alpha"); // invalid -> evidence policy
});

test("applyReconcilePlan keeps the sanitizer's chosen survivor (focus merge direction)", () => {
  const st = useStore.getState();
  // beta has less evidence than alpha, but the plan deliberately folds alpha INTO beta
  st.applyReconcilePlan([{ survivor: "beta", codes: ["beta", "alpha"], rationale: "" }], [], false);
  expect(useStore.getState().codeClusters[0].survivor).toBe("beta");
  st.setCodeClusters([]);
});

test("normalizeClusters (load path): dead members drop, thin clusters drop, valid survivor persists", async () => {
  const { normalizeClusters } = await import("./state/store");
  const s = useStore.getState();
  const out = normalizeClusters(s, [
    { survivor: "beta", codes: ["beta", "alpha", "vanished"], rationale: "" }, // dead member filtered, survivor kept
    { survivor: "gamma", codes: ["gamma", "vanished"], rationale: "" },        // thin after filter -> drops
    { survivor: "vanished", codes: ["beta", "alpha"], rationale: "" },         // dead survivor -> evidence policy
  ]);
  expect(out).toHaveLength(2);
  expect(out[0].codes).toEqual(["beta", "alpha"]);
  expect(out[0].survivor).toBe("beta");
  expect(out[1].survivor).toBe("alpha");
});

test("resetMapLayout: no-op on packed map, one undo entry otherwise", () => {
  const st = useStore.getState();
  st.setCodePlan([]); // isolate history around the calls below
  const depth0 = useStore.getState().undoStack.length;
  st.resetMapLayout("reconcile"); // nothing placed -> no entry
  expect(useStore.getState().undoStack.length).toBe(depth0);
  st.recordMapPosition("alpha", { x: 5, y: 7 }, false, "reconcile");
  const depth1 = useStore.getState().undoStack.length;
  st.resetMapLayout("reconcile");
  expect(useStore.getState().undoStack.length).toBe(depth1 + 1);
  expect(Object.keys(useStore.getState().mapPositions.reconcile)).toHaveLength(0);
  useStore.getState().undo();
  expect(useStore.getState().mapPositions.reconcile.alpha).toEqual({ x: 5, y: 7 });
});

// The casing sweep touches every code-keyed table; a rename that forgets one
// of them silently throws away work the researcher did by hand.
test("normalizeCodeCase carries map placements, glimpse membership and the plan", () => {
  const st = useStore.getState();
  st.recordMapPosition("alpha", { x: 11, y: 22 }, false, "reconcile");
  st.setCodeClusters([{ survivor: "alpha", codes: ["alpha", "beta"], rationale: "",
    desc: "a glimpse", descCodes: ["alpha", "beta"] }]);
  st.setCodePlan([{ code: "gamma", action: "rename", newName: "gamma clearer", rationale: "" }]);
  st.normalizeCodeCase("capital");
  const s = useStore.getState();
  expect(Object.keys(s.codebook).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(s.mapPositions.reconcile.Alpha).toEqual({ x: 11, y: 22 });   // layout followed the rename
  expect(s.mapPositions.reconcile.alpha).toBeUndefined();
  expect(s.codeClusters[0].codes).toEqual(["Alpha", "Beta"]);
  expect(s.codeClusters[0].descCodes).toEqual(["Alpha", "Beta"]); // same members: NOT stale
  expect(s.codePlan[0].code).toBe("Gamma");
  useStore.getState().undo();
  expect(Object.keys(useStore.getState().codebook).sort()).toEqual(["alpha", "beta", "gamma"]);
  const back = useStore.getState();
  back.setCodeClusters([]); back.setCodePlan([]); back.resetMapLayout("reconcile");
});

test("normalizeCodeCase on an already-conforming book is a no-op with no history entry", () => {
  const st = useStore.getState();
  const depth = useStore.getState().undoStack.length;
  st.normalizeCodeCase("lower");
  expect(useStore.getState().undoStack.length).toBe(depth);
});

// React Flow reports a multi-selection drag ONCE, with the whole set. Filing
// only the grabbed node is what made every other selected code snap back.
test("applyMapDrop files every dragged code: positions and membership, one entry", () => {
  const st = useStore.getState();
  st.setCodeClusters([{ survivor: "beta", codes: ["beta", "gamma"], rationale: "" }]);
  const depth = useStore.getState().undoStack.length;
  useStore.getState().applyMapDrop({
    stage: "reconcile",
    chips: { alpha: { x: 10, y: 20 }, beta: { x: 30, y: 40 } },
    islands: { "halo:0": { x: 5, y: 6 } },
    reconcile: [
      { code: "alpha", ci: 0 },   // joins the cluster
      { code: "gamma", ci: null }, // leaves it
    ],
  });
  const s = useStore.getState();
  expect(s.undoStack.length).toBe(depth + 1);           // ONE entry for the gesture
  expect(s.mapPositions.reconcile.alpha).toEqual({ x: 10, y: 20 }); // every position kept
  expect(s.mapPositions.reconcile.beta).toEqual({ x: 30, y: 40 });
  expect(s.mapIslandPos.reconcile["halo:0"]).toEqual({ x: 5, y: 6 });
  expect([...s.codeClusters[0].codes].sort()).toEqual(["alpha", "beta"]);
  s.undo();
  expect(useStore.getState().mapPositions.reconcile.alpha).toBeUndefined();
  useStore.getState().setCodeClusters([]);
  useStore.getState().resetMapLayout("reconcile");
});

test("applyMapDrop moving codes between theme islands keeps one entry and lets the packer refile", () => {
  const st = useStore.getState();
  st.setCodeGroups([{ name: "One", codes: ["alpha", "beta"] }, { name: "Two", codes: ["gamma"] }]);
  st.recordMapPosition("alpha", { x: 99, y: 99 }, false, "reconcile");
  const depth = useStore.getState().undoStack.length;
  useStore.getState().applyMapDrop({
    stage: "reconcile",
    chips: { alpha: { x: 1, y: 1 } },
    themes: [{ code: "alpha", gi: 1 }],   // alpha moves to island Two
  });
  const s = useStore.getState();
  expect(s.undoStack.length).toBe(depth + 1);
  expect(s.codeGroups[1].codes).toContain("alpha");
  expect(s.codeGroups[0].codes).not.toContain("alpha");
  // a code that changed island is filed by the packer, not left at a stale spot
  expect(s.mapPositions.reconcile.alpha).toBeUndefined();
  useStore.getState().setCodeGroups([]);
});

// The AI areas view costs a request, so it lives in the project: it survives a
// reload, and the codebook moving under it must not silently lose codes.
test("AI areas: a rename carries the code, a delete drops it, a new code lands unassigned", () => {
  const st = useStore.getState();
  st.setCodeAreas([{ name: "Strategies", codes: ["alpha", "beta"] }], "alpha\nbeta\ngamma");
  expect(useStore.getState().codeAreas[0].codes).toEqual(["alpha", "beta"]);

  // renamed: the same code under a new label keeps its shelf
  useStore.getState().renameCode("alpha", "alpha renamed");
  expect(useStore.getState().codeAreas[0].codes).toEqual(["alpha renamed", "beta"]);

  // deleted: it leaves, and an area emptied by that drops entirely
  useStore.getState().deleteCode("beta");
  expect(useStore.getState().codeAreas[0].codes).toEqual(["alpha renamed"]);

  // a code the areas never saw is simply absent — the map files it as
  // "Unassigned" rather than the store inventing a home for it
  expect(useStore.getState().codeAreas.flatMap((a) => a.codes)).not.toContain("gamma");

  // the signature is what tells the map the book has moved on
  expect(useStore.getState().codeAreasFp).toBe("alpha\nbeta\ngamma");
  useStore.getState().setCodeAreas([], "");
});

test("AI areas ride the undo stack and the project file", async () => {
  const { parseProject } = await import("./project");
  const st = useStore.getState();
  const depth = useStore.getState().undoStack.length;
  st.setCodeAreas([{ name: "Opinions", codes: ["gamma"] }], "sig");
  expect(useStore.getState().undoStack.length).toBe(depth + 1);
  // a save/open round trip must not lose the AI pass
  const round = parseProject(useStore.getState().exportProject());
  expect(round.codeAreas).toEqual([{ name: "Opinions", codes: ["gamma"] }]);
  expect(round.codeAreasFp).toBe("sig");
  useStore.getState().undo();
  expect(useStore.getState().codeAreas).toEqual([]);
});

test("a drop in the areas view files the code, and out of every area means Unassigned", () => {
  const st = useStore.getState();
  st.setCodeAreas([
    { name: "Strategies", codes: ["alpha"] },
    { name: "Opinions", codes: ["beta", "gamma"] },
  ], "sig");
  const depth = useStore.getState().undoStack.length;
  // dropped on the first pile: it joins, and leaves the one it was in
  useStore.getState().applyMapDrop({ stage: "reconcile", areas: [{ code: "beta", ai: 0 }] });
  let s = useStore.getState();
  expect(s.undoStack.length).toBe(depth + 1);          // one entry per gesture
  expect(s.codeAreas[0].codes).toEqual(["alpha", "beta"]);
  expect(s.codeAreas[1].codes).toEqual(["gamma"]);
  // dropped in open space: out of every area, so the map files it Unassigned
  useStore.getState().applyMapDrop({ stage: "reconcile", areas: [{ code: "beta", ai: -1 }] });
  s = useStore.getState();
  expect(s.codeAreas.flatMap((a) => a.codes)).not.toContain("beta");
  // an area emptied by the move disappears rather than lingering
  useStore.getState().applyMapDrop({ stage: "reconcile", areas: [{ code: "gamma", ai: 0 }] });
  expect(useStore.getState().codeAreas.map((a) => a.name)).toEqual(["Strategies"]);
  useStore.getState().setCodeAreas([], "");
});

test("filing a code into an area forgets where it was dropped, so the view repacks it", () => {
  const st = useStore.getState();
  st.setCodeAreas([{ name: "Strategies", codes: ["alpha"] }], "sig");
  st.recordMapPosition("beta", { x: 500, y: 500 }, false, "reconcile");
  useStore.getState().applyMapDrop({ stage: "reconcile", chips: { beta: { x: 7, y: 7 } }, areas: [{ code: "beta", ai: 0 }] });
  expect(useStore.getState().mapPositions.reconcile.beta).toBeUndefined();
  useStore.getState().setCodeAreas([], "");
  useStore.getState().resetMapLayout("reconcile");
});

// Reconcile and Themes show different structures, so they are different pieces
// of work: laying one out must never disturb the other.
test("the two stages keep separate layouts", () => {
  const st = useStore.getState();
  st.recordMapPosition("alpha", { x: 10, y: 10 }, false, "reconcile");
  st.recordMapPosition("alpha", { x: 90, y: 90 }, false, "themes");
  st.recordMapPosition("halo:0", { x: 5, y: 5 }, true, "reconcile");
  st.recordMapPosition("island:0", { x: 50, y: 50 }, true, "themes");

  // resetting one stage leaves the other exactly as it was
  useStore.getState().resetMapLayout("reconcile");
  let s = useStore.getState();
  expect(s.mapPositions.reconcile).toEqual({});
  expect(s.mapIslandPos.reconcile).toEqual({});
  expect(s.mapPositions.themes.alpha).toEqual({ x: 90, y: 90 });
  expect(s.mapIslandPos.themes["island:0"]).toEqual({ x: 50, y: 50 });

  // and a tidy-up in one stage writes only into that stage
  useStore.getState().applyMapLayout({ alpha: { x: 1, y: 2 } }, {}, 1, "reconcile");
  s = useStore.getState();
  expect(s.mapPositions.reconcile.alpha).toEqual({ x: 1, y: 2 });
  expect(s.mapPositions.themes.alpha).toEqual({ x: 90, y: 90 });

  useStore.getState().resetMapLayout("reconcile");
  useStore.getState().resetMapLayout("themes");
});
