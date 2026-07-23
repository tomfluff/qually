// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
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
import { ImportModal, SegUpdateModal, ImportSignModal } from "./components/ImportModal";
import { ProjectModal } from "./components/ProjectModal";
import { SearchBar } from "./components/SearchBar";
import { Welcome } from "./components/Welcome";
import { Tooltip } from "./components/Tooltip";
import { ColorPickerHost } from "./colorPicker";
import { Icon } from "./components/Icon";
import { speakerGroupedText } from "./format";
import { accentFor } from "./palettes";
import { AUTHOR_AVATAR } from "./assets/avatar";
import { LENSES, spanLens } from "./ai/flag";
import { useMemo, useRef } from "react";
import { useDismiss } from "./usePopover";

// Show/hide the AI noticing highlights — the blind-reading control. Only appears
// once the active transcript actually has notices, so it costs no chrome before.
function NoticeToggle() {
  const active = useStore((s) => s.active);
  const aiFlags = useStore((s) => s.aiFlags);
  const show = useStore((s) => s.ui.showNotices);
  const hiddenLenses = useStore((s) => s.ui.hiddenLenses);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setMenu(false), { enabled: menu });
  // which lenses actually have marks here — the dropdown lists only these
  // (transcription included: its errors are toggleable from the menu too)
  const presentLenses = useMemo(() => {
    const p = new Set<string>();
    for (const [k, v] of Object.entries(aiFlags))
      if (k.startsWith(`${active}:`)) for (const sp of v.spans) p.add(spanLens(sp));
    return LENSES.filter((l) => p.has(l.id));
  }, [aiFlags, active]);
  if (!presentLenses.some((l) => l.id !== "transcription")) return null;
  const toggleLens = (id: string) =>
    useStore.getState().setUi({
      hiddenLenses: hiddenLenses.includes(id)
        ? hiddenLenses.filter((x) => x !== id) : [...hiddenLenses, id],
    });
  return (
    <div className="noticewrap" ref={ref}>
      <button className="noticetoggle" onClick={() => useStore.getState().setUi({ showNotices: !show })}
        aria-label={show ? "Hide AI noticing highlights (read blind)" : "Show AI noticing highlights"}
        title={show ? "Hide AI noticing highlights (read blind)" : "Show AI noticing highlights"}>
        <Icon name={show ? "eye" : "eye-off"} size={17} />
      </button>
      <button className="noticemore" onClick={() => setMenu((m) => !m)}
        aria-expanded={menu} aria-haspopup="menu"
        aria-label="Choose which noticings are shown" title="Choose which noticings are shown">
        <Icon name={menu ? "chevron-up" : "chevron-down"} size={13} />
      </button>
      {menu && (
        <div className="noticemenu" role="group" aria-label="Noticings shown"
          style={{ fontSize: sidebarFontSize }}>
          {presentLenses.map((l) => {
            // transcription errors ignore the eye (it hides NOTICINGS) — their
            // checkbox stays live even while reading blind
            const t = l.id === "transcription";
            const active = t ? true : show;
            return (
              // lensdiv: transcription is a different KIND of mark (repair, not
              // noticing) — a quiet divider separates it from the lenses
              <label key={l.id} className={(active ? "" : "off") + (t ? " lensdiv" : "")}>
                <input type="checkbox" disabled={!active}
                  checked={active && !hiddenLenses.includes(l.id)}
                  onChange={() => toggleLens(l.id)} />
                <span className="lensdot" style={{ background: l.color }} />
                <span className="lenslabel">{l.label}</span>
              </label>
            );
          })}
          {!show && <div className="noticemenu-note">Noticings are hidden (the eye)</div>}
        </div>
      )}
    </div>
  );
}

const READ_FONTS: Record<"system" | "serif" | "atkinson", string> = {
  system: "system-ui, Segoe UI, Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  atkinson: "'Atkinson Hyperlegible', system-ui, sans-serif",
};

export function App() {
  const active = useStore((s) => s.active);
  // Tabs are a VIEW: closing the last one must not fake a wiped project. As long as
  // any transcript is loaded, keep the Browse pill and the coded work on screen —
  // Welcome is only for a genuinely empty workspace.
  const hasData = useStore((s) => s.tabs.length > 0 || Object.keys(s.transcripts).length > 0);
  const dark = useStore((s) => s.ui.dark);
  const accent = useStore((s) => s.ui.accent);
  const minimapWidth = useStore((s) => s.ui.minimapWidth);
  const fontFamily = useStore((s) => s.ui.fontFamily);
  const zen = useStore((s) => s.ui.zen);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
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
      if (s.pendingSegUpdates.length) {
        if (e.key === "Escape") s.resolveSegUpdates(false); // Esc = "Keep mine", per its tooltip
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
      // the selection — or applied a code — on the transcript underneath it. Checked
      // by PRESENCE in the DOM, not the event target's ancestry: the segment popover
      // and code menu open without taking focus, so keydowns still target the list
      // under them. Each of these closes itself on Escape; the palette additionally
      // needs the hand below for when focus has left its input.
      if (document.querySelector(".about-backdrop, .pop, .ctxmenu, .exmenu, .palette-backdrop, .clrpop")) {
        if (e.key === "Escape" && s.paletteOpen) {
          s.setPalette(false); // and back to the list, same as the palette's own close
          document.querySelector<HTMLElement>(".tviewlist")?.focus();
        }
        return;
      }
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
        <button className="zenexit" style={{ fontSize: sidebarFontSize }}
          onClick={() => useStore.getState().setZen(false)}>
          <Icon name="x" size={sidebarFontSize + 1} /> Exit zen <kbd>Esc</kbd>
        </button>
      )}
      <CommandPalette />
      <ImportModal />
      <SegUpdateModal />
      <ImportSignModal />
      <ProjectModal />
      <SaveWarning />
      <ColorPickerHost />
      <Tooltip />
    </div>
  );
}

// localStorage is full: every autosave is silently failing, so anything coded from
// this moment on exists only in memory. This must out-shout everything else.
function SaveWarning() {
  const saveFailed = useStore((s) => s.saveFailed);
  // dismissible, but it re-arms: if saves recover and then fail AGAIN, that is a
  // new emergency, not the one that was already acknowledged
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (!saveFailed) setDismissed(false); }, [saveFailed]);
  if (!saveFailed || dismissed) return null;
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
      <button className="btn iconbtn" onClick={() => setDismissed(true)} title="Dismiss — saving is still broken"
        aria-label="Dismiss warning"><Icon name="x" size={14} /></button>
    </div>
  );
}
