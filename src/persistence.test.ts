// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("opens autosave after an empty IndexedDB read even when legacy storage is blocked", async () => {
  vi.useFakeTimers();
  const writes: { key: IDBValidKey; value: unknown }[] = [];

  const db = {
    transaction: () => {
      // forward declaration: `store` below closes over it, so it cannot be const
      // eslint-disable-next-line prefer-const
      let tx: { objectStore: () => typeof store; oncomplete?: () => void; onerror?: () => void; error: null };
      const store = {
        get: () => {
          const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
          queueMicrotask(() => { request.result = undefined; request.onsuccess?.(); });
          return request;
        },
        put: (value: unknown, key: IDBValidKey) => {
          writes.push({ key, value });
          queueMicrotask(() => tx.oncomplete?.());
        },
      };
      tx = { objectStore: () => store, error: null };
      return tx;
    },
  };
  const factory = {
    open: () => {
      const request: { result?: typeof db; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
      return request;
    },
  };
  vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new DOMException("blocked", "SecurityError"); },
    setItem: () => { throw new DOMException("blocked", "SecurityError"); },
    removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
  });
  vi.resetModules();

  const { markHydrated, projectStorage, setOnSaveResult } = await import("./state/persistence");
  const saveResults: boolean[] = [];
  setOnSaveResult((ok) => saveResults.push(ok));

  await expect(projectStorage.getItem("coding-store")).resolves.toBeNull();
  markHydrated();
  projectStorage.setItem("coding-store", { state: { active: "browse" }, version: 4 });
  await vi.advanceTimersByTimeAsync(500);

  expect(writes).toEqual([{
    key: "coding-store", value: { state: { active: "browse" }, version: 4 },
  }]);
  expect(saveResults).toEqual([true]);
});
