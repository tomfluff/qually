// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";
import { AboutButton } from "./AboutButton";
import { DataFormatButton } from "./DataFormatButton";
import { AiCheckModal } from "./AiCheckModal";
import { ExportMenu } from "./ExportMenu";
import { NewProjectButton } from "./NewProjectButton";
import { ProjectError } from "../project";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

const countPending = (s: { pendingImports: unknown[]; pendingProject: unknown }) =>
  s.pendingImports.length + (s.pendingProject ? 1 : 0);

export function Toolbar() {
  const importFiles = useStore((s) => s.importFiles);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const onTranscript = useStore((s) => s.active !== "browse" && !!s.transcripts[s.active]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [aiOpen, setAiOpen] = useState(false);

  // files parked behind a confirmation modal (project open, coded re-import)
  const pendingCount = useStore(countPending);
  // once every modal is resolved the "awaiting" status is stale either way
  // (cancelled: nothing happened; confirmed: the workspace itself shows it)
  useEffect(() => {
    if (!pendingCount) setStatus((cur) => (cur.endsWith("awaiting your decision") ? "" : cur));
  }, [pendingCount]);

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const n = files.length; // capture before await; the caller clears the live FileList (value="")
    const before = countPending(useStore.getState());
    try {
      await importFiles(files);
      // a project file or a coded re-import is only STAGED by importFiles — a modal
      // confirms (or cancels) it later, so don't claim those were imported
      const staged = countPending(useStore.getState()) - before;
      setStatus(staged
        ? n > staged
          ? `imported ${n - staged} file(s); ${staged} awaiting your decision`
          : `${staged} file(s) awaiting your decision`
        : `imported ${n} file(s)`);
    } catch (e) {
      // a bad/newer project file must say so, not fail silently
      setStatus(e instanceof ProjectError ? e.message : `import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div id="toolbar">
      <span className="brand">
        <Logo size={22} />
        <span className="brandname">Qu<span className="brand-ally">Ally</span></span>
        <span className="brandtag">Thematic analysis, made accessible</span>
      </span>
      <span className="tbdiv" />
      <NewProjectButton />
      <button className="btn primary iconlabel" onClick={() => fileRef.current?.click()}
        title="Import transcript/codebook/segment CSVs, or open a .qually.json project">
        <Icon name="upload" size={16} /> Import files…
      </button>
      <ExportMenu />
      <span className="tbdiv" />
      {onTranscript && (
        <>
          <button className="btn iconlabel aibtn" onClick={() => setAiOpen(true)}
            aria-haspopup="dialog" aria-expanded={aiOpen}
            title="Scan this transcript with AI: transcription errors, plus noticing lenses you choose (emotions, likes/dislikes, desires…)">
            <Icon name="sparkle" size={15} /> AI scan
          </button>
          <span className="tbdiv" />
        </>
      )}
      <button className="btn iconbtn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <Icon name="undo" size={16} />
      </button>
      <button className="btn iconbtn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
        <Icon name="redo" size={16} />
      </button>
      {/* role=status: import results (and failures) announce to screen readers */}
      <span className="status" role="status">{status}</span>
      {/* right-edge cluster, left→right: GitHub · File format · Help · Settings */}
      <a className="btn iconlabel ghlink" href="https://github.com/tomfluff/qually" target="_blank"
        rel="noreferrer" title="Code on GitHub" aria-label="View QuAlly on GitHub">
        <Icon name="github" size={16} /> GitHub
      </a>
      <DataFormatButton />
      <AboutButton />
      <SettingsButton />
      <input ref={fileRef} type="file" multiple accept=".csv,.json" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
      {aiOpen && <AiCheckModal onClose={() => setAiOpen(false)} />}
    </div>
  );
}
