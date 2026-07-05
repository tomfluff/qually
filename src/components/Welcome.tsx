import { useRef } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

// First-run get-started screen, shown when no transcript is loaded.
export function Welcome() {
  const importFiles = useStore((s) => s.importFiles);
  const setFormatOpen = useStore((s) => s.setFormatOpen);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Code transcripts, offline.</h1>
        <p>Import a transcript CSV to begin. Everything stays in your browser — no account, nothing uploaded.</p>
        <button className="btn primary welcome-import" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size={17} /> Import a transcript…
        </button>
        <input ref={fileRef} type="file" multiple accept=".csv" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files; if (f?.length) importFiles(f); e.target.value = ""; }} />
        <button className="linklike" onClick={() => setFormatOpen(true)}>See the expected file format &amp; get a converter prompt</button>
      </div>
    </div>
  );
}
