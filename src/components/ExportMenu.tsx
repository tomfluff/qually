// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { zipTextFiles } from "../zip";
import { saveBlob } from "../download";
import { Icon } from "./Icon";

// CSVs get a UTF-8 BOM: without it Excel decodes as the ANSI code page
// (Shift-JIS on Japanese Windows) and every non-ASCII excerpt is mojibake.
// Re-import is safe — File.text() and the header trim both strip it.
export const saveText = (text: string, name: string, type = "text/csv") =>
  saveBlob(new Blob([type === "text/csv" ? "\uFEFF" + text : text], { type }), name);
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
  // A pending export, parked behind the "name this project?" prompt. null = no prompt.
  const [nameGate, setNameGate] = useState<((base: string) => void) | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useStore((s) => s.tabs);
  const hasDefault = useStore((s) => s.segments.some((x) => !x.proposedBy.trim() || x.proposedBy === "(default)"));
  const editCount = useStore((s) => Object.values(s.transcripts)
    .reduce((n, t) => n + t.lines.filter((l) => l.orig !== undefined).length, 0));
  const aiCalls = useStore((s) => s.aiLog.length);
  const decisions = useStore((s) => s.ledger.length);
  const answerCount = useStore((s) => s.answers.length);
  const sectionCount = useStore((s) => s.stretches.length);
  const noticeCount = useStore((s) => Object.values(s.aiFlags)
    .reduce((n, f) => n + f.spans.filter((x) => (x.lens ?? "transcription") !== "transcription").length, 0));
  const eventCount = useStore((s) => s.markers.length);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  // The menu grows an item per thing the researcher has produced, so it is
  // longest exactly when the session is richest — and it ran off the bottom of
  // the screen, taking the last CSVs with it. Cap it to what is left below the
  // trigger and scroll, like .ctxmenu does. Measured rather than a
  // calc(100vh - Npx): the toolbar WRAPS at high zoom, which moves the menu's
  // own top, and a hardcoded offset overflows again exactly there.
  const [cap, setCap] = useState<number>();
  useEffect(() => {
    if (!open) return;
    const fit = () => {
      if (ref.current) setCap(window.innerHeight - ref.current.getBoundingClientRect().bottom - 14);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (!nameGate) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setNameGate(null); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [nameGate]);

  useEffect(() => {
    if (!gate) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setGate(null); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [gate]);

  const s = () => useStore.getState();
  // every exported filename leads with the project's name and today's date;
  // with no name yet, the first transcript stands in (the old behavior)
  const expBase = (name: string) =>
    `${slug(name || tabs[0] || "qually")}-${new Date().toISOString().slice(0, 10)}`;
  // Every export passes through here. A named project exports straight away; an
  // unnamed one asks once — name it (kept, editable in Settings) or skip.
  const withBase = (cb: (base: string) => void) => () => {
    const name = s().projectName.trim();
    if (name) return cb(expBase(name));
    setNameDraft("");
    setNameGate(() => cb);
    setOpen(false);
  };

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

  const doProject = withBase((b) => {
    saveText(s().exportProject(), `${b}.qually.json`, "application/json");
    setOpen(false);
  });

  const doBundle = withBase((b) => gated(() => {
    const st = s();
    // what each entry is, keyed by its name. The README is BUILT from the files
    // that actually made it into the zip, never written by hand: seven of these
    // are conditional, so a hand-written list promised a co-author events.csv
    // and sections.csv in a bundle that contained neither.
    const doc: Record<string, string> = {
      "coded-segments.csv": "your coded segments, with computed excerpts",
      "codebook.csv": "codes: color, definition, status",
      "transcript-edits.csv": "every transcription correction (original vs corrected)",
      "events.csv": "session events and field notes, as loaded (with your edits)",
      "ai-observations.csv": "instances the AI marked for review (not codes)",
      "ai-provenance.csv": "every AI request made: model, lines sent, cost",
      "decisions.csv": "every codebook decision: what, why, whose idea",
      "answers.csv": "every question asked of the material: one row per cited point",
      "sections.csv": "which part of the study each stretch of talk belongs to\n"
        + `${" ".repeat(22)}(blank status = you marked it; otherwise the AI proposed it)`,
    };
    const files = [
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
    if (eventCount) files.push({ name: "events.csv", text: st.exportMarkers() });
    if (noticeCount) files.push({ name: "ai-observations.csv", text: st.exportNotices() });
    if (aiCalls) files.push({ name: "ai-provenance.csv", text: st.exportAiLog() });
    if (st.ledger.length) files.push({ name: "decisions.csv", text: st.exportLedger() });
    if (answerCount) files.push({ name: "answers.csv", text: st.exportAnswers() });
    if (st.stretches.length) files.push({ name: "sections.csv", text: st.exportSections() });
    // the transcripts line last: it is a glob, not one of the named entries,
    // and it is the only one that is always present
    const manifest = [
      ...files.filter((f) => doc[f.name]).map((f) => `${f.name.padEnd(21)} ${doc[f.name]}`),
      `${"transcripts/*.csv".padEnd(21)} one per transcript, with your corrections applied\n`
        + `${" ".repeat(22)}("original" holds the pre-correction text, where edited)`,
    ].join("\n");
    files.unshift({ name: "README.txt", text:
`QuAlly CSV bundle — exported ${new Date().toISOString()}

${manifest}

These CSVs are for pipelines, co-authors, and appendices.
To CONTINUE this work in QuAlly, use the project file (.qually.json) —
it round-trips everything, including corrections and AI observations.
` });
    saveBlob(zipTextFiles(files.map((f) => (f.name.endsWith(".csv") ? { ...f, text: "\uFEFF" + f.text } : f)),
      new Date()), `${b}-csv.zip`);
    setOpen(false);
  })());

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
        <div className="exmenu nicescroll" style={{ maxHeight: cap }}>
          <div className="exsec">Save &amp; continue</div>
          {item("Project (.qually.json)", "Transcripts, corrections, codes, AI observations. Load it to pick up where you left off.", doProject, true)}
          <div className="exsec">Share &amp; publish</div>
          {item("All as CSVs (.zip)", "The whole bundle as spreadsheets, for a pipeline or a co-author.", doBundle)}
          {item("Coded segments (.csv)", "Segments with computed excerpts.", withBase((b) => gated(() => { saveText(s().exportCSV(), `${b}-coded-segments.csv`); setOpen(false); })()))}
          {item("Codebook (.csv)", "Codes with colors, definitions, status.", withBase((b) => { saveText(s().exportCodebook(), `${b}-codebook.csv`); setOpen(false); }))}
          {editCount > 0 && item(`Transcript edits (.csv) · ${editCount}`, "Every correction: original vs corrected.",
            withBase((b) => { saveText(s().exportEdits(), `${b}-transcript-edits.csv`); setOpen(false); }))}
          {eventCount > 0 && item(`Session events (.csv) · ${eventCount}`, "Markers and field notes, with your edits, in the columns you loaded.",
            withBase((b) => { saveText(s().exportMarkers(), `${b}-events.csv`); setOpen(false); }))}
          {noticeCount > 0 && item(`AI observations (.csv) · ${noticeCount}`, "Instances the AI marked for review.",
            withBase((b) => { saveText(s().exportNotices(), `${b}-ai-observations.csv`); setOpen(false); }))}
          {answerCount > 0 && item(`Answers (.csv) · ${answerCount}`, "One row per citation; joins to coded segments on the ref.",
            withBase((b) => { saveText(s().exportAnswers(), `${b}-answers.csv`); setOpen(false); }))}
          {sectionCount > 0 && item(`Sections (.csv) · ${sectionCount}`, "Which part of the study each stretch of talk belongs to.",
            withBase((b) => { saveText(s().exportSections(), `${b}-sections.csv`); setOpen(false); }))}
          {aiCalls > 0 && item(`AI log (.csv) · ${aiCalls}`, "Every AI request: model, lines, cost. Your methods appendix.",
            withBase((b) => { saveText(s().exportAiLog(), `${b}-ai-provenance.csv`); setOpen(false); }))}
          {decisions > 0 && item(`Decisions (.csv) · ${decisions}`, "Every merge, rename and removal: the reason, and whose idea it was.",
            withBase((b) => { saveText(s().exportLedger(), `${b}-decisions.csv`); setOpen(false); }))}
        </div>
      )}
      {nameGate && (
        <div className="about-backdrop" onMouseDown={() => setNameGate(null)}>
          <div className="about imp" role="dialog" aria-modal="true"
            aria-labelledby="namegate-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="namegate-title">Name this project</h2>
              <button className="btn iconbtn" onClick={() => setNameGate(null)} title="Cancel (Esc)">
                <Icon name="x" size={16} />
              </button>
            </div>
            <p className="about-lede">
              The project name leads every exported filename, with today's date —
              like <code>{`${slug(nameDraft || "my-study")}-${new Date().toISOString().slice(0, 10)}-coded-segments.csv`}</code>.
              Set once; change it any time in Settings.
            </p>
            <label className="signfield"><span>Project name</span>
              <input className="signinput" autoFocus value={nameDraft} placeholder="e.g. Voice-UI field study"
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) { s().setProjectName(nameDraft.trim()); nameGate(expBase(nameDraft.trim())); setNameGate(null); } }} />
            </label>
            <div className="imp-actions">
              <button className="btn primary" disabled={!nameDraft.trim()}
                onClick={() => { s().setProjectName(nameDraft.trim()); nameGate(expBase(nameDraft.trim())); setNameGate(null); }}>Save &amp; export</button>
              <button className="btn" onClick={() => { nameGate(expBase("")); setNameGate(null); }}>Skip for now</button>
            </div>
          </div>
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
              Codes you made without a name are signed <code>(default)</code> — set your name to
              sign them, or export as is.
            </p>
            <label className="signfield"><span>Your name</span>
              <input className="signinput" autoFocus value={gateName} placeholder="Your name"
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
