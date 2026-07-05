import { useEffect } from "react";
import { useStore } from "./state/store";
import { Toolbar } from "./components/Toolbar";
import { Tabs } from "./components/Tabs";
import { CodeSidebar } from "./components/CodeSidebar";
import { Resizer } from "./components/Resizer";
import { TranscriptView } from "./components/TranscriptView";
import { BrowseView } from "./components/BrowseView";
import { VideoDock } from "./components/VideoDock";
import { HotbarDock } from "./components/HotbarDock";
import { CommandPalette } from "./components/CommandPalette";
import { SearchBar } from "./components/SearchBar";
import { Icon } from "./components/Icon";
import { speakerGroupedText } from "./format";
import { accentFor } from "./palettes";

export function App() {
  const active = useStore((s) => s.active);
  const dark = useStore((s) => s.ui.dark);
  const accent = useStore((s) => s.ui.accent);
  const minimapWidth = useStore((s) => s.ui.minimapWidth);
  const zen = useStore((s) => s.ui.zen);
  const searchOpen = useStore((s) => s.search.open);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
    // chosen primary for this theme; CSS derives every other chromatic tint from it
    document.documentElement.style.setProperty("--accent", accentFor(accent, dark));
  }, [dark, accent]);

  // minimap width drives its own width + the search bar/toggle offset
  useEffect(() => {
    document.documentElement.style.setProperty("--mm-w", `${minimapWidth}px`);
  }, [minimapWidth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      // Ctrl+F opens transcript search (works from anywhere, incl. inputs)
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (s.active !== "browse") { e.preventDefault(); s.openSearch(); }
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); s.redo(); return; }
      if (e.key === "Escape") { if (s.search.open) s.closeSearch(); if (s.ui.zen) s.setZen(false); s.clearSelection(); return; }
      // arrow nav: plain jumps to the adjacent line, Shift moves the head (W2 item 7)
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && s.active !== "browse"
        && s.selection.pid === s.active && s.selection.lines.size) {
        e.preventDefault();
        s.moveSelection(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
        return;
      }
      if (e.key === "0") { e.preventDefault(); s.setPalette(true); return; }
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
      if (window.getSelection()?.toString().trim()) return; // let a real text selection copy itself
      if (document.querySelector(".pop")) return; // an open segment popover copies itself
      const s = useStore.getState();
      if (s.active === "browse" || s.selection.pid !== s.active || !s.selection.lines.size) return;
      const tr = s.transcripts[s.active];
      if (!tr) return;
      const sel = tr.lines.filter((l) => s.selection.lines.has(l.id));
      if (!sel.length) return;
      e.clipboardData?.setData("text/plain", speakerGroupedText(sel));
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
        {active !== "browse" && (
          <>
            <CodeSidebar />
            <Resizer onWidth={(w) => useStore.getState().setUi({ sidebarWidth: Math.max(160, Math.min(560, w)) })} />
          </>
        )}
        <div id="content">
          {active !== "browse" && !searchOpen && (
            <button className="searchtoggle" title="Search (Ctrl+F)"
              onClick={() => useStore.getState().openSearch()}>
              <Icon name="search" size={17} />
            </button>
          )}
          {active !== "browse" && <SearchBar />}
          {active === "browse" ? <BrowseView /> : <TranscriptView />}
        </div>
      </div>
      {active !== "browse" && <HotbarDock />}
      <VideoDock />
      {zen && (
        <button className="zenexit" onClick={() => useStore.getState().setZen(false)}>
          <Icon name="x" size={13} /> Exit zen <kbd>Esc</kbd>
        </button>
      )}
      <CommandPalette />
    </div>
  );
}
