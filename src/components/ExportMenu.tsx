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
const saveText = (text: string, name: string, type = "text/csv") => save(new Blob([text], { type }), name);
const slug = (s: string) => (s.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "qually");

// Two different jobs, deliberately not conflated:
//   the PROJECT file is lossless and machine-only — save, back up, continue later;
//   the CSVs are interchange — a pipeline, a co-author, a paper appendix.
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useStore((s) => s.tabs);
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

  const base = slug(tabs[0] ?? "qually");
  const s = () => useStore.getState();

  const doProject = () => {
    saveText(s().exportProject(), `${base}.qually.json`, "application/json");
    setOpen(false);
  };

  const doBundle = () => {
    const st = s();
    const files = [
      { name: "README.txt", text:
`QuAlly CSV bundle — exported ${new Date().toISOString()}

coded-segments.csv    your coded segments, with computed excerpts
codebook.csv          codes: color, definition, status
transcripts/*.csv     one per transcript, with your corrections applied
                      ("original" holds the pre-correction text, where edited)
transcript-edits.csv  every transcription correction (original vs corrected)
ai-noticings.csv      instances the AI marked for review (not codes)
ai-provenance.csv     every AI request made: model, lines sent, cost

These CSVs are for pipelines, co-authors, and appendices.
To CONTINUE this work in QuAlly, use the project file (.qually.json) —
it round-trips everything, including corrections and AI marks.
` },
      { name: "coded-segments.csv", text: st.exportCSV() },
      { name: "codebook.csv", text: st.exportCodebook() },
      ...st.tabs.map((pid) => ({ name: `transcripts/${slug(pid)}.csv`, text: st.exportTranscript(pid) })),
    ];
    if (editCount) files.push({ name: "transcript-edits.csv", text: st.exportEdits() });
    if (noticeCount) files.push({ name: "ai-noticings.csv", text: st.exportNotices() });
    if (aiCalls) files.push({ name: "ai-provenance.csv", text: st.exportAiLog() });
    save(zipTextFiles(files, new Date()), `${base}-csv.zip`);
    setOpen(false);
  };

  const item = (label: string, hint: string, onClick: () => void, primary = false) => (
    <button className={"exitem" + (primary ? " pri" : "")} onClick={onClick}>
      <span className="exlabel">{label}</span>
      <span className="exhint">{hint}</span>
    </button>
  );

  return (
    <div className="settings-wrap" ref={ref}>
      <button className="btn iconlabel" onClick={() => setOpen((o) => !o)} title="Export">
        <Icon name="download" size={16} /> Export
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="exmenu">
          <div className="exsec">Save &amp; continue</div>
          {item("Project (.qually.json)", "Everything — transcripts, corrections, codes, AI marks. Load this to pick up where you left off.", doProject, true)}
          <div className="exsec">Share &amp; publish</div>
          {item("All as CSVs (.zip)", "The whole bundle as spreadsheets, for a pipeline or a co-author.", doBundle)}
          {item("Coded segments (.csv)", "Segments with computed excerpts.", () => { saveText(s().exportCSV(), "coded-segments.csv"); setOpen(false); })}
          {item("Codebook (.csv)", "Codes with colors, definitions, status.", () => { saveText(s().exportCodebook(), "codebook.csv"); setOpen(false); })}
          {editCount > 0 && item(`Transcript edits (.csv) · ${editCount}`, "Every correction: original vs corrected.",
            () => { saveText(s().exportEdits(), "transcript-edits.csv"); setOpen(false); })}
          {noticeCount > 0 && item(`AI noticings (.csv) · ${noticeCount}`, "Instances the AI marked for review.",
            () => { saveText(s().exportNotices(), "ai-noticings.csv"); setOpen(false); })}
          {aiCalls > 0 && item(`AI log (.csv) · ${aiCalls}`, "Every AI request: model, lines, cost — your methods appendix.",
            () => { saveText(s().exportAiLog(), "ai-provenance.csv"); setOpen(false); })}
          <div className="exsec">Start over</div>
          {item("New project…", "Clear this workspace and start fresh. Asks first; offers a snapshot.",
            () => { setOpen(false); setConfirmNew(true); })}
        </div>
      )}
      {confirmNew && (
        <div className="about-backdrop" onMouseDown={() => setConfirmNew(false)}>
          <div className="about imp" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2>Start a new project?</h2>
              <button className="btn iconbtn" onClick={() => setConfirmNew(false)} title="Cancel (Esc)"><Icon name="x" size={16} /></button>
            </div>
            <p className="about-lede">
              This erases everything in this browser — {tabs.length} transcript{tabs.length === 1 ? "" : "s"} and
              all coding. A project file (.qually.json) brings it all back later.
            </p>
            <div className="imp-actions">
              <button className="btn primary" onClick={doProject}>
                Save the project file first
              </button>
              <button className="btn danger" onClick={() => { s().newProject(); setConfirmNew(false); }}>
                Erase and start new
              </button>
              <button className="btn" onClick={() => setConfirmNew(false)}>Cancel</button>
            </div>
            <div className="imp-note">Undo can't reach across this — the file is the way back.</div>
          </div>
        </div>
      )}
    </div>
  );
}
