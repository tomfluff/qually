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
import { ImportModal, SegUpdateModal } from "./components/ImportModal";
import { ProjectModal } from "./components/ProjectModal";
import { SearchBar } from "./components/SearchBar";
import { Welcome } from "./components/Welcome";
import { Icon } from "./components/Icon";
import { speakerGroupedText } from "./format";
import { accentFor } from "./palettes";
import { AUTHOR_AVATAR } from "./assets/avatar";
import { spanLens } from "./ai/flag";
import { useMemo } from "react";

// Show/hide the AI noticing highlights — the blind-reading control. Only appears
// once the active transcript actually has notices, so it costs no chrome before.
function NoticeToggle() {
  const active = useStore((s) => s.active);
  const aiFlags = useStore((s) => s.aiFlags);
  const show = useStore((s) => s.ui.showNotices);
  const hasNotices = useMemo(
    () => Object.entries(aiFlags).some(([k, v]) =>
      k.startsWith(`${active}:`) && v.spans.some((sp) => spanLens(sp) !== "transcription")),
    [aiFlags, active]
  );
  if (!hasNotices) return null;
  return (
    <button className="noticetoggle" onClick={() => useStore.getState().setUi({ showNotices: !show })}
      title={show ? "Hide AI noticing highlights (read blind)" : "Show AI noticing highlights"}>
      <Icon name={show ? "eye" : "eye-off"} size={17} />
    </button>
  );
}

const READ_FONTS: Record<"system" | "serif" | "atkinson", string> = {
  system: "system-ui, Segoe UI, Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  atkinson: "'Atkinson Hyperlegible', system-ui, sans-serif",
};

export function App() {
  const active = useStore((s) => s.active);
  const hasData = useStore((s) => s.tabs.length > 0);
  const dark = useStore((s) => s.ui.dark);
  const accent = useStore((s) => s.ui.accent);
  const minimapWidth = useStore((s) => s.ui.minimapWidth);
  const fontSize = useStore((s) => s.ui.fontSize);
  const fontFamily = useStore((s) => s.ui.fontFamily);
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

  // Tooltips size themselves from --txt-fs. It was only ever set on the transcript list,
  // so every tip OUTSIDE the transcript silently fell back to 16px * .8 = 12.8px — the
  // unreadably-small tooltip we replaced native `title` to escape. Set it at the root so
  // the whole app's tips follow the text size the reader actually chose.
  useEffect(() => {
    document.documentElement.style.setProperty("--txt-fs", `${fontSize}px`);
  }, [fontSize]);

  // Reading font for the transcript text and Browse excerpts (the chrome stays
  // system). Atkinson Hyperlegible is embedded (styles/fonts.css); the others map
  // to platform faces, so only the one the reader picks costs anything.
  useEffect(() => {
    document.documentElement.style.setProperty("--read-font", READ_FONTS[fontFamily]);
  }, [fontFamily]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      // The re-import / open-project modals are decision points: they own the
      // keyboard until answered. Checked before the input guard below — the file
      // input still holds focus right after an import, and Esc has to close them.
      if (s.pendingProject) {
        if (e.key === "Escape") s.setPendingProject(null);
        return;
      }
      if (s.pendingImports.length) {
        if (e.key === "Escape") s.resolveImport("cancel");
        return;
      }
      // Ctrl+F opens transcript search (works from anywhere, incl. inputs)
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (s.active !== "browse") { e.preventDefault(); s.openSearch(); }
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      // A dialog or popover owns the keyboard while it's up. Without this, arrows and
      // digit hotkeys reached through an open Help modal or segment popover and moved
      // the selection — or applied a code — on the transcript underneath it.
      // Optional-call: a keydown whose target isn't an Element (window/document) would
      // otherwise throw here and take every hotkey down with it.
      if (t?.closest?.(".about-backdrop, .pop, .settings-pop, .exmenu, .menu")) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); s.redo(); return; }
      // Esc peels one layer at a time: palette -> search -> zen -> selection
      if (e.key === "Escape") {
        if (s.paletteOpen) s.setPalette(false);
        else if (s.search.open) s.closeSearch();
        else if (s.ui.zen) s.setZen(false);
        else s.clearSelection();
        return;
      }
      // arrow nav: plain jumps to the adjacent line, Shift moves the head (W2 item 7)
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && s.active !== "browse"
        && s.selection.pid === s.active && s.selection.lines.size) {
        e.preventDefault();
        s.moveSelection(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
        return;
      }
      // plain digits only — Ctrl+0 (zoom reset), Ctrl+1-9 (tab switch), Alt+digit stay with the browser
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
      {hasData && <Tabs />}
      <div id="main">
        {hasData && active !== "browse" && (
          <>
            <CodeSidebar />
            <Resizer onWidth={(w) => useStore.getState().setUi({ sidebarWidth: Math.max(160, Math.min(560, w)) })} />
          </>
        )}
        <div id="content">
          {hasData && active !== "browse" && !searchOpen && (
            <button className="searchtoggle" title="Search (Ctrl+F)"
              onClick={() => useStore.getState().openSearch()}>
              <Icon name="search" size={17} />
            </button>
          )}
          {hasData && active !== "browse" && !searchOpen && <NoticeToggle />}
          {hasData && active !== "browse" && <SearchBar />}
          {!hasData ? <Welcome /> : (active === "browse" ? <BrowseView /> : <TranscriptView />)}
        </div>
      </div>
      <footer id="footer">
        <span>Created with love and care by</span>
        <a className="foot-author" href="https://tomfluff.github.io/" target="_blank" rel="noreferrer">
          <img className="foot-avatar" src={AUTHOR_AVATAR} alt="Yotam Sechayk" width={20} height={20} />
          <span>Yotam Sechayk</span>
        </a>
        <span>— reach out with any questions.</span>
      </footer>
      {active !== "browse" && <HotbarDock />}
      <VideoDock />
      {zen && (
        <button className="zenexit" onClick={() => useStore.getState().setZen(false)}>
          <Icon name="x" size={13} /> Exit zen <kbd>Esc</kbd>
        </button>
      )}
      <CommandPalette />
      <ImportModal />
      <SegUpdateModal />
      <ProjectModal />
      <SaveWarning />
    </div>
  );
}

// localStorage is full: every autosave is silently failing, so anything coded from
// this moment on exists only in memory. This must out-shout everything else.
function SaveWarning() {
  const saveFailed = useStore((s) => s.saveFailed);
  if (!saveFailed) return null;
  const exportProject = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([useStore.getState().exportProject()], { type: "application/json" }));
    a.download = "qually-backup.qually.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="savewarn" role="alert">
      <Icon name="alert-triangle" size={16} />
      <span><b>Autosave is failing</b> — the browser's storage is full. Nothing saves until space is freed.
        Export your project now, then start a new project or remove a transcript.</span>
      <button className="btn" onClick={exportProject}>Export project</button>
    </div>
  );
}
