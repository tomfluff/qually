// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The last line of defence: a render throw with persisted state behind it is
// otherwise a PERMANENT white screen — reload rehydrates the same value and
// throws again, and the researcher's work is trapped inside the browser with
// no way to reach the export menu. This screen offers the two things that
// matter in that moment: get the raw state out, and start the app again.
import { Component, type ReactNode } from "react";
import { useStore } from "../state/store";
import { dropRawState, readRawState } from "../state/persistence";

const KEY = "coding-app-state";

export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }

  private saveRaw = async () => {
    // a REAL project file first — the render crashed, but the store usually
    // still stands, and exportProject writes the format the import door
    // accepts. Only when even that throws, fall back to the raw persistence
    // envelope (not loadable as-is, but the data is out of the browser).
    let raw = "", name = "qually-project.json";
    try { raw = useStore.getState().exportProject(); }
    catch {
      try { raw = JSON.stringify(await readRawState(KEY) ?? {}, null, 1); } catch { /* nothing to save */ }
      name = "qually-raw-state.json";
    }
    // Keep this fallback self-contained: it must still load when another app
    // module is the reason the normal interface cannot render.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  private reset = () => {
    // reload only after the drop settles — reloading mid-delete rehydrates the
    // same crashing state and this screen just comes back
    dropRawState(KEY).finally(() => location.reload());
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: "38rem", margin: "15vh auto", padding: "0 1.5rem",
        fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.3rem" }}>QuAlly hit an error it couldn't recover from</h1>
        <p>Your work is still stored in this browser. Save a copy of it first — then reset,
          and load that file (or your last saved project) back in.</p>
        <p style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button onClick={this.saveRaw}>Save my work (project file)</button>
          <button onClick={this.reset}>Reset the workspace and reload</button>
          <button onClick={() => location.reload()}>Just reload</button>
        </p>
        <details>
          <summary>What went wrong</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error?.stack ?? this.state.error)}</pre>
        </details>
      </div>
    );
  }
}
