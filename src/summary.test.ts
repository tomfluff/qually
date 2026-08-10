// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { describe, expect, it } from "vitest";
import { renderSummaryPayload, estimateSummaryTokens } from "./ai/summarize";
import { redactor } from "./ai/redact";
import { parseProject, FORMAT, VERSION } from "./project";

const none = redactor([]);

describe("renderSummaryPayload — exactly what the consent modal shows", () => {
  const events = [
    { time: "01:20", type: "MAKE_PROGRESS", text: "leans in, counts gridlines" },
    { time: "03:05", type: "custom", text: "" },
  ];
  const excerpts = [
    { code: "confusion", ref: "P01:12-14", excerpt: "wait, which axis is this" },
  ];

  it("renders both sections with times, types, codes and refs", () => {
    const p = renderSummaryPayload(events, excerpts, "", none);
    expect(p).toContain("SESSION EVENTS:\n[01:20] MAKE_PROGRESS — leans in, counts gridlines");
    expect(p).toContain("[03:05] custom"); // no text -> no dangling dash
    expect(p).not.toContain("custom —");
    expect(p).toContain('CODED EXCERPTS:\n- confusion (P01:12-14): "wait, which axis is this"');
    expect(p).not.toContain("RESEARCHER CONTEXT");
  });

  it("omits an empty section entirely — no bare heading to riff on", () => {
    expect(renderSummaryPayload([], excerpts, "", none)).not.toContain("SESSION EVENTS");
    expect(renderSummaryPayload(events, [], "", none)).not.toContain("CODED EXCERPTS");
  });

  it("carries the researcher context when given", () => {
    const p = renderSummaryPayload([], excerpts, "third session, chart reading task", none);
    expect(p).toContain("RESEARCHER CONTEXT:\nthird session, chart reading task");
  });

  it("redacts event text, excerpts and context, but not code names or types", () => {
    const r = redactor(["Alice"]);
    const p = renderSummaryPayload(
      [{ time: "00:10", type: "note", text: "Alice sighs" }],
      [{ code: "about-Alice", ref: "P01:1", excerpt: "Alice said no" }],
      "Alice is the second participant", r);
    expect(p).not.toContain("Alice sighs");
    expect(p).not.toContain("Alice said no");
    expect(p).not.toContain("Alice is the second");
    // the code NAME is the researcher's own label — sent as written
    expect(p).toContain("about-Alice");
  });

  it("estimates more tokens than the empty payload", () => {
    expect(estimateSummaryTokens(events, excerpts, "", none))
      .toBeGreaterThan(estimateSummaryTokens([], [], "", none));
  });
});

describe("project file — summaries round-trip", () => {
  const base = {
    format: FORMAT, version: VERSION, savedAt: "2026-08-10",
    transcripts: { P01: { lines: [] } }, segments: [], codebook: {},
  };

  it("keeps summaries when present", () => {
    const p = parseProject(JSON.stringify({ ...base, summaries: { P01: "a good session" } }));
    expect(p.summaries).toEqual({ P01: "a good session" });
  });

  it("defaults to none for files written before summaries existed", () => {
    expect(parseProject(JSON.stringify(base)).summaries).toEqual({});
  });
});
