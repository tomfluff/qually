// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { beforeAll, test, expect } from "vitest";
let useStore: typeof import("./state/store").useStore;
let failing = false;
beforeAll(async () => {
  const mem: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { if (failing) throw new DOMException("quota", "QuotaExceededError"); mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => {}, key: () => null, length: 0,
  };
  ({ useStore } = await import("./state/store"));
});
test("a failing persist write raises saveFailed; recovery clears it", async () => {
  failing = true;
  useStore.getState().setUi({ fontSize: 20 }); // any persisted change
  await new Promise((r) => setTimeout(r));      // flush microtasks
  expect(useStore.getState().saveFailed).toBe(true);
  failing = false;
  useStore.getState().setUi({ fontSize: 21 });
  await new Promise((r) => setTimeout(r));
  expect(useStore.getState().saveFailed).toBe(false);
});
