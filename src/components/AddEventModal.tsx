// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Add a session event by hand — right-click a line, E on the selection, or, with
// media loaded, the video dock's Mark button / bare E (then the time is the
// playhead and the card anchors to the dock: anchorSel is a selector, not a line
// id, precisely so the same card can hang off either surface). Opens
// as a card anchored to where you were looking, not a dimmed modal: you are
// still reading the transcript. The
// time arrives prefilled to the clicked line's END (next line's start − 1s), so
// the event lands after that line; it stays editable because "after this line" is
// a starting point, not the recorded moment.
//
// The time field is on the TRANSCRIPT clock — the one every chip on screen shows —
// and converts to the video clock (+ offset) only at save, mirroring how imported
// times convert the other way for display.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../state/store";
import { fmtLike, markerColor, markerKey, type Marker } from "../markers";
import { tsToSec } from "../video/seek";
import { fuzzy } from "./CodeCombobox";

import { GAP, widthFor } from "./CommandPalette"; // the palette's sizing — one anchored-card family
const chromeFor = (fs: number) => Math.round(fs * 14.5); // hint + note + meta row + button

export function AddEventModal({ pid, defaultT, marker, tsSample, anchorSel, onClose }: {
  pid: string;
  defaultT: number;                // transcript-clock seconds (prefill for a NEW event)
  marker?: Marker;                 // present = edit this event instead of adding one
  tsSample: string | undefined;    // a real line's timecode — the format to prefill in
  anchorSel?: string;              // the row this was opened from; absent = centered
  onClose: () => void;
}) {
  const offset = useStore((s) => s.video[pid]?.offset ?? 0);
  // The panel ramp, not the reading one. This is a flow surface — you open it
  // mid-session, type a line, and get back out — so it belongs with the code
  // palette and the sidebar's events list, which is where the note gets read
  // back. .about pins itself to 1rem (it opens from the 12px toolbar and has to
  // re-base), so without this override the setting would do nothing here.
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const [time, setTime] = useState(fmtLike(marker ? marker.t - offset : defaultT, tsSample));
  const [type, setType] = useState(marker ? markerKey(marker) : "");
  const [text, setText] = useState(marker?.label ?? "");
  const [err, setErr] = useState<string | null>(null);

  // Escape closes from ANYWHERE, document-level and capture-phase: the card has
  // no focus trap, so Tab can walk out of it, and the dialog's own onKeyDown then
  // never hears the key (App's overlay branch would swallow it instead). The one
  // exception is the type combobox's open list — its own Escape closes just the
  // list, so this handler stands down while the list is up.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".addev .acList")) return;
      e.stopPropagation(); onClose();
    };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [onClose]);

  // Anchored to the row it was opened from, like the code palette: an event is
  // written about a line you are looking at, so the card opens beside that line
  // instead of throwing a dimmed overlay over the transcript. Falls back to a
  // centered dialog when the row is off screen or neither side has room.
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const w = widthFor(fs);
  useLayoutEffect(() => {
    const el = anchorSel ? document.querySelector<HTMLElement>(anchorSel) : null;
    if (!el) { setPos(null); return; }
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { setPos(null); return; } // scrolled away
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = window.innerHeight - (r.bottom + GAP), above = r.top - GAP;
    if (Math.max(below, above) < chromeFor(fs)) { setPos(null); return; }
    setPos(below >= above
      ? { top: r.bottom + GAP, left }
      : { bottom: window.innerHeight - r.top + GAP, left });
  }, [anchorSel, fs, w]);
  const anchored = pos !== null;

  const save = () => {
    const sec = time.trim() ? tsToSec(time) : null;
    if (sec === null) { setErr("Time must look like 24:53 or 0:24:53."); return; }
    if (marker) useStore.getState().updateMarker(marker.mid, { t: sec + offset, code: type, label: text });
    else useStore.getState().addMarker(pid, { t: sec + offset, code: type, label: text });
    onClose();
  };

  // a stray click must not eat a half-typed note: outside-click cancels only
  // while the card is still empty; after that, Esc and the button are the exits
  const safeClose = () => { if (!text.trim()) onClose(); };

  return (
    <div className={"about-backdrop addev-back" + (anchored ? " anchored" : "")} onMouseDown={safeClose}>
      {/* No title bar and no Cancel button: the hint line says what this is and how
          to leave, which is what the code palette does with the same two lines of
          chrome. Esc and a click outside both cancel; the one button commits, for
          the mouse. */}
      {/* aria-modal even when anchored: the backdrop makes it pointer-modal, and
          saying otherwise to assistive tech would be a lie */}
      <div className={"about imp addev" + (anchored ? " addev-anchored" : "")}
        role="dialog" aria-modal={true}
        aria-label={marker ? "Edit event" : "Add event"}
        style={{
          fontSize: fs,
          ...(anchored ? { position: "fixed", left: pos!.left, top: pos!.top, bottom: pos!.bottom, width: w } : null),
        } as CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Escape is handled document-level above (capture), so it works even
          // after focus walks out of the card.
          // isComposing: an IME's confirm-candidate Enter must never save — it
          // would persist a Japanese note truncated mid-word.
          // Enter commits from anywhere, the note included — it is one line of prose
          // far more often than it is a paragraph. Shift+Enter still breaks the line.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
        }}>
        <div className="addev-hint">
          {marker ? "Editing event" : "New event"}
          <span className="addev-keys"><kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel</span>
        </div>
        {/* the NOTE leads and takes focus: it is the only field you always fill in.
            Time arrives prefilled from the line, and the type is often left blank. */}
        <textarea className="signinput addev-text" rows={3} value={text} autoFocus
          aria-label="The note" placeholder="what you observed…"
          onChange={(e) => setText(e.target.value)} />
        {/* labeled: "custom" in a bare box and a bare timecode were two mystery
            fields to anyone seeing the card cold */}
        <div className="addev-meta">
          <label className="addev-field"><span className="addev-lab">Type</span>
            <TypeCombobox value={type} onChange={setType} />
          </label>
          <label className="addev-field addev-field-time"><span className="addev-lab">Time</span>
            <input className="signinput addev-time" value={time}
              aria-label="Event time, on the transcript clock"
              aria-invalid={err !== null} aria-describedby={err ? "addev-err" : undefined}
              onChange={(e) => { setTime(e.target.value); setErr(null); }} />
          </label>
        </div>
        {err && <div className="ctxerr" id="addev-err" role="alert">{err}</div>}
        <button className="btn primary addev-go" onClick={save}>{marker ? "Save" : "Add event"}</button>
      </div>
    </div>
  );
}

