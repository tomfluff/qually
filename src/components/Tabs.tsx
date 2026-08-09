// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../state/store";
import { useDismiss } from "../usePopover";
import { Icon } from "./Icon";
import { parseCSV } from "../contract/csv";
import { isMarkerRows } from "../markers";
import { announce } from "../announce";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const pinnedTabs = useStore((s) => s.pinnedTabs);
  const active = useStore((s) => s.active);
  const fontSize = useStore((s) => s.ui.sidebarFontSize);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const [menu, setMenu] = useState<{ pid: string; x: number; y: number } | null>(null);
  const [assistMenu, setAssistMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenuAt = (pid: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ pid, x: r.left, y: r.bottom + 4 });
  };
  const openAssistMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAssistMenu({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <div id="tabs" style={{ fontSize }} role="tablist" aria-label="Transcripts">
      {/* label and × are real <button>s so the keyboard can switch and close tabs;
          the label's click bubbles to the wrapper's onClick (whole tab stays clickable).
          The wrapper is presentation so the tablist's exposed children are the tab
          buttons themselves (the × stays a plain button — it is not a tab). */}
      {tabs.map((pid) => (
        <div key={pid} className={"tab" + (active === pid ? " active" : "")}
          role="presentation" onClick={() => setActive(pid)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ pid, x: e.clientX, y: e.clientY }); }}>
          <button className="tabname" role="tab" aria-selected={active === pid}
            onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
              // keyboard route to the tab menu, matching the sidebar rows
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault(); openMenuAt(pid, e.currentTarget);
              }
            }}>
            {pinnedTabs.includes(pid) && <Icon name="pin" size={fontSize} />}
            {pid}
          </button>
          <button className="x" aria-label={`Close ${pid}`}
            onClick={(e) => { e.stopPropagation(); closeTab(pid); }}>×</button>
        </div>
      ))}
      <button className={"tab browsetab" + (active === "browse" ? " active" : "")}
        role="tab" aria-selected={active === "browse"} onClick={() => setActive("browse")}>
        <Icon name="list" size={14} /> Codebook
      </button>
      {/* Assist tab: click to open, the chevron opens a menu to pick which panel
          (Observations / Merge / Suggest) shows. Right-click opens it too. */}
      <div className={"tab assisttab" + (active === "assist" ? " active" : "")}
        role="presentation"
        onContextMenu={(e) => { e.preventDefault(); setAssistMenu({ x: e.clientX, y: e.clientY }); }}>
        <button className="assistname" role="tab" aria-selected={active === "assist"}
          onClick={() => setActive("assist")}
          title="AI assistance: observations, merge duplicate codes, suggest codes">
          <Icon name="sparkle" size={14} /> Assist
        </button>
        <button className="assistcaret" aria-haspopup="menu" aria-expanded={!!assistMenu}
          aria-label="Choose Assist panel" title="Choose panel"
          onClick={(e) => { e.stopPropagation(); openAssistMenu(e.currentTarget); }}>
          <Icon name={assistMenu ? "chevron-up" : "chevron-down"} size={12} />
        </button>
      </div>
      {menu && <TabMenu pid={menu.pid} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {assistMenu && <AssistMenu x={assistMenu.x} y={assistMenu.y} onClose={() => setAssistMenu(null)} />}
    </div>
  );
}

