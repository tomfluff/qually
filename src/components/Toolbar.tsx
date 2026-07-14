import { useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";
import { AboutButton } from "./AboutButton";
import { DataFormatButton } from "./DataFormatButton";
import { AiCheckModal } from "./AiCheckModal";
import { Icon } from "./Icon";

export function Toolbar() {
  const importFiles = useStore((s) => s.importFiles);
  const exportCSV = useStore((s) => s.exportCSV);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const exportEdits = useStore((s) => s.exportEdits);
  const transcripts = useStore((s) => s.transcripts);
  const editCount = useMemo(
    () => Object.values(transcripts).reduce((n, t) => n + t.lines.filter((l) => l.orig !== undefined).length, 0),
    [transcripts]
  );
  const exportAiLog = useStore((s) => s.exportAiLog);
  const aiCalls = useStore((s) => s.aiLog.length);
  const onTranscript = useStore((s) => s.active !== "browse" && !!s.transcripts[s.active]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [aiOpen, setAiOpen] = useState(false);

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const n = files.length; // capture before await; the caller clears the live FileList (value="")
    await importFiles(files);
    setStatus(`imported ${n} file(s)`);
  };

  const download = (csv: string, name: string) => {
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doExport = () => {
    download(exportCSV(), "coded-segments.csv");
    setStatus("exported coded-segments.csv (complete file)");
  };

  const doExportEdits = () => {
    download(exportEdits(), "transcript-edits.csv");
    setStatus(`exported transcript-edits.csv (${editCount} correction${editCount === 1 ? "" : "s"})`);
  };

  const doExportAiLog = () => {
    download(exportAiLog(), "ai-provenance.csv");
    setStatus(`exported ai-provenance.csv (${aiCalls} request${aiCalls === 1 ? "" : "s"})`);
  };

  return (
    <div id="toolbar">
      <button className="btn primary iconlabel" onClick={() => fileRef.current?.click()}>
        <Icon name="upload" size={16} /> Import files…
      </button>
      <button className="btn iconlabel" onClick={doExport} title="Export the complete coded-segments.csv">
        <Icon name="download" size={16} /> Export
      </button>
      {editCount > 0 && (
        <button className="btn iconlabel" onClick={doExportEdits}
          title="Export every in-app transcription correction (original vs corrected) as transcript-edits.csv">
          <Icon name="pencil" size={15} /> Edit log ({editCount})
        </button>
      )}
      {aiCalls > 0 && (
        <button className="btn iconlabel" onClick={doExportAiLog}
          title="Export a record of every AI request made (model, lines sent, cost) as ai-provenance.csv">
          <Icon name="download" size={15} /> AI log ({aiCalls})
        </button>
      )}
      <DataFormatButton />
      <span className="tbdiv" />
      {onTranscript && (
        <button className="btn iconlabel aibtn" onClick={() => setAiOpen(true)}
          title="Ask OpenAI to flag likely transcription errors in this transcript">
          <Icon name="sparkle" size={15} /> Check transcription
        </button>
      )}
      <span className="tbdiv" />
      <button className="btn iconbtn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <Icon name="undo" size={16} />
      </button>
      <button className="btn iconbtn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
        <Icon name="redo" size={16} />
      </button>
      <span className="status">{status}</span>
      <SettingsButton />
      <AboutButton />
      <input ref={fileRef} type="file" multiple accept=".csv" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
      {aiOpen && <AiCheckModal onClose={() => setAiOpen(false)} />}
    </div>
  );
}
