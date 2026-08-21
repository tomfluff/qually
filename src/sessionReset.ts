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

export function projectSwapped(): void {
  for (const fn of listeners) fn();
}
