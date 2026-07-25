// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { zipTextFiles } from "../zip";
import { Icon } from "./Icon";

const save = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};
// CSVs get a UTF-8 BOM: without it Excel decodes as the ANSI code page
// (Shift-JIS on Japanese Windows) and every non-ASCII excerpt is mojibake.
// Re-import is safe — File.text() and the header trim both strip it.
export const saveText = (text: string, name: string, type = "text/csv") =>
  save(new Blob([type === "text/csv" ? "\uFEFF" + text : text], { type }), name);
const slug = (s: string) => (s.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "qually");
// ZIP entry names keep the transcript name as-is (the ZIP declares UTF-8 names);
// only characters illegal in filenames are replaced.
const zipName = (s: string) =>
  (s.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+|[.\s]+$/g, "") || "transcript");

// Two different jobs, deliberately not conflated:
//   the PROJECT file is lossless and machine-only — save, back up, continue later;
//   the CSVs are interchange — a pipeline, a co-author, a paper appendix.
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  // A pending export, parked behind the "still signed (default)?" nudge. null = no gate.
  const [gate, setGate] = useState<(() => void) | null>(null);
  const [gateName, setGateName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useStore((s) => s.tabs);
  const hasDefault = useStore((s) => s.segments.some((x) => !x.proposedBy.trim() || x.proposedBy === "(default)"));
  const editCount = useStore((s) => Object.values(s.transcripts)
    .reduce((n, t) => n + t.lines.filter((l) => l.orig !== undefined).length, 0));
  const aiCalls = useStore((s) => s.aiLog.length);
  const noticeCount = useStore((s) => Object.values(s.aiFlags)
    .reduce((n, f) => n + f.spans.filter((x) => (x.lens ?? "transcription") !== "transcription").length, 0));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  useEffect(() => {
    if (!gate) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setGate(null); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [gate]);

  const base = slug(tabs[0] ?? "qually");
  const s = () => useStore.getState();

  // Any export that carries proposed_by passes through here. If some codes are still
  // "(default)", offer to sign them first — but never block: "keep default" ships as-is.
  const gated = (run: () => void) => () => {
    if (!hasDefault) return run();
    setGateName(s().ui.coderName.trim());
    setGate(() => run);
    setOpen(false);
  };
  const signAndRun = () => {
    const name = gateName.trim();
    if (name && name !== "(default)") { s().setUi({ coderName: name }); s().claimUnattributed(); }
    gate?.();
    setGate(null);
  };

  const doProject = () => {
    saveText(s().exportProject(), `${base}.qually.json`, "application/json");
    setOpen(false);
  };

  const doBundle = gated(() => {
    const st = s();
    const files = [
      { name: "README.txt", text:
`QuAlly CSV bundle — exported ${new Date().toISOString()}

coded-segments.csv    your coded segments, with computed excerpts
codebook.csv          codes: color, definition, status
transcripts/*.csv     one per transcript, with your corrections applied
                      ("original" holds the pre-correction text, where edited)
transcript-edits.csv  every transcription correction (original vs corrected)
ai-observations.csv   instances the AI marked for review (not codes)
ai-provenance.csv     every AI request made: model, lines sent, cost

These CSVs are for pipelines, co-authors, and appendices.
To CONTINUE this work in QuAlly, use the project file (.qually.json) —
it round-trips everything, including corrections and AI marks.
` },
      { name: "coded-segments.csv", text: st.exportCSV() },
      { name: "codebook.csv", text: st.exportCodebook() },
      // every LOADED transcript, not just open tabs — coded-segments.csv already
      // includes a closed tab's segments, so the bundle must carry its transcript too
      ...Object.keys(st.transcripts).map((pid) => ({ name: `transcripts/${zipName(pid)}.csv`, text: st.exportTranscript(pid) })),
    ];
    // distinct pids can still sanitize to the same entry name — suffix like uniquePid
    // does on import, or extraction silently overwrites one transcript with another
    const seen = new Set<string>();
    for (const f of files) {
      for (let n = 2; seen.has(f.name); n++) f.name = f.name.replace(/( \(\d+\))?\.csv$/, ` (${n}).csv`);
      seen.add(f.name);
    }
    if (editCount) files.push({ name: "transcript-edits.csv", text: st.exportEdits() });
    if (noticeCount) files.push({ name: "ai-observations.csv", text: st.exportNotices() });
    if (aiCalls) files.push({ name: "ai-provenance.csv", text: st.exportAiLog() });
    save(zipTextFiles(files.map((f) => (f.name.endsWith(".csv") ? { ...f, text: "\uFEFF" + f.text } : f)),
      new Date()), `${base}-csv.zip`);
    setOpen(false);
  });

  const item = (label: string, hint: string, onClick: () => void, primary = false) => (
    <button className={"exitem" + (primary ? " pri" : "")} onClick={onClick}>
      <span className="exlabel">{label}</span>
      <span className="exhint">{hint}</span>
    </button>
  );

  return (
    <div className="settings-wrap" ref={ref}>
      <button className="btn iconlabel" aria-expanded={open} aria-haspopup="true"
        onClick={() => setOpen((o) => !o)} title="Export">
        <Icon name="download" size={16} /> Export
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="exmenu">
          <div className="exsec">Save &amp; continue</div>
          {item("Project (.qually.json)", "Everything — transcripts, corrections, codes, AI marks. Load this to pick up where you left off.", doProject, true)}
          <div className="exsec">Share &amp; publish</div>
          {item("All as CSVs (.zip)", "The whole bundle as spreadsheets, for a pipeline or a co-author.", doBundle)}
          {item("Coded segments (.csv)", "Segments with computed excerpts.", gated(() => { saveText(s().exportCSV(), "coded-segments.csv"); setOpen(false); }))}
          {item("Codebook (.csv)", "Codes with colors, definitions, status.", () => { saveText(s().exportCodebook(), "codebook.csv"); setOpen(false); })}
          {editCount > 0 && item(`Transcript edits (.csv) · ${editCount}`, "Every correction: original vs corrected.",
            () => { saveText(s().exportEdits(), "transcript-edits.csv"); setOpen(false); })}
          {noticeCount > 0 && item(`AI observations (.csv) · ${noticeCount}`, "Instances the AI marked for review.",
            () => { saveText(s().exportNotices(), "ai-observations.csv"); setOpen(false); })}
          {aiCalls > 0 && item(`AI log (.csv) · ${aiCalls}`, "Every AI request: model, lines, cost — your methods appendix.",
            () => { saveText(s().exportAiLog(), "ai-provenance.csv"); setOpen(false); })}
        </div>
      )}
      {gate && (
        <div className="about-backdrop" onMouseDown={() => setGate(null)}>
          <div className="about imp" role="dialog" aria-modal="true"
            aria-labelledby="signgate-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="signgate-title">Some codes aren't signed</h2>
              <button className="btn iconbtn" onClick={() => setGate(null)} title="Cancel (Esc)">
                <Icon name="x" size={16} />
              </button>
            </div>
            <p className="about-lede">
              Codes you made without a name are signed <code>(default)</code>. Sign them as yourself
              before exporting, or ship them as <code>(default)</code>.
            </p>
            <label className="signfield"><span>Your name</span>
              <input className="signinput" autoFocus value={gateName} placeholder="your name"
                onChange={(e) => setGateName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && gateName.trim()) signAndRun(); }} />
            </label>
            <div className="imp-actions">
              <button className="btn primary" disabled={!gateName.trim() || gateName.trim() === "(default)"}
                onClick={signAndRun}>Sign &amp; export</button>
              <button className="btn" onClick={() => { gate?.(); setGate(null); }}>Keep (default) &amp; export</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
