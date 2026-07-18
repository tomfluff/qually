// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { saveText } from "./ExportMenu";
import { Icon } from "./Icon";

// "New project" lives on the toolbar, not inside Export — clearing the workspace
// isn't an export. The confirm modal still offers the snapshot as the way back.
export function NewProjectButton() {
  const [confirm, setConfirm] = useState(false);
  const dialogRef = useDialogFocus();
  const tabs = useStore((s) => s.tabs);
  const s = () => useStore.getState();

  // Esc cancels, as the close button's tooltip promises (the AboutButton pattern)
  useEffect(() => {
    if (!confirm) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setConfirm(false); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [confirm]);

  return (
    <>
      <button className="btn iconlabel" onClick={() => setConfirm(true)}
        title="Clear this workspace and start fresh (asks first; offers a snapshot)">
        <Icon name="file-plus" size={16} /> <span className="blabel">New</span>
      </button>
      {confirm && (
        <div className="about-backdrop" onMouseDown={() => setConfirm(false)}>
          <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
            aria-labelledby="new-project-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="new-project-title">Start a new project?</h2>
              <button className="btn iconbtn" onClick={() => setConfirm(false)} title="Cancel (Esc)"><Icon name="x" size={16} /></button>
            </div>
            <p className="about-lede">
              This erases everything in this browser — {tabs.length} transcript{tabs.length === 1 ? "" : "s"} and
              all coding. A project file (.qually.json) brings it all back later.
            </p>
            <div className="imp-actions">
              <button className="btn primary" onClick={() => saveText(s().exportProject(), "qually-project.qually.json", "application/json")}>
                Save the project file first
              </button>
              <button className="btn danger" onClick={() => { s().newProject(); setConfirm(false); }}>
                Erase and start new
              </button>
              <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
            <div className="imp-note">Undo can't reach across this — the file is the way back.</div>
          </div>
        </div>
      )}
    </>
  );
}
