import { useEffect } from "react";
import { useStore } from "./state/store";
import { Toolbar } from "./components/Toolbar";
import { Tabs } from "./components/Tabs";
import { CodeSidebar } from "./components/CodeSidebar";
import { TranscriptView } from "./components/TranscriptView";
import { VideoDock } from "./components/VideoDock";
import { HotbarDock } from "./components/HotbarDock";

export function App() {
  const active = useStore((s) => s.active);
  const dark = useStore((s) => s.ui.dark);
  const zen = useStore((s) => s.ui.zen);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
  }, [dark]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); s.undo(); return; }
      if (e.key === "Escape") { if (s.ui.zen) s.setZen(false); s.clearSelection(); return; }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9 && s.selection.lines.size) {
        const code = s.hotbarCache[n - 1];
        if (code) s.applyCode(code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div id="app" className={zen ? "zen" : ""}>
      <Toolbar />
      <Tabs />
      <div id="main">
        <CodeSidebar />
        <div id="content">
          {active === "browse"
            ? <div className="empty">Browse view — coming in a later pass. Open a transcript tab to code.</div>
            : <TranscriptView />}
        </div>
      </div>
      {active !== "browse" && <HotbarDock />}
      <VideoDock />
      {zen && <button className="zenexit" onClick={() => useStore.getState().setZen(false)}>exit zen (Esc)</button>}
    </div>
  );
}
