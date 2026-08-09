// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The session's events as an index. Clicking one scrolls the transcript to where
// the note was made — the list is a way BACK INTO the transcript, not a place to
// read.
//
// Two orders, because a log gets read two ways: BY TYPE (what kinds of thing
// happened, and how often) and BY TIME (what happened next). The choice and the
// list's height persist; which groups you had folded does not — that belongs to the
// transcript you were reading, not to the next study.
import { useMemo, useState } from "react";
import { clampEventHeight, useStore } from "../state/store";
import { useMarkers } from "../useMarkers";
import { fmtLike, markerColor, markerKey, type Marker } from "../markers";
import { openColorPicker } from "../colorPicker";
import { Icon } from "./Icon";

export function EventList({ pid }: { pid: string }) {
  const { list, lineOf, offset, tsSample } = useMarkers(pid);
  const colors = useStore((s) => s.ui.markerColors);
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const height = useStore((s) => s.ui.eventListHeight);
  const sort = useStore((s) => s.ui.eventSort);
  const setUi = useStore((s) => s.setUi);
  const [open, setOpen] = useState(true);
  const [shut, setShut] = useState<string[]>([]); // groups explicitly collapsed

  // by event/code, in first-appearance (i.e. time) order — the order the session ran
  const groups = useMemo(() => {
    const by = new Map<string, Marker[]>();
    for (const m of list) {
      const k = markerKey(m);
      const cur = by.get(k);
      if (cur) cur.push(m); else by.set(k, [m]);
    }
    return [...by.entries()];
  }, [list]);

  if (!list.length) return null;

  const jump = (m: Marker) => {
    const line = lineOf.get(m.mid);
    if (line !== undefined) useStore.getState().jumpTo(pid, line);
  };
  // one row per event: the time leads (it's what you scan), the text is clipped —
  // no tooltip; the click lands you on the full note in the transcript anyway
  const row = (m: Marker, withDot: boolean) => (
    <button key={m.mid} className={"evitem" + (withDot ? " flat" : "")}
      onClick={() => jump(m)}>
      <span className="evtime">{fmtLike(m.t - offset, tsSample)}</span>
      {withDot && <span className="evdot" style={{ background: markerColor(markerKey(m), colors) }} />}
      {/* no note: the type stands in — bracketed italics, as in the transcript row */}
      <span className="evtext">{m.label || <em className="mkempty">({markerKey(m)})</em>}</span>
    </button>
  );

  return (
    <div className="eventList" style={open ? { height: clampEventHeight(height) } : undefined}>
      {/* drag to resize, above the header so it reads as the boundary between the
          codes and the events — same gesture as the sidebar's own edge */}
      {open && <HeightGrip height={height} onHeight={(h) => setUi({ eventListHeight: clampEventHeight(h) })} />}
      <div className="evhead">
        <button className="evheadmain" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "chevron-down" : "chevron-up"} size={fs} />
          <span className="evtitle">Events</span>
          <span className="cnt">{list.length}</span>
        </button>
        {open && (
          <button className="evsort" onClick={() => setUi({ eventSort: sort === "type" ? "time" : "type" })}
            title={sort === "type" ? "Grouped by type — switch to time order" : "In time order — switch to grouping by type"}
            aria-label={sort === "type" ? "Grouped by type. Switch to time order." : "In time order. Switch to grouping by type."}>
            {sort === "type" ? "by type" : "by time"}
          </button>
        )}
      </div>
      {open && (
        <div className="evgroups nicescroll">
          {sort === "time"
            ? list.map((m) => row(m, true))
            : groups.map(([key, ms]) => {
              const closed = shut.includes(key);
              return (
                <div key={key} className="evgroup">
                  <button className="evgrouphead" aria-expanded={!closed}
                    onClick={() => setShut((c) => closed ? c.filter((k) => k !== key) : [...c, key])}>
                    <Icon name={closed ? "chevron-up" : "chevron-down"} size={fs - 1} />
                    <span className="evdot" style={{ background: markerColor(key, colors) }}
                      title="Right-click to recolor"
                      onContextMenu={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        openColorPicker(markerColor(key, colors),
                          (v) => useStore.getState().setMarkerColor(key, v), e.currentTarget);
                      }} />
                    <span className="evname">{key}</span>
                    <span className="cnt">{ms.length}</span>
                  </button>
                  {!closed && ms.map((m) => row(m, false))}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// Horizontal twin of the panel Resizer: drag (or arrow) the top edge to give the
// events list more or less of the sidebar. Reports the height it should become;
// the caller clamps, so a drag past either bound simply stops.
function HeightGrip({ height, onHeight }: { height: number; onHeight: (h: number) => void }) {
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().height;
    const move = (ev: MouseEvent) => onHeight(startH - (ev.clientY - startY)); // drag up = taller
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    <div className="evgrip" role="separator" aria-orientation="horizontal" tabIndex={0}
      aria-label="Resize the events list" onMouseDown={down}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        onHeight(height + (e.key === "ArrowUp" ? 16 : -16));
      }} />
  );
}
