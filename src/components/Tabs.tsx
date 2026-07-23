// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../state/store";
import { useDismiss } from "../usePopover";
import { Icon } from "./Icon";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const pinnedTabs = useStore((s) => s.pinnedTabs);
  const active = useStore((s) => s.active);
  const fontSize = useStore((s) => s.ui.sidebarFontSize);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const [menu, setMenu] = useState<{ pid: string; x: number; y: number } | null>(null);
  const openMenuAt = (pid: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ pid, x: r.left, y: r.bottom + 4 });
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
        <Icon name="list" size={14} /> Browse
      </button>
      {menu && <TabMenu pid={menu.pid} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

// Right-click menu for a transcript tab: pin to the front of the list, or
// rename the file (renameTranscript remaps every pid-keyed slice).
function TabMenu({ pid, x, y, onClose }: { pid: string; x: number; y: number; onClose: () => void }) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const pinned = useStore((s) => s.pinnedTabs.includes(pid));
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(pid);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const commit = () => {
    const e = useStore.getState().renameTranscript(pid, name);
    if (e) setErr(e); else onClose();
  };
  return (
    <div className="ctxmenu" ref={ref} role="menu" aria-label={`Tab ${pid}`}
      style={{ left: Math.min(x, window.innerWidth - 240), top: y, fontSize: fs }}>
      <div className="ctxhead">{pid}</div>
      <button role="menuitem"
        onClick={() => { useStore.getState().togglePinTab(pid); onClose(); }}>
        <Icon name="pin" size={fs + 2} /> {pinned ? "Unpin" : "Pin to front"}
      </button>
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
