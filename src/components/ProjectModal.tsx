// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { openAsNewProject, projectsAvailable } from "../state/projects";
import { statsOf } from "../project";
import { announce } from "../announce";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

// Preview the file before opening it; existing work stays beside it when this
// browser can keep several projects.
export function ProjectModal() {
  const p = useStore((s) => s.pendingProject);
  // primitives only — a selector returning a fresh object re-renders forever
  const curTranscripts = useStore((s) => Object.keys(s.transcripts).length);
  const curSegments = useStore((s) => s.segments.length);
  const curName = useStore((s) => s.projectName.trim() || "Untitled project");
  // Anything you would miss counts as work — a codebook drafted before any
  // transcript, a name, notes or a brief — not just transcripts and coding:
  // only a project with none of it is opened over rather than beside.
  const hasWork = useStore((s) => Object.keys(s.transcripts).length > 0 || s.segments.length > 0
    || s.extSegRows.length > 0 || Object.keys(s.codebook).length > 0
    || !!s.projectName.trim() || !!s.projectNotes.trim()
    || [...Object.values(s.studyBrief), ...Object.values(s.substBrief)].some((t) => t.trim()));
  const [opening, setOpening] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setErr(""), [p]); // a refusal belongs to the file it refused
  const dialogRef = useDialogFocus();
  if (!p) return null;
  const cur = { transcripts: curTranscripts, segments: curSegments };

  const st = statsOf(p);
  const close = () => useStore.getState().setPendingProject(null);
  const asNew = hasWork && projectsAvailable();
  const saved = st.savedAt ? new Date(st.savedAt).toLocaleString() : "unknown date";
  const label = p.projectName?.trim() || "the project";
  const open = async () => {
    if (opening) return;
    if (!asNew) { useStore.getState().openProject(p); announce(`Opened ${label}.`); return; }
    setOpening(true);
    try {
      // false: cancelled while the current project was still saving
      if (await openAsNewProject(p)) announce(`Opened ${label} as a new project.`);
    } catch (e) {
      // on screen as well as said; the dialog stays, so Cancel is right there
      const msg = `Couldn't open it: ${e instanceof Error ? e.message : String(e)}.`;
      setErr(msg);
      announce(msg, { assertive: true });
    } finally { setOpening(false); }
  };

  return (
    <div className="about-backdrop" onMouseDown={close}>
      <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="project-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="project-title">Open project</h2>
          <button className="btn iconbtn" onClick={close} title="Cancel (Esc)"><Icon name="x" size={16} /></button>
        </div>

        <p className="about-lede">Saved {saved}.</p>
        <div className="imp-stats">
          <div><b>{st.transcripts}</b> transcript{st.transcripts === 1 ? "" : "s"} · <b>{st.lines.toLocaleString()}</b> lines</div>
          <div><b>{st.segments}</b> coded segment{st.segments === 1 ? "" : "s"} · <b>{st.codes}</b> code{st.codes === 1 ? "" : "s"}</div>
          {/* "line", not "transcription": the count now covers corrections to a
              translation too, and naming only one of them would undercount in a
              way the reader could not see */}
          {st.edits > 0 && <div><b>{st.edits}</b> line correction{st.edits === 1 ? "" : "s"}</div>}
          {st.notices > 0 && <div><b>{st.notices}</b> AI observation{st.notices === 1 ? "" : "s"}</div>}
          {st.events > 0 && <div><b>{st.events}</b> session event{st.events === 1 ? "" : "s"}</div>}
        </div>

        {/* The counts above are of the CLEANED project, so without this the
            dialog confirms "480 segments" for a file that held 483 and the
            researcher opens, works, and saves the loss over their only copy.
            role=alert: this is the one thing on this screen they cannot get
            back once they press Open. */}
        {!!p.warnings?.length && (
          <div className="ai-warn" role="alert">
            <b>Part of this file could not be read.</b> {p.warnings.join("; ")}. The counts
            above are what will load. The file on disk is untouched until you save.
          </div>
        )}

        {asNew ? (
          <div className="imp-note">It opens as a new project. “{curName}” stays in this browser — switch back from the Projects menu.</div>
        ) : hasWork && (
          <div className="ai-warn">
            <b>This replaces everything currently open</b> — {cur.transcripts} transcript{cur.transcripts === 1 ? "" : "s"} and {cur.segments} segment{cur.segments === 1 ? "" : "s"}.
            Export your current work first if you need it: undo can't reach across this.
          </div>
        )}

        {err && <div className="ai-warn">{err}</div>}

        <div className="imp-actions">
          <button className="btn primary" aria-disabled={opening} onClick={() => { void open(); }}>
            {asNew ? "Open as new project" : hasWork ? "Replace and open" : "Open project"}
          </button>
          <button className="btn" onClick={close}>Cancel</button>
        </div>
        <div className="imp-note">Media files aren't stored in a project — re-attach them in the video dock.</div>
      </div>
    </div>
  );
}
