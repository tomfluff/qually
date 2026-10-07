// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Session view state that views keep in module scope (map placements under a
// lens, remembered panels) is keyed by code and group NAMES, which the next
// project reuses with different meanings. Views register a forget-me here and
// the store's load paths fire it — no view import in the store, which would
// drag the DOM into every headless test.
const listeners = new Set<() => void>();

export function onProjectSwap(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Which project the store holds, as a count of swaps: async work (a file still
// being read) checks it before writing, so a project opened, switched to or
// started in the meantime never receives what was meant for the last one.
let generation = 0;
export const projectGeneration = () => generation;

export function projectSwapped(): void {
  generation++;
  for (const fn of listeners) fn();
}
