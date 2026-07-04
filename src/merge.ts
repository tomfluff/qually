import type { Line } from "./state/store";

// A display unit: one or more consecutive same-speaker lines where each but the
// last is "partial" (doesn't end in a terminator). Data stays per-line — a Group
// is only a view over lines [startId..endId].
export interface Group {
  ids: number[];
  lines: Line[];
  startId: number;
  endId: number;
  speaker: string;
  ts: string;
}

// ends with . ? ! … (optionally trailing quotes/brackets) -> a complete line
const TERMINATED = /[.?!…]['")\]]*$/;
const isPartial = (text: string) => !TERMINATED.test(text.trim());

export function mergeGroups(lines: Line[], enabled: boolean): Group[] {
  const groups: Group[] = [];
  const push = (ls: Line[]) => groups.push({
    ids: ls.map((l) => l.id), lines: ls,
    startId: ls[0].id, endId: ls[ls.length - 1].id,
    speaker: ls[0].speaker, ts: ls[0].ts,
  });
  if (!enabled) { for (const l of lines) push([l]); return groups; }
  let run: Line[] = [];
  for (const l of lines) {
    if (run.length) {
      const prev = run[run.length - 1];
      if (prev.speaker.trim() === l.speaker.trim() && isPartial(prev.text)) { run.push(l); continue; }
      push(run); run = [];
    }
    run.push(l);
  }
  if (run.length) push(run);
  return groups;
}
