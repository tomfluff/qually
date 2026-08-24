// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CrashScreen } from "./components/CrashScreen";
import { useStore } from "./state/store";
import "./index.css";

// IndexedDB hydration is async: rendering before it lands would flash an empty
// workspace (and run effects against it) for a few frames on every launch.
// Hold the app back until the saved project is in the store.
function Hydrated({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(useStore.persist.hasHydrated());
  useEffect(() => {
    // subscribe FIRST, then re-check: hydration can land between the initial
    // render and this effect running, and a finish event missed in that gap
    // never fires again — the app would hold back forever
    const unsub = useStore.persist.onFinishHydration(() => setReady(true));
    if (useStore.persist.hasHydrated()) setReady(true);
    return unsub;
  }, []);
  return ready ? children : null;
}

createRoot(document.getElementById("root")!).render(<CrashScreen><Hydrated><App /></Hydrated></CrashScreen>);
