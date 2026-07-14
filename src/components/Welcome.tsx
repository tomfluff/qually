import { useRef, useState } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

// First-run get-started screen, shown when no transcript is loaded.
export function Welcome() {
  const importFiles = useStore((s) => s.importFiles);
  const setFormatOpen = useStore((s) => s.setFormatOpen);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");

  return (
    <div className="welcome">
      <div className="welcome-card">
        <span className="welcome-logo"><Logo size={72} /></span>
        <h1>Code transcripts, offline.</h1>
        <p>Import a transcript CSV to begin. Everything stays in your browser — no account, and nothing
          is uploaded unless you add your own OpenAI key and approve a request.</p>
        <button className="btn primary welcome-import" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size={17} /> Import a transcript…
        </button>
        <input ref={fileRef} type="file" multiple accept=".csv,.json" style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files;
            if (f?.length) importFiles(f).then(() => setErr("")).catch((x) => setErr((x as Error).message));
            e.target.value = "";
          }} />
        {err && <div className="ai-warn" role="alert">{err}</div>}
        <p className="welcome-open">Already have a <code>.qually.json</code> project? Import it here to pick up where you left off.</p>
        <button className="linklike" onClick={() => setFormatOpen(true)}>See the expected file format &amp; get a converter prompt</button>
      </div>
    </div>
  );
}
