// Speaker-grouped clipboard text: consecutive same-speaker lines merge into one
// group, raw speaker labels, one group per line. Shared by line-selection copy
// (App) and segment copy (SegmentPopover).
export function speakerGroupedText(lines: { speaker: string; text: string }[]): string {
  const groups: { speaker: string; texts: string[] }[] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === l.speaker) last.texts.push(l.text.trim());
    else groups.push({ speaker: l.speaker, texts: [l.text.trim()] });
  }
  return groups.map((g) => `${g.speaker} : ${g.texts.join(" ")}`).join("\n");
}
