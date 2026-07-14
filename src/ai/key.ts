// The API key is deliberately NOT in the zustand store: the store is persisted
// wholesale to localStorage and gets exported/inspected. Default is session-only
// (gone when the tab closes); "remember on this device" is an explicit choice.
const K = "qually-openai-key";

export const getKey = (): string =>
  sessionStorage.getItem(K) || localStorage.getItem(K) || "";

export const isRemembered = () => localStorage.getItem(K) !== null;

export function setKey(key: string, remember: boolean) {
  sessionStorage.removeItem(K);
  localStorage.removeItem(K);
  if (!key) return;
  (remember ? localStorage : sessionStorage).setItem(K, key);
}
