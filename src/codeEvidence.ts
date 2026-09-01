// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import type { MergeCodeInput } from "./ai/dedupe";
import { segExcerpt } from "./contract/excerpt";
import type { Line, Segment } from "./state/store";

type EvidenceCodebook = Record<string, { def: string; parked?: boolean }>;
type EvidenceTranscripts = Record<string, { lines: Line[] }>;

// This is the privacy boundary shared by codebook-wide AI requests: a code set
// aside by the researcher must never ride along merely because its evidence is
// still retained in the project.
export function gatherCodeEvidence(
  segments: Segment[],
  transcripts: EvidenceTranscripts,
  codebook: EvidenceCodebook,
  exemplarCap: number,
  only: ReadonlySet<string> | null = null,
  includeEmpty = false,
): MergeCodeInput[] {
  const byCode = new Map<string, string[]>();
  for (const segment of segments) {
    if (segment.status !== "accepted" || !transcripts[segment.pid]) continue;
    if (codebook[segment.code]?.parked) continue;
    if (only && !only.has(segment.code)) continue;
    const excerpts = byCode.get(segment.code) ?? [];
    if (excerpts.length >= exemplarCap) continue;
    const excerpt = segExcerpt(segment, transcripts[segment.pid].lines).excerpt;
    if (excerpt) {
      excerpts.push(excerpt);
      byCode.set(segment.code, excerpts);
    }
  }
  const names = includeEmpty && only
    ? [...only].filter((name) => Object.hasOwn(codebook, name) && !codebook[name].parked)
    : [...byCode.keys()];
  return names.map((name) => ({
    name,
    def: codebook[name]?.def ?? "",
    excerpts: byCode.get(name) ?? [],
  }));
}
