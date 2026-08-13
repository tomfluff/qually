// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Add a session event by hand — right-click a line (or E on the selection). The
// time arrives prefilled to the clicked line's END (next line's start − 1s), so
// the event lands after that line; it stays editable because "after this line" is
// a starting point, not the recorded moment.
//
// The time field is on the TRANSCRIPT clock — the one every chip on screen shows —
// and converts to the video clock (+ offset) only at save, mirroring how imported
// times convert the other way for display.
import { useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { fmtLike, markerColor, markerKey, type Marker } from "../markers";
import { tsToSec } from "../video/seek";
import { fuzzy } from "./CodeCombobox";
import { Icon } from "./Icon";

export function AddEventModal({ pid, defaultT, marker, tsSample, onClose }: {
  pid: string;
  defaultT: number;                // transcript-clock seconds (prefill for a NEW event)
  marker?: Marker;                 // present = edit this event instead of adding one
  tsSample: string | undefined;    // a real line's timecode — the format to prefill in
  onClose: () => void;
}) {
  const offset = useStore((s) => s.video[pid]?.offset ?? 0);
  // An event is transcript content — it renders as a row in the transcript at the
  // reading size, so it is written at that size too. .about pins itself to 1rem
  // (it opens from the 12px toolbar and has to re-base), which left this dialog
  // the one place the text-size setting did nothing.
  const fs = useStore((s) => s.ui.fontSize);
  const [time, setTime] = useState(fmtLike(marker ? marker.t - offset : defaultT, tsSample));
  const [type, setType] = useState(marker ? markerKey(marker) : "");
  const [text, setText] = useState(marker?.label ?? "");
  const [err, setErr] = useState<string | null>(null);

  const save = () => {
    const sec = time.trim() ? tsToSec(time) : null;
    if (sec === null) { setErr("Time must look like 24:53 or 0:24:53."); return; }
    if (marker) useStore.getState().updateMarker(marker.mid, { t: sec + offset, code: type, label: text });
    else useStore.getState().addMarker(pid, { t: sec + offset, code: type, label: text });
    onClose();
  };

  return (
    <div className="about-backdrop" onMouseDown={onClose}>
      <div className="about imp addev" role="dialog" aria-modal="true" aria-labelledby="addev-title"
        style={{ fontSize: fs }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "TEXTAREA") {
            e.preventDefault(); save();
          }
        }}>
        <div className="about-head">
          <h2 id="addev-title">{marker ? "Edit event" : "Add event"}</h2>
          <button className="btn iconbtn" onClick={onClose} title="Cancel (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
        <label className="signfield"><span>Time</span>
          <input className="signinput addev-time" value={time} autoFocus
            aria-label="Event time, on the transcript clock"
            onChange={(e) => { setTime(e.target.value); setErr(null); }} />
        </label>
        <label className="signfield"><span>Type</span>
          <TypeCombobox value={type} onChange={setType} />
        </label>
        <label className="signfield addev-textfield"><span>Text</span>
          <textarea className="signinput addev-text" rows={3} value={text}
            aria-label="The note" placeholder="what you observed…"
            onChange={(e) => setText(e.target.value)} />
        </label>
        {err && <div className="ctxerr">{err}</div>}
        <div className="imp-actions">
          <button className="btn primary" onClick={save}>{marker ? "Save" : "Add event"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
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
