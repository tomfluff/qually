// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The last line of defence: a render throw with persisted state behind it is
// otherwise a PERMANENT white screen — reload rehydrates the same value and
// throws again, and the researcher's work is trapped inside localStorage with
// no way to reach the export menu. This screen offers the two things that
// matter in that moment: get the raw state out, and start the app again.
import { Component, type ReactNode } from "react";

const KEY = "coding-app-state";

export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }

  private saveRaw = () => {
    let raw = "";
    try { raw = localStorage.getItem(KEY) ?? ""; } catch { /* nothing to save */ }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    a.download = "qually-raw-state.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  private reset = () => {
    try { localStorage.removeItem(KEY); } catch { /* a failed remove changes nothing */ }
    location.reload();
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
          <button onClick={this.saveRaw}>Save my work (raw state)</button>
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
