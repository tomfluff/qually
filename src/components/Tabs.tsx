// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../state/store";
import { SCROLL_BASE, wheelPixels } from "../scrollSpeed";
import { useDismiss } from "../usePopover";
import { Icon } from "./Icon";
import { parseCSV } from "../contract/csv";
import { isMarkerRows } from "../markers";
import { announce } from "../announce";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const pinnedTabs = useStore((s) => s.pinnedTabs);
  const active = useStore((s) => s.active);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.sidebarFontSize);
  const setActive = useStore((s) => s.setActive);
  const [menu, setMenu] = useState<{ pid: string; x: number; y: number } | null>(null);
  const [assistMenu, setAssistMenu] = useState<{ x: number; y: number } | null>(null);
  const [reopenMenu, setReopenMenu] = useState<{ x: number; y: number } | null>(null);
  // the × asks first — see CloseConfirm
  const [closing, setClosing] = useState<{ pid: string; x: number; y: number } | null>(null);
  const [dragPid, setDragPid] = useState<string | null>(null);
  // loaded transcripts with no tab: closing one only hid it, so these are all
  // reopenable. The + only exists while there is something to reopen.
  const closed = Object.keys(transcripts).filter((p) => !tabs.includes(p));
  const openMenuAt = (pid: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ pid, x: r.left, y: r.bottom + 4 });
  };
  // The bar scrolls sideways now, so the selected tab can sit off-screen after a
  // keyboard switch, an import, or a reorder. Pull it back into view. The browser
  // already does this when a tab takes FOCUS; selection can move without focus
  // (reopening from the +, closing a neighbour), so it needs its own nudge.
  // inline+block "nearest" scrolls the bar only when the tab is actually outside it
  // and never scrolls the page vertically.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active, tabs]);
  // A vertical wheel over a container that only scrolls sideways does NOT move it in
  // Chrome, so the bar looked scrollable and then ignored the wheel. Translate deltaY
  // into scrollLeft ourselves, at the same pace Settings → scroll distance sets for
  // every other list (installScrollSpeed governs the vertical axis only, and skips
  // this element because its overflow-y is hidden).
  // Native listener, not onWheel: React registers wheel on its root as PASSIVE, so a
  // preventDefault from a React handler is dropped.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // ctrl+wheel is browser zoom; a real horizontal wheel already works natively
      if (e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return;
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const px = wheelPixels(e.deltaY, e.deltaMode, lh, el.clientWidth)
        * SCROLL_BASE * (useStore.getState().ui.scrollSpeed || 1);
      const next = Math.max(0, Math.min(el.scrollLeft + px, max));
      if (next === el.scrollLeft) return; // already at that end — let the wheel through
      e.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const openAssistMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAssistMenu({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <div id="tabs" className="nicescroll" style={{ fontSize }} role="tablist"
      aria-label="Transcripts" ref={stripRef}>
      {/* label and × are real <button>s so the keyboard can switch and close tabs;
          the label's click bubbles to the wrapper's onClick (whole tab stays clickable).
          The wrapper is presentation so the tablist's exposed children are the tab
          buttons themselves (the × stays a plain button — it is not a tab). */}
      {tabs.map((pid) => (
        <div key={pid} className={"tab" + (active === pid ? " active" : "") + (dragPid === pid ? " dragging" : "")}
          role="presentation" onClick={() => setActive(pid)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ pid, x: e.clientX, y: e.clientY }); }}
          // drag to reorder: the list REORDERS LIVE under the pointer (moveTab per
          // dragover), so the drop itself has nothing left to do. Crossing the pin
          // boundary is clamped in the store — pinned tabs keep the front.
          draggable
          onDragStart={(e) => { setDragPid(pid); e.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => setDragPid(null)}
          onDragOver={(e) => {
            if (!dragPid || dragPid === pid) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const before = e.clientX < r.left + r.width / 2;
            let to = tabs.indexOf(pid) + (before ? 0 : 1);
            if (tabs.indexOf(dragPid) < to) to--; // removing the dragged tab shifts the target left
            useStore.getState().moveTab(dragPid, to);
          }}>
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
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setClosing({ pid, x: r.left, y: r.bottom + 4 });
            }}><Icon name="x" size={Math.round(fontSize * 0.85)} /></button>
        </div>
      ))}
      {/* reopen: the closed transcripts are still loaded, one click from the bar */}
      {closed.length > 0 && (
        <button className="tab tabadd" aria-haspopup="menu" aria-expanded={!!reopenMenu}
          title={`Reopen a closed transcript (${closed.length})`}
          aria-label={`Reopen a closed transcript (${closed.length} available)`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setReopenMenu((m) => m ? null : { x: r.left, y: r.bottom + 4 });
          }}>
          <Icon name="plus" size={14} />
        </button>
      )}
      <button className={"tab browsetab" + (active === "browse" ? " active" : "")}
        role="tab" aria-selected={active === "browse"} onClick={() => setActive("browse")}>
        <Icon name="list" size={14} /> Codebook
      </button>
      <button className={"tab browsetab" + (active === "map" ? " active" : "")}
        role="tab" aria-selected={active === "map"} onClick={() => setActive("map")}
        title="Code map: see the whole codebook spatially — select, inspect, merge">
        <Icon name="layout-grid" size={14} /> Map
      </button>
      <button className={"tab browsetab" + (active === "summary" ? " active" : "")}
        role="tab" aria-selected={active === "summary"} onClick={() => setActive("summary")}
        title="Per-transcript session record and summary">
        <Icon name="file-text" size={14} /> Summary
      </button>
      <button className={"tab browsetab" + (active === "notes" ? " active" : "")}
        role="tab" aria-selected={active === "notes"} onClick={() => setActive("notes")}
        title="Project notes: analytic memos with context stamps (N)">
        <Icon name="pencil" size={14} /> Notes
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
      {reopenMenu && <ReopenMenu pids={closed} x={reopenMenu.x} y={reopenMenu.y}
        onClose={() => setReopenMenu(null)} />}
      {closing && <CloseConfirm pid={closing.pid} x={closing.x} y={closing.y}
        onClose={() => setClosing(null)} />}
    </div>
  );
}

