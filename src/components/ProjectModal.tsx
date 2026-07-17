// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useStore } from "../state/store";
import { statsOf } from "../project";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

// Opening a project REPLACES the workspace. Same lesson as the re-import modal:
// undo can't reach across it, so the preview is the safety net — show what's
// coming in and what's about to go, before anything happens.
export function ProjectModal() {
  const p = useStore((s) => s.pendingProject);
  // primitives only — a selector returning a fresh object re-renders forever
  const curTranscripts = useStore((s) => Object.keys(s.transcripts).length);
  const curSegments = useStore((s) => s.segments.length);
  const dialogRef = useDialogFocus();
  if (!p) return null;
  const cur = { transcripts: curTranscripts, segments: curSegments };

  const st = statsOf(p);
  const close = () => useStore.getState().setPendingProject(null);
  const hasWork = cur.transcripts > 0 || cur.segments > 0;
  const saved = st.savedAt ? new Date(st.savedAt).toLocaleString() : "unknown date";

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
          {st.edits > 0 && <div><b>{st.edits}</b> transcription correction{st.edits === 1 ? "" : "s"}</div>}
          {st.notices > 0 && <div><b>{st.notices}</b> AI noticing{st.notices === 1 ? "" : "s"}</div>}
        </div>

        {hasWork && (
          <div className="ai-warn">
            <b>This replaces everything currently open</b> — {cur.transcripts} transcript{cur.transcripts === 1 ? "" : "s"} and {cur.segments} segment{cur.segments === 1 ? "" : "s"}.
            Export your current work first if you need it: undo can't reach across this.
          </div>
        )}

        <div className="imp-actions">
          <button className="btn primary" onClick={() => useStore.getState().openProject(p)}>
            {hasWork ? "Replace and open" : "Open project"}
          </button>
          <button className="btn" onClick={close}>Cancel</button>
        </div>
        <div className="imp-note">Media files aren't stored in a project — re-attach them in the video dock.</div>
      </div>
    </div>
  );
}
