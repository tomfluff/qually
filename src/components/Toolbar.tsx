import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";
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
    await importFiles(files);
    setStatus(`imported ${files.length} file(s)`);
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
      <button className="btn iconbtn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <Icon name="undo" size={16} />
      </button>
      <button className="btn iconbtn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
        <Icon name="redo" size={16} />
      </button>
      <span className="tbdiv" />
      <button className="btn" onClick={() => fileRef.current?.click()}>Import files…</button>
      <button className="btn" onClick={doExport}>Export coded-segments.csv</button>
      <SettingsButton />
      <span className="status">{status}</span>
      <input ref={fileRef} type="file" multiple accept=".csv" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
    </div>
  );
}
