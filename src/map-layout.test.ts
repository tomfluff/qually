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

test("every cluster entering the store gets the evidence-based survivor", () => {
  const st = useStore.getState();
  st.setCodeClusters([{ survivor: "beta", codes: ["beta", "alpha"], rationale: "" }]);
  expect(useStore.getState().codeClusters[0].survivor).toBe("alpha");
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
  st.resetMapLayout(); // nothing placed -> no entry
  expect(useStore.getState().undoStack.length).toBe(depth0);
  st.recordMapPosition("alpha", { x: 5, y: 7 });
  const depth1 = useStore.getState().undoStack.length;
  st.resetMapLayout();
  expect(useStore.getState().undoStack.length).toBe(depth1 + 1);
  expect(Object.keys(useStore.getState().mapPositions)).toHaveLength(0);
  useStore.getState().undo();
  expect(useStore.getState().mapPositions.alpha).toEqual({ x: 5, y: 7 });
});
