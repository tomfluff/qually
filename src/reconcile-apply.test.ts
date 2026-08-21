// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The reconciliation verdicts run through store actions; rejectCode is the
// "remove" disposition — data stays, the code goes quiet, one undo step.
import { beforeAll, test, expect } from "vitest";

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
1,00:00:03,P,I kept losing the tick marks,magnification
2,00:00:09,P,so I zoomed in further,magnification
3,00:00:12,P,and the labels vanished,labels`,
  ], "P01.csv", { type: "text/csv" })]);
});

test("rejectCode rejects every accepted segment, keeps the data, undoes in one step", () => {
  const st = useStore.getState();
  const before = st.segments.filter((x) => x.code === "magnification");
  expect(before.length).toBeGreaterThanOrEqual(1);
  st.rejectCode("magnification");
  const after = useStore.getState().segments.filter((x) => x.code === "magnification");
  expect(after.length).toBe(before.length);                 // nothing deleted
  expect(after.every((x) => x.status === "rejected")).toBe(true);
  expect(useStore.getState().segments.some((x) => x.code === "labels" && x.status === "accepted")).toBe(true);
  useStore.getState().undo();
  expect(useStore.getState().segments.filter((x) => x.code === "magnification")
    .every((x) => x.status === "accepted")).toBe(true);     // one undo restores all
});