// Right-click menu for a transcript tab: pin to the front of the list, rename the
// file (renameTranscript remaps every pid-keyed slice), or load this session's
// event log.
//
// Events load from HERE, per tab, rather than through the global Import: which
// participant a recorder's events belong to is a guess from a filename or a
// `session` column, and a wrong guess writes another participant's notes into this
// transcript. The tab you right-clicked is not a guess.
function TabMenu({ pid, x, y, onClose }: { pid: string; x: number; y: number; onClose: () => void }) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const pinned = useStore((s) => s.pinnedTabs.includes(pid));
  const evCount = useStore((s) => s.markers.filter((m) => m.pid === pid).length);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(pid);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const evRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const commit = () => {
    const e = useStore.getState().renameTranscript(pid, name);
    if (e) setErr(e); else onClose();
  };

  const loadEvents = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setErr(null); setNote(null);
    try {
      const rows = parseCSV(await f.text());
      if (!isMarkerRows(rows)) {
        setErr("Not an events CSV — it needs an “event” column and a time (video_time_s, rec_offset_s, or video_time_hms).");
        return;
      }
      const { added, skipped } = useStore.getState().importMarkers(pid, rows);
      // "skipped" is honest about both causes: rows already held, and rows with no
      // readable time. Silence there would read as "all 39 imported" when it wasn't.
      const msg = `${added} event${added === 1 ? "" : "s"} loaded onto ${pid}`
        + (skipped ? `; ${skipped} skipped (already loaded, or no usable time)` : "");
      announce(msg);
      if (added) onClose(); else setNote(msg);
    } catch (e) {
      setErr(`Couldn't read that file: ${(e as Error).message}`);
    }
  };
  return (
    <div className="ctxmenu" ref={ref} role="menu" aria-label={`Tab ${pid}`}
      style={{ left: Math.min(x, window.innerWidth - 240), top: y, fontSize: fs }}>
      <div className="ctxhead">{pid}</div>
      <button role="menuitem"
        onClick={() => { useStore.getState().togglePinTab(pid); onClose(); }}>
        <Icon name="pin" size={fs + 2} /> {pinned ? "Unpin" : "Pin to front"}
      </button>
      <button role="menuitem" onClick={() => evRef.current?.click()}>
        <Icon name="upload" size={fs + 2} /> Load events…
        {evCount > 0 && <span className="ctxcount">{evCount}</span>}
      </button>
      <input ref={evRef} type="file" accept=".csv,text/csv" hidden
        aria-hidden="true" tabIndex={-1}
        onChange={(e) => { void loadEvents(e.target.files); e.target.value = ""; }} />
      {note && <div className="ctxnote">{note}</div>}
      {/* the rename form shows its own errors inline; this is the events one */}
      {err && !renaming && <div className="ctxerr">{err}</div>}
      {!renaming ? (
        <button role="menuitem" onClick={() => setRenaming(true)}>
          <Icon name="pencil" size={fs + 2} /> Rename…
        </button>
      ) : (
        <div className="ctxform">
          <input value={name} autoFocus aria-label={`New name for ${pid}`}
            onChange={(e) => { setName(e.target.value); setErr(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") { e.stopPropagation(); onClose(); }
            }} />
          {err && <div className="ctxerr">{err}</div>}
          <div className="ctxrow">
            <button className="btn" onClick={commit}>Rename</button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Picks which Assist panel shows (Observations / Merge / Suggest). Lives on the
// Assist tab rather than inside the view, so switching panels is one click from
// anywhere and the choice persists (ui.assistPanel). Selecting also opens the tab.
const ASSIST_PANELS = [
  { id: "observations", label: "Observations", hint: "AI marks to triage into codes" },
  { id: "merge", label: "Merge codes", hint: "near-duplicate codes to fold together" },
  { id: "suggest", label: "Suggest codes", hint: "candidate codings from your codebook" },
] as const;

function AssistMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const current = useStore((s) => s.ui.assistPanel);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const pick = (id: (typeof ASSIST_PANELS)[number]["id"]) => {
    useStore.getState().setUi({ assistPanel: id });
    useStore.getState().setActive("assist");
    onClose();
  };
  return (
    <div className="ctxmenu assistmenu" ref={ref} role="menu" aria-label="Assist panel"
      style={{ left: Math.min(x, window.innerWidth - 240), top: y, fontSize: fs }}>
      {ASSIST_PANELS.map((p) => (
        <button key={p.id} role="menuitemradio" aria-checked={current === p.id}
          className={current === p.id ? "on" : ""} onClick={() => pick(p.id)}>
          <span className="assistmenu-check"><Icon name="check" size={fs} /></span>
          <span className="assistmenu-label">{p.label}<em>{p.hint}</em></span>
        </button>
      ))}
    </div>
  );
}