// The × asks before it acts. Closing costs no data — the transcript, its coding,
// its events and its summary all stay loaded, and the + on the bar puts it back —
// so this is a confirmation, not a warning, and it says exactly that. What a
// close DOES cost is the tab's selection and scroll position (closeTab drops
// both), which is why a stray click shouldn't be able to spend it.
function CloseConfirm({ pid, x, y, onClose }: { pid: string; x: number; y: number; onClose: () => void }) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const confirm = () => { useStore.getState().closeTab(pid); onClose(); };
  return (
    <div className="ctxmenu" ref={ref} role="dialog" aria-label={`Close ${pid}?`}
      style={{ left: Math.min(x, window.innerWidth - 260), top: y, fontSize: fs }}>
      <div className="ctxhead">Close {pid}?</div>
      <div className="ctxnote">Nothing is deleted — the coding stays, and the <b>+</b> on the tab bar reopens it.</div>
      <div className="ctxform">
        <div className="ctxrow">
          <button className="btn" autoFocus onClick={confirm}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>Close tab</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Every loaded transcript that has no tab. Reopening is a view change (openTab),
// so a transcript closed by accident is one click away rather than a re-import —
// which would have re-run the import machinery over data already in the project.
function ReopenMenu({ pids, x, y, onClose }: {
  pids: string[]; x: number; y: number; onClose: () => void;
}) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="ctxmenu" ref={ref} role="menu" aria-label="Reopen a closed transcript"
      style={{ left: Math.min(x, window.innerWidth - 240), top: y, fontSize: fs }}>
      <div className="ctxhead">Reopen</div>
      {pids.map((p) => (
        <button key={p} role="menuitem"
          onClick={() => { useStore.getState().openTab(p); onClose(); }}>
          <Icon name="file-text" size={fs + 2} /> {p}
        </button>
      ))}
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
  const segCount = useStore((s) => s.segments.filter((x) => x.pid === pid).length);
  const [renaming, setRenaming] = useState(false);
  // deleting a transcript can't be undone (see the store), so the menu asks first
  const [confirming, setConfirming] = useState(false);
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
        <Icon name="upload" size={fs + 2} /> Load events
        {evCount > 0 && <span className="ctxcount">{evCount}</span>}
      </button>
      <input ref={evRef} type="file" accept=".csv,text/csv" hidden
        aria-hidden="true" tabIndex={-1}
        onChange={(e) => { void loadEvents(e.target.files); e.target.value = ""; }} />
      {note && <div className="ctxnote">{note}</div>}
      {/* the rename form shows its own errors inline; this is the events one */}
      {err && !renaming && <div className="ctxerr">{err}</div>}
      {evCount > 0 && (
        <button role="menuitem"
          onClick={() => { useStore.getState().clearMarkers(pid); onClose(); }}>
          <Icon name="trash" size={fs + 2} /> Remove all events ({evCount})
        </button>
      )}
      {!renaming ? (
        <button role="menuitem" onClick={() => setRenaming(true)}>
          <Icon name="pencil" size={fs + 2} /> Rename
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
      <div className="ctxdiv" />
      {!confirming ? (
        <button className="danger" role="menuitem" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={fs + 2} /> Delete transcript
        </button>
      ) : (
        <div className="ctxform">
          {/* spell out what goes: closing a tab looks the same and keeps everything,
              so the two have to be told apart before the irreversible one runs */}
          <div className="ctxnote">
            Delete <b>{pid}</b> and everything on it
            {segCount > 0 && <> — {segCount} coding{segCount === 1 ? "" : "s"}</>}
            {evCount > 0 && <>{segCount > 0 ? "," : " —"} {evCount} event{evCount === 1 ? "" : "s"}</>}
            ? This can't be undone. To just clear it off the bar, close the tab instead.
          </div>
          <div className="ctxrow">
            <button className="btn danger" autoFocus
              onClick={() => { useStore.getState().deleteTranscript(pid); onClose(); }}>Delete</button>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
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
  { id: "observations", label: "Observations", hint: "AI observations to triage into codes" },
  { id: "merge", label: "Merge codes", hint: "near-duplicate codes to fold together" },
  { id: "describe", label: "Definitions", hint: "AI-drafted code definitions from your excerpts" },
  { id: "suggest", label: "Suggest codes", hint: "candidate codings from your codebook" },
  { id: "summary", label: "Transcript summary", hint: "AI-drafted session summaries to edit and own" },
  { id: "ask", label: "Ask", hint: "questions answered from your codes, excerpts and events" },
  { id: "decisions", label: "Decisions", hint: "what you decided about the codebook, and why" },
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
