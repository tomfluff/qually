import { useEffect } from "react";
import { useStore } from "./state/store";
import { Toolbar } from "./components/Toolbar";
import { Tabs } from "./components/Tabs";
import { CodeSidebar } from "./components/CodeSidebar";
import { TranscriptView } from "./components/TranscriptView";
import { BrowseView } from "./components/BrowseView";
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
      // arrow nav: plain moves selection to the adjacent line, Shift extends (W2 item 7)
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && s.active !== "browse"
        && s.selection.pid === s.active && s.selection.lines.size) {
        const tr = s.transcripts[s.active];
        if (tr) {
          e.preventDefault();
          const ids = [...s.selection.lines].sort((a, b) => a - b);
          const arr = tr.lines;
          const target = e.key === "ArrowUp"
            ? arr[arr.findIndex((l) => l.id === ids[0]) - 1]
            : arr[arr.findIndex((l) => l.id === ids[ids.length - 1]) + 1];
          if (target) s.selectLine(target.id, { extend: e.shiftKey });
          return;
        }
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9 && s.selection.lines.size) {
        const code = s.hotbarCache[n - 1];
        if (code) s.applyCode(code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+C: copy selected lines, speaker-grouped, in transcript order (W2 item 8).
  // Handled on the copy event so it wins over the (empty) native selection.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const s = useStore.getState();
      if (s.active === "browse" || s.selection.pid !== s.active || !s.selection.lines.size) return;
      const tr = s.transcripts[s.active];
      if (!tr) return;
      const sel = tr.lines.filter((l) => s.selection.lines.has(l.id));
      if (!sel.length) return;
      const groups: { speaker: string; texts: string[] }[] = [];
      for (const l of sel) {
        const last = groups[groups.length - 1];
        if (last && last.speaker === l.speaker) last.texts.push(l.text.trim());
        else groups.push({ speaker: l.speaker, texts: [l.text.trim()] });
      }
      e.clipboardData?.setData("text/plain",
        groups.map((g) => `${g.speaker} : ${g.texts.join(" ")}`).join("\n"));
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  return (
    <div id="app" className={zen ? "zen" : ""}>
      <Toolbar />
      <Tabs />
      <div id="main">
        <CodeSidebar />
        <div id="content">
          {active === "browse" ? <BrowseView /> : <TranscriptView />}
        </div>
      </div>
      {active !== "browse" && <HotbarDock />}
      <VideoDock />
      {zen && <button className="zenexit" onClick={() => useStore.getState().setZen(false)}>exit zen (Esc)</button>}
    </div>
  );
}
