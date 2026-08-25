// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { announce } from "../announce";
import { SORTS, type SortBy } from "../codeStats";

export function CodeSortChip({ value, onChange }: {
  value: SortBy;
  onChange: (value: SortBy) => void;
}) {
  // Rehydration normalizes this value, but rendering stays safe if malformed
  // state reaches the component before that repair completes.
  const index = Math.max(0, SORTS.findIndex((sort) => sort.id === value));
  const current = SORTS[index];
  const next = SORTS[(index + 1) % SORTS.length];
  return (
    <button className="sortchip"
      onClick={() => { onChange(next.id); announce(`Sorted by ${next.label}`); }}
      title={`Sorted by ${current.label} — switch to ${next.label}`}
      aria-label={`Sorted by ${current.label}. Switch to ${next.label}.`}>
      {current.label}
    </button>
  );
}
