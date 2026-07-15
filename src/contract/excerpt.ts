// Excerpt rule v2 (dominant speaker) — CODING-APP-DEV.md W7 item 18, PROVISIONAL.
// MUST stay identical to excerpt_for() in sync_coding.py (mirror in same change).
//
//  - excerpt = lines of the speaker with the most total (trimmed) characters
//    in the range; ties -> the participant (non-R).
//  - if the winning speaker is R, prefix the excerpt once with "[R:] ".
//  - closeCall (report-only warning): a losing speaker held >= 40% of chars.

export interface ExLine {
  text: string;
  speaker: string;
}

export interface ExcerptResult {
  excerpt: string;
  closeCall: boolean;
  speaker: string; // the dominant speaker whose lines the excerpt keeps ("" if empty)
}

const isR = (speaker: string) => speaker.trim().toUpperCase().startsWith("R");

export function excerptOf(lines: ExLine[]): ExcerptResult {
  const chars = new Map<string, number>();
  const order: string[] = [];
  for (const l of lines) {
    const sp = l.speaker.trim();
    if (!chars.has(sp)) { chars.set(sp, 0); order.push(sp); }
    chars.set(sp, chars.get(sp)! + l.text.trim().length);
  }
  if (!order.length) return { excerpt: "", closeCall: false, speaker: "" };

  const total = [...chars.values()].reduce((a, b) => a + b, 0);

  let winner = order[0];
  for (const sp of order) {
    if (chars.get(sp)! > chars.get(winner)!) winner = sp;
    else if (chars.get(sp)! === chars.get(winner)! && isR(winner) && !isR(sp)) winner = sp;
  }

  const body = lines
    .filter((l) => l.speaker.trim() === winner)
    .map((l) => l.text.trim())
    .join(" ");
  const excerpt = isR(winner) ? "[R:] " + body : body;

  let maxLoser = 0;
  for (const sp of order) if (sp !== winner) maxLoser = Math.max(maxLoser, chars.get(sp)!);
  const closeCall = total > 0 && maxLoser / total >= 0.4;

  return { excerpt, closeCall, speaker: winner };
}
