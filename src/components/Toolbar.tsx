import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";
import { AboutButton } from "./AboutButton";
import { DataFormatButton } from "./DataFormatButton";
import { Icon } from "./Icon";

export function Toolbar() {
  const importFiles = useStore((s) => s.importFiles);
  const exportCSV = useStore((s) => s.exportCSV);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");

  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const n = files.length; // capture before await; the caller clears the live FileList (value="")
    await importFiles(files);
    setStatus(`imported ${n} file(s)`);
  };

  const doExport = () => {
    const blob = new Blob([exportCSV()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coded-segments.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("exported coded-segments.csv (complete file)");
  };

  return (
    <div id="toolbar">
      <button className="btn" onClick={() => fileRef.current?.click()}>Import files…</button>
      <DataFormatButton />
      <button className="btn" onClick={doExport}>Export coded-segments.csv</button>
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
    </div>
  );
}
