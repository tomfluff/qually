import { createRoot } from "react-dom/client";

// UI is pending — W1.0 ships the contract module (src/contract) + parity tests
// first. Components land in later workstreams (CODING-APP-DEV.md §3 W1-W6).
createRoot(document.getElementById("root")!).render(
  <div style={{ font: "16px system-ui", padding: 24 }}>
    Coding App v2 — contract module in place, UI pending.
  </div>
);
