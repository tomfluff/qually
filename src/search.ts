// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Case-insensitive substring occurrences in a line: [start, end) char offsets.
export function findMatches(text: string, query: string): [number, number][] {
  if (!query) return [];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  let i = 0;
  while ((i = lower.indexOf(q, i)) !== -1) { out.push([i, i + q.length]); i += q.length; }
  return out;
}
