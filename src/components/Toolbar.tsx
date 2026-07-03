import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { SettingsButton } from "./SettingsButton";

export function Toolbar() {
  const importFiles = useStore((s) => s.importFiles);
  const exportCSV = useStore((s) => s.exportCSV);
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
      <button className="btn" onClick={() => fileRef.current?.click()}>Import files…</button>
      <button className="btn" onClick={doExport}>Export coded-segments.csv</button>
      <SettingsButton />
      <span className="status">{status}</span>
      <input ref={fileRef} type="file" multiple accept=".csv" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files); e.target.value = ""; }} />
    </div>
  );
}
