// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore } from "../state/store";
import { registerVideo, tsToSec } from "../video/seek";
import { useDismiss } from "../usePopover";
import { Icon } from "./Icon";

// bottom-anchored so expanding/collapsing grows and shrinks upward
interface Geom { x: number | null; bottom: number | null; w: number; collapsed: boolean; rate: number; }
const DEFAULT: Geom = { x: null, bottom: null, w: 380, collapsed: true, rate: 1 };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function loadGeom(): Geom {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem("coding-app-dock") || "{}") }; }
  catch { return DEFAULT; }
}

export function VideoDock() {
  const pid = useStore((s) => s.active);
  const hasTranscript = useStore((s) => !!s.transcripts[s.active]);
  const offset = useStore((s) => s.video[s.active]?.offset ?? 0);
  const setOffset = (v: number) =>
    useStore.setState((s) => ({ video: { ...s.video, [pid]: { ...s.video[pid], offset: v } } }));

  const [geom, setGeom] = useState<Geom>(loadGeom);
  const [media, setMedia] = useState<Record<string, { url: string; name: string }>>({});
  const [playing, setPlaying] = useState(false);
  // anchor coords, not a boolean: the menu renders position:fixed at the button's
  // corner because .vdock's overflow:hidden would clip a child that pokes above it
  const [speedMenu, setSpeedMenu] = useState<{ x: number; y: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  // the menu is portaled out of speedRef (see below), so contains() can't claim
  // it — the ignore predicate keeps a mousedown on the menu from closing it
  const inSpeedMenu = useCallback((e: MouseEvent) => !!(e.target as Element | null)?.closest?.(".vspeedmenu"), []);
  useDismiss(speedRef, () => setSpeedMenu(null), { enabled: speedMenu !== null, ignore: inSpeedMenu });
  // Where each tab's media was last at. One <video> element serves every tab, so switching
  // tabs swaps its src and resets currentTime to 0 — this remembers each tab's position so
  // returning to it resumes where you left off. `switching` guards the reset: on a source
  // change the browser fires a timeupdate at 0, which would otherwise overwrite the very
  // position we're about to restore.
  const lastTime = useRef<Record<string, number>>({});
  const switching = useRef(false);

  // Debounced: geom changes on every mousemove of a drag, and localStorage.setItem is
  // SYNCHRONOUS — it takes a lock over the whole origin's storage. Writing it ~60×/sec
  // put disk I/O on the drag's critical path. The dock's position isn't worth one write
  // per frame; one write once you let go is plenty.
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem("coding-app-dock", JSON.stringify(geom)), 250);
    return () => clearTimeout(t);
  }, [geom]);
  const cur = media[pid];
  // keep the seek bridge pointed at the current element + offset
  useEffect(() => { registerVideo(videoRef.current, offset); }, [cur, offset, pid]);
  // the source is about to change (tab switch / new media): ignore the reset-to-0
  // timeupdate that follows, so it can't clobber the position we'll restore on load
  useEffect(() => { switching.current = true; }, [cur?.url]);
  // apply persisted playback rate whenever the source or rate changes
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = geom.rate; }, [cur, geom.rate]);

  // The clamp in `pos` only runs while rendering, and nothing re-renders on a window
  // resize — so shrinking the window left the dock at its old transform, stranded
  // offscreen with no way to grab it back. Nudge state so the clamp gets to do its job.
  // MUST live above the early return below: hooks cannot be conditional, and this one
  // sitting after it meant the Browse tab ran 20 hooks and a transcript tab 21.
  useEffect(() => {
    const onResize = () => setGeom((g) => ({ ...g }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (pid === "browse" || !hasTranscript) return null;

  const pickMedia = (f: File | undefined) => {
    if (!f) return;
    setMedia((m) => {
      if (m[pid]) URL.revokeObjectURL(m[pid].url);
      return { ...m, [pid]: { url: URL.createObjectURL(f), name: f.name } };
    });
  };

  // The dock is positioned by TRANSFORM, permanently (see `pos` below) — the drag and
  // the resting state share one rendering path. Two earlier attempts each fixed part
  // of a drop flicker and left a remainder:
  //   1. setGeom-per-mousemove: ~60 React renders/sec re-laying-out a fixed panel with
  //      a 34px blur shadow — the drag was sluggish.
  //   2. transform during the drag, left/bottom at rest: numerically seamless (the
  //      committed position matched the last painted one exactly), yet a one-frame
  //      flash survived on real GPUs, because the drop still SWITCHED RENDERING MODES
  //      (transform -> layout), which re-rasterizes the panel.
  // Now the drop writes the same property with the same value the drag just wrote.
  // There is no handoff left to flicker.
  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) return;
    // closest, not parentElement: both bars drag now (vhead sits on .vdock, vctrl on .vbody)
    const el = (e.currentTarget as HTMLElement).closest(".vdock") as HTMLElement;
    const r = el.getBoundingClientRect();
    // If the dock has never been dragged it sits on the CSS default (right:24/bottom:24)
    // with no transform. Convert to transform positioning NOW, before any movement —
    // same place, so nothing visibly changes, and every later write is absolute.
    if (geom.x === null || geom.bottom === null)
      flushSync(() => setGeom((g) => ({ ...g, x: r.left, bottom: window.innerHeight - r.bottom })));
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width;
    const bx = r.left, bb = window.innerHeight - r.bottom; // where this drag starts from
    // Clamp DURING the drag, with the same bounds the render uses (keep a 60px grab
    // handle on screen) — an unclamped drag with a clamped commit relocated the dock
    // on edge drops.
    let tx = bx, tb = bb, raf = 0;
    const move = (ev: MouseEvent) => {
      tx = Math.max(60 - w0, Math.min(bx + (ev.clientX - x0), window.innerWidth - 60));
      tb = Math.max(0, Math.min(bb - (ev.clientY - y0), window.innerHeight - 40));
      // coalesce to one write per frame; a mouse can out-pace the display
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.transform = `translate3d(${tx}px, ${-tb}px, 0)`;
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      // One task, so no paint can interleave: write the final transform imperatively
      // (a no-op if the last rAF already did), then commit the SAME numbers — React's
      // render re-writes the identical transform string. The compositor sees no change.
      el.style.transform = `translate3d(${tx}px, ${-tb}px, 0)`;
      flushSync(() => setGeom((g) => ({ ...g, x: tx, bottom: tb })));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // Resize like the drag: imperative writes during the gesture, ONE commit on release.
  // The old version setGeom'd on every mousemove — ~60 full re-renders/sec of this whole
  // dock (video element and all) plus reconciliation, which is what made it sluggish.
  // Width is a layout property so the panel still reflows per frame, but that is far
  // cheaper than a React render each frame, and it's rAF-coalesced to one write per frame.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest(".vdock") as HTMLElement;
    const x0 = e.clientX, w0 = geom.w;
    let w = w0, raf = 0;
    const move = (ev: MouseEvent) => {
      w = Math.max(220, Math.min(w0 + (ev.clientX - x0), window.innerWidth - 40));
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.style.width = `${w}px`; });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      el.style.width = `${w}px`;
      flushSync(() => setGeom((g) => ({ ...g, w })));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };

  const togglePlay = () => { const v = videoRef.current; if (!v) return; v.paused ? void v.play() : v.pause(); };
  const setRate = (rate: number) => setGeom((g) => ({ ...g, rate }));

  // remember this tab's position as it plays; restore it when its source loads
  const onTimeUpdate = () => { const v = videoRef.current; if (v && !switching.current) lastTime.current[pid] = v.currentTime; };
  const onLoaded = () => {
    const v = videoRef.current; if (!v) return;
    const t = lastTime.current[pid];
    if (t != null && t > 0.05) v.currentTime = t;
    switching.current = false;
  };

  // Feature: jump the transcript to whatever is playing now. The line's position in the
  // video is tsToSec(line.ts) + offset; the line being spoken is the last one whose video
  // start is at or before the playhead. Select it (undoable) and scroll it into view.
  const syncToLine = () => {
    const v = videoRef.current; if (!v) return;
    const t = v.currentTime;
    const lines = useStore.getState().transcripts[pid]?.lines ?? [];
    let best = -1, bestT = -Infinity;
    for (const l of lines) {
      const s = tsToSec(l.ts);
      if (s === null) continue;
      const vt = s + offset;
      if (vt <= t + 0.001 && vt > bestT) { bestT = vt; best = l.id; }
    }
    if (best < 0) best = lines[0]?.id ?? -1; // before the first timed line
    if (best < 0) return;
    const st = useStore.getState();
    st.pushSelUndo(); st.startSelection(best); st.endSelGesture();
    st.scrollToLine(best);
  };

  // Positioned by transform off a left:0/bottom:0 anchor — the same property the drag
  // writes, so drag and rest are one rendering path (see startDrag). translateY is
  // negative-up from the bottom anchor, which keeps the BOTTOM edge pinned when
  // collapse/expand changes the height. Clamped so a drag (or a position persisted
  // from a larger window) can't strand the dock offscreen with no way to grab it back.
  const pos = geom.x !== null && geom.bottom !== null
    ? {
        left: 0, bottom: 0, right: "auto" as const, top: "auto" as const,
        transform: `translate3d(${Math.max(60 - geom.w, Math.min(geom.x, window.innerWidth - 60))}px, ${
          -Math.max(0, Math.min(geom.bottom, window.innerHeight - 40))}px, 0)`,
      }
    : { right: 24, bottom: 24 };

  return (
    <div className={"vdock" + (geom.collapsed ? " collapsed" : "")}
      style={{ width: cur ? geom.w : 260, ...pos }}>
      {cur ? (
        <div className="vbody">
          {!geom.collapsed && (
            <div className="vctrl" onMouseDown={startDrag}>
              {/* top control: find the current playback position in the transcript.
                  The strip is also a drag handle (like vhead) — buttons/inputs opt out. */}
              <button className="vbtn accent" onClick={syncToLine}
                title="Select the transcript line playing now, and scroll to it">
                <Icon name="target" size={15} /> Jump to line
              </button>
              <span style={{ flex: 1 }} />
              <span className="vlabel">Offset</span>
              <div className="stepper">
                <button onClick={() => setOffset(offset - 1)} title="−1s" aria-label="Decrease offset by 1 second">−</button>
                <input type="number" step={1} value={offset} aria-label="Offset in seconds"
                  onChange={(e) => setOffset(+e.target.value || 0)} />
                <button onClick={() => setOffset(offset + 1)} title="+1s" aria-label="Increase offset by 1 second">+</button>
              </div>
              <span className="unit">s</span>
              <button className="vbtn icononly" onClick={() => fileRef.current?.click()} title="Change media">
                <Icon name="upload" size={15} />
              </button>
            </div>
          )}
          {/* stays mounted when collapsed (0x0) so audio keeps playing but the
              video's dimensions don't affect the collapsed bar's auto width */}
          <video ref={videoRef} src={cur.url} controls aria-label={cur.name}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoaded}
            style={{ width: geom.collapsed ? 0 : "100%", height: geom.collapsed ? 0 : "auto", display: "block", background: "#000" }} />
          {!geom.collapsed && <div className="vresize" onMouseDown={startResize} title="resize (keeps aspect)" />}
        </div>
      ) : (!geom.collapsed && (
        <div className="vbody">
          <div className="vempty">
            <div>No media loaded for {pid}.</div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => fileRef.current?.click()}>Choose video/audio…</button>
          </div>
        </div>
      ))}

      <div className="vhead" onMouseDown={startDrag}>
        <span className="vgrip" aria-hidden="true"><Icon name="grip-horizontal" size={14} /></span>
        <span className="vtitle">{cur ? cur.name : `video · ${pid}`}</span>
        <span style={{ flex: 1 }} />
        {cur && (
          <>
            <button className="vbtn playbtn" onClick={togglePlay} title="Play / pause"
              aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} size={13} />
            </button>
            {/* speed lives in a popover now — ten steps would not fit as pills */}
            <div className="vspeedwrap" ref={speedRef}>
              <button className={"vbtn speed" + (speedMenu ? " on" : "")}
                onClick={(e) => {
                  // rect BEFORE setState: React nulls currentTarget after dispatch,
                  // and the functional updater may run later than the handler
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSpeedMenu((m) => m ? null : { x: r.right, y: r.top - 6 });
                }} title="Playback speed"
                aria-haspopup="menu" aria-expanded={speedMenu !== null}>{geom.rate}×</button>
              {/* PORTALED to body: .vdock is overflow:hidden AND transformed, so a
                  fixed child would position against the dock (not the viewport) and
                  get clipped at its top edge. The dismiss hook's ignore predicate
                  (above) covers the portal. */}
              {speedMenu && createPortal(
                <div className="vspeedmenu" role="menu" aria-label="Playback speed"
                  style={{ left: speedMenu.x, top: speedMenu.y }}>
                  {SPEEDS.map((s) => (
                    <button key={s} role="menuitemradio" aria-checked={geom.rate === s}
                      className={"vspeeditem" + (geom.rate === s ? " on" : "")}
                      onClick={() => { setRate(s); setSpeedMenu(null); }}>{s}×</button>
                  ))}
                </div>, document.body)}
            </div>
          </>
        )}
        <button className="vbtn icononly" onClick={() => setGeom((g) => ({ ...g, collapsed: !g.collapsed }))}
          title={geom.collapsed ? "Expand" : "Collapse to audio"}>
          <Icon name={geom.collapsed ? "chevron-up" : "chevron-down"} size={16} />
        </button>
      </div>
      <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: "none" }}
        onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
