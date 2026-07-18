// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { SettingsButton } from "./SettingsButton";
import { AboutButton } from "./AboutButton";
import { DataFormatButton } from "./DataFormatButton";
import { AiCheckModal } from "./AiCheckModal";
import { ExportMenu } from "./ExportMenu";
import { NewProjectButton } from "./NewProjectButton";
import { ProjectError } from "../project";
import { announce } from "../announce";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

const countPending = (s: { pendingImports: unknown[]; pendingProject: unknown }) =>
  s.pendingImports.length + (s.pendingProject ? 1 : 0);

// "Who's coding?" — raised when a transcript loads (or is already loaded at startup) and
// the coder is still (default). Fires per transcript-load, not once ever, so it keeps
// reminding until you name yourself. Deferred while an import "whose are these?" dialog is
// up, so you attribute the imported rows before signing your own work.
function CoderPrompt() {
  const pending = useStore((s) => s.pendingCoderAsk);
  const signPending = useStore((s) => !!s.pendingImportSign);
  const resolve = useStore((s) => s.resolveCoderAsk);
  const [name, setName] = useState("");
  const dialogRef = useDialogFocus();
  const show = pending && !signPending;
  const done = (nm: string | null) => { resolve(nm); setName(""); };

  useEffect(() => {
    if (!show) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  if (!show) return null;

  return (
    <div className="about-backdrop" onMouseDown={() => done(null)}>
      <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="coder-prompt-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="coder-prompt-title">Who's coding?</h2>
          <button className="btn iconbtn" onClick={() => done(null)} title="Not now (Esc)"><Icon name="x" size={16} /></button>
        </div>
        <p className="about-lede">
          Your name is written as <code>proposed_by</code> on every code you make — it's how your
          coding is told apart from a second coder's in the export. Set it now, or code as{" "}
          <code>(default)</code> and decide later (the chip and export will remind you).
        </p>
        <label className="signfield"><span>Your name</span>
          <input className="signinput" autoFocus value={name} placeholder="your name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) done(name); }} />
        </label>
        <div className="imp-actions">
          <button className="btn primary" disabled={!name.trim()} onClick={() => done(name)}>Save</button>
          <button className="btn" onClick={() => done(null)}>Not now — code as (default)</button>
        </div>
      </div>
    </div>
  );
}

// Who your codes are signed as. It lived in Settings, which meant a second coder could
// code a whole session and only meet the field after exporting — by which point the
// proposed_by column, the one thing that tells two coders apart, was already wrong.
// It sits in the toolbar for the same reason an account chip does: it answers "who am I".
function CoderChip() {
  const coderName = useStore((s) => s.ui.coderName);
  const setUi = useStore((s) => s.setUi);
  const claimUnattributed = useStore((s) => s.claimUnattributed);
  const [editing, setEditing] = useState(false);
  const name = coderName.trim();
  if (editing) {
    return (
      <input className="coderchip-edit" autoFocus value={coderName} placeholder="your name"
        aria-label="Your name — stamped on every code you make"
        onChange={(e) => setUi({ coderName: e.target.value })}
        onBlur={() => { setEditing(false); claimUnattributed(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
    );
  }
  return (
    <button className={"btn iconlabel coderchip" + (name ? "" : " unset")} onClick={() => setEditing(true)}
      title={name
        ? `Coding as "${name}" — the name written as proposed_by on every code you make. Click to change.`
        : "No name set — your codes are signed (default). Click to sign them as you."}>
      <Icon name="pencil" size={14} /> <span className="blabel">{name || "(default)"}</span>
    </button>
  );
}

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
      const msg = staged
        ? n > staged
          ? `imported ${n - staged} file(s); ${staged} awaiting your decision`
          : `${staged} file(s) awaiting your decision`
        : `imported ${n} file(s)`;
      setStatus(msg); announce(msg);
    } catch (e) {
      // a bad/newer project file must say so, not fail silently — and an error is the
      // one thing that should interrupt the reader, not queue behind it.
      const msg = e instanceof ProjectError ? e.message : `import failed: ${(e as Error).message}`;
      setStatus(msg); announce(msg, { assertive: true });
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
        <Icon name="upload" size={16} /> Import
      </button>
      <ExportMenu />
      <span className="tbdiv" />
      {onTranscript && (
        <>
          <button className="btn iconlabel aibtn" onClick={() => setAiOpen(true)}
            aria-haspopup="dialog" aria-expanded={aiOpen}
            title="Scan this transcript with AI: transcription errors, plus noticing lenses you choose (emotions, likes/dislikes, desires…)">
            <Icon name="sparkle" size={15} /> <span className="blabel">AI scan</span>
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
      {/* visual only — the SR announcement is fired imperatively in doImport (polite for
          results, assertive for failures) so it isn't also spoken by a live region here */}
      <span className="status">{status}</span>
      <CoderChip />
      {/* right-edge cluster, left→right: GitHub · File format · Help · Settings */}
      <a className="btn iconlabel ghlink" href="https://github.com/tomfluff/qually" target="_blank"
        rel="noreferrer" title="Code on GitHub" aria-label="View QuAlly on GitHub">
        <Icon name="github" size={16} /> <span className="blabel">GitHub</span>
      </a>
      <DataFormatButton />
      <AboutButton />
      <SettingsButton />
      <input ref={fileRef} type="file" multiple accept=".csv,.json" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
      {aiOpen && <AiCheckModal onClose={() => setAiOpen(false)} />}
      <CoderPrompt />
    </div>
  );
}
