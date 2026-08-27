// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Speaker-grouped clipboard text: consecutive same-speaker lines merge into one
// group, raw speaker labels, one group per line. Shared by line-selection copy
// (App) and segment copy (SegmentPopover).
export function speakerGroups(lines: { speaker: string; text: string }[]): { speaker: string; text: string }[] {
  const groups: { speaker: string; text: string }[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === l.speaker) last.text += " " + l.text.trim();
    else groups.push({ speaker: l.speaker, text: l.text.trim() });
  }
  return groups;
}

export function speakerGroupedText(lines: { speaker: string; text: string }[]): string {
  return speakerGroups(lines).map((g) => `${g.speaker} : ${g.text}`).join("\n");
}
