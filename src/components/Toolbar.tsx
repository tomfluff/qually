import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";
import { AboutButton } from "./AboutButton";
import { DataFormatButton } from "./DataFormatButton";
import { AiCheckModal } from "./AiCheckModal";
import { ExportMenu } from "./ExportMenu";
import { ProjectError } from "../project";
import { Icon } from "./Icon";

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

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const n = files.length; // capture before await; the caller clears the live FileList (value="")
    try {
      await importFiles(files);
      setStatus(`imported ${n} file(s)`);
    } catch (e) {
      // a bad/newer project file must say so, not fail silently
      setStatus(e instanceof ProjectError ? e.message : `import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div id="toolbar">
      <button className="btn primary iconlabel" onClick={() => fileRef.current?.click()}
        title="Import transcript/codebook/segment CSVs, or open a .qually.json project">
        <Icon name="upload" size={16} /> Import files…
      </button>
      <ExportMenu />
      <DataFormatButton />
      <span className="tbdiv" />
      {onTranscript && (
        <button className="btn iconlabel aibtn" onClick={() => setAiOpen(true)}
          title="Scan this transcript with AI: transcription errors, plus noticing lenses you choose (emotions, likes/dislikes, desires…)">
          <Icon name="sparkle" size={15} /> AI scan
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
      <input ref={fileRef} type="file" multiple accept=".csv,.json" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
      {aiOpen && <AiCheckModal onClose={() => setAiOpen(false)} />}
    </div>
  );
}