// The type field, in the code combobox's clothes: same fuzzy match, same list
// markup (swatch · name · count), same keyboard loop — one autocomplete design
// across the app, not two. Differences are only in the data: types instead of
// codes, and picking fills the field rather than applying anything.
function TypeCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const markers = useStore((s) => s.markers);
  const colors = useStore((s) => s.ui.markerColors);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastPt = useRef({ x: -1, y: -1 });

  // every type in use, with its count — most-used first, like the hotbar thinks
  const types = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of markers) { const k = markerKey(m); n.set(k, (n.get(k) ?? 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [markers]);

  const query = value.trim();
  const matches = types.filter(([t]) => fuzzy(query, t));
  const exact = types.some(([t]) => t.toLowerCase() === query.toLowerCase());
  const entries = [
    ...matches.map(([name, count]) => ({ type: "pick" as const, name, count })),
    ...(query && !exact ? [{ type: "create" as const, name: query, count: 0 }] : []),
  ];
  const showList = open && entries.length > 0;

  const choose = (name: string) => { onChange(name); setOpen(false); setHl(0); };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // an IME's confirm-Enter is not a pick
    if (!showList) return; // nothing open: let Enter save the modal, Esc close it
    if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, entries.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const en = entries[Math.min(hl, entries.length - 1)]; if (en) choose(en.name); }
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className="newCodeWrap addev-typewrap">
      <input className="signinput" value={value} placeholder="custom" autoComplete="off"
        role="combobox" aria-expanded={showList} aria-controls="addev-types" aria-autocomplete="list"
        aria-label="Event type — pick an existing one or write a new one"
        aria-activedescendant={showList ? `addev-types-${hl}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHl(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey} />
      {showList && (
        <div className="acList nicescroll" ref={listRef} role="listbox" id="addev-types">
          {entries.map((en, i) => (
            <div key={en.type + en.name} className={"acItem" + (i === hl ? " hl" : "")}
              role="option" id={`addev-types-${i}`} aria-selected={i === hl}
              onMouseDown={(e) => { e.preventDefault(); choose(en.name); }}
              onMouseMove={(e) => {
                if (e.clientX === lastPt.current.x && e.clientY === lastPt.current.y) return;
                lastPt.current = { x: e.clientX, y: e.clientY };
                setHl(i);
              }}>
              {en.type === "pick" ? (
                <>
                  <span className="swatch" style={{ background: markerColor(en.name, colors) }} />
                  <span className="acName">{en.name}</span>
                  <span className="cnt">{en.count}</span>
                </>
              ) : (
                <span className="acCreate">New type “{en.name}”</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
