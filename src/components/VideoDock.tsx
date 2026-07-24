// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore } from "../state/store";
import { registerVideo, tsToSec, isLooping } from "../video/seek";
import { useDismiss, OVERLAY_SELECTOR } from "../usePopover";
import { Icon } from "./Icon";

// bottom-RIGHT-anchored: expanding/collapsing grows upward and LEFTWARD, so the
// corner holding the expand/collapse button never moves out from under the
// pointer. `r` is the distance from the window's right edge to the dock's.
// (An older persisted geom stored the LEFT edge as `x`; it has no `r`, so those
// users get one reset to the default corner.)
interface Geom { r: number | null; bottom: number | null; w: number; collapsed: boolean; rate: number; }
const DEFAULT: Geom = { r: null, bottom: null, w: 426, collapsed: true, rate: 1 };
const MIN_W = 426; // expanded minimum (collapsed shrinks to its controls) — must match video.css .vdock min-width
// Where an untouched dock rests: bottom right of the transcript surface, clear of
// the minimap and to the LEFT of the focus button's column (the dock is
// bottom-anchored and covers whatever it lands on at z 74, so the default has to
// leave both reachable).
const DEFAULT_BOTTOM = 12;
const DEFAULT_RIGHT = (minimapWidth: number) => minimapWidth + 64;
const DOCK_FS = 16; // the general interface size (matches the Settings modal)
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function loadGeom(): Geom {
  try {
    // pick known keys only (a blind spread carried the obsolete left-edge `x`
    // forward and re-persisted it forever), validate shapes (localStorage is
    // hand-editable; a NaN transform or negative playbackRate throws later),
    // and CONVERT a legacy left-edge position instead of discarding it
    const p = JSON.parse(localStorage.getItem("coding-app-dock") || "{}");
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const w = num(p.w) ? Math.max(MIN_W, p.w) : DEFAULT.w; // old min was 220
    const r = num(p.r) ? p.r
      : num(p.x) ? window.innerWidth - p.x - w // pre-right-anchor geom: same spot, new reference edge
      : DEFAULT.r;
    return {
      r, w,
      bottom: num(p.bottom) ? p.bottom : DEFAULT.bottom,
      collapsed: typeof p.collapsed === "boolean" ? p.collapsed : DEFAULT.collapsed,
      rate: num(p.rate) && p.rate > 0 && p.rate <= 4 ? p.rate : DEFAULT.rate,
    };
  } catch { return DEFAULT; }
}

export function VideoDock() {
  const pid = useStore((s) => s.active);
  const hasTranscript = useStore((s) => !!s.transcripts[s.active]);
  // The dock reads at the interface size (16px), like the Settings modal — not the
  // sidebar setting. video.css is em-based off this, so one number sizes the whole
  // panel: rows, buttons, the speed menu, and the icons below.
  const fs = DOCK_FS;
  const minimapWidth = useStore((s) => s.ui.minimapWidth); // the default rest spot clears it
  const offset = useStore((s) => s.video[s.active]?.offset ?? 0);
  const setOffset = (v: number) =>
    useStore.setState((s) => ({ video: { ...s.video, [pid]: { ...s.video[pid], offset: v } } }));

  const [geom, setGeom] = useState<Geom>(loadGeom);
  const [media, setMedia] = useState<Record<string, { url: string; name: string }>>({});
  const [playing, setPlaying] = useState(false);
  // anchor coords, not a boolean: the menu renders position:fixed at the button's
  // corner because .vdock's overflow:hidden would clip a child that pokes above it.
  // `up` picks the growth direction — a dock dragged near the top of the window
  // would push an upward menu offscreen.
  const [speedMenu, setSpeedMenu] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  // the menu is portaled out of speedRef (see below), so contains() can't claim
  // it — the ignore predicate keeps a mousedown on the menu from closing it
  const inSpeedMenu = useCallback((e: MouseEvent) => !!(e.target as Element | null)?.closest?.(".vspeedmenu"), []);
  const closeSpeedMenu = useCallback(() => setSpeedMenu(null), []);
  useDismiss(speedRef, closeSpeedMenu, { enabled: speedMenu !== null, ignore: inSpeedMenu });
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
    // swallow quota/disabled-storage errors: dock geometry isn't worth an
    // uncaught timer exception (the main store has its own save-failed banner)
    const t = setTimeout(() => { try { localStorage.setItem("coding-app-dock", JSON.stringify(geom)); } catch { /* transient */ } }, 250);
    return () => clearTimeout(t);
  }, [geom]);
  const cur = media[pid];
  // prune object URLs whose transcript is gone (new/open project, closed data):
  // a loaded video would otherwise stay retained for the page's lifetime
  const transcripts = useStore((s) => s.transcripts);
  useEffect(() => {
    setMedia((m) => {
      const dead = Object.keys(m).filter((k) => !transcripts[k]);
      if (!dead.length) return m;
      const next = { ...m };
      for (const k of dead) { URL.revokeObjectURL(next[k].url); delete next[k]; }
      return next;
    });
  }, [transcripts]);
  // keep the seek bridge pointed at the current element + offset
  useEffect(() => { registerVideo(videoRef.current, offset); }, [cur, offset, pid]);
  // the source is about to change (tab switch / new media): ignore the reset-to-0
  // timeupdate that follows, so it can't clobber the position we'll restore on load
  useEffect(() => { switching.current = true; }, [cur?.url]);
  // apply persisted playback rate whenever the source or rate changes — unless a
  // line-edit loop owns the rate right now (it restores the dock's rate on stop)
  useEffect(() => { if (videoRef.current && !isLooping()) videoRef.current.playbackRate = geom.rate; }, [cur, geom.rate]);

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

  // Space: play/pause. [ / ]: step the playback speed down/up. Global — but not
  // while typing (the line editor, any input), not on a focused control (Space
  // must stay "activate button"), and not while a dialog/popover owns the
  // keyboard (same overlay list App.tsx uses).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== " " && e.key !== "[" && e.key !== "]") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"
        || t.tagName === "BUTTON" || t.isContentEditable) return;
      // the focused <video> already handles Space natively — doubling up nets a no-op
      if (t.tagName === "VIDEO" || t.tagName === "A") return;
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      const v = videoRef.current;
      if (!v) return;
      e.preventDefault(); // Space would otherwise page-scroll the focused list
      if (e.key === " ") { v.paused ? void v.play() : v.pause(); return; }
      setGeom((g) => {
        const i = SPEEDS.indexOf(g.rate);
        const at = i < 0 ? SPEEDS.indexOf(1) : i; // a rate not in the list steps from 1×
        const j = e.key === "]" ? Math.min(SPEEDS.length - 1, at + 1) : Math.max(0, at - 1);
        return { ...g, rate: SPEEDS[j] };
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
    if (geom.r === null || geom.bottom === null)
      flushSync(() => setGeom((g) => ({ ...g, r: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom })));
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width;
    const br = window.innerWidth - r.right, bb = window.innerHeight - r.bottom; // where this drag starts from
    // Clamp DURING the drag, with the same bounds the render uses (keep a 60px grab
    // handle on screen) — an unclamped drag with a clamped commit relocated the dock
    // on edge drops.
    let tr = br, tb = bb, raf = 0;
    const move = (ev: MouseEvent) => {
      // dragging right = a smaller right-offset
      tr = Math.max(60 - w0, Math.min(br - (ev.clientX - x0), window.innerWidth - 60));
      tb = Math.max(0, Math.min(bb - (ev.clientY - y0), window.innerHeight - 40));
      // coalesce to one write per frame; a mouse can out-pace the display
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.transform = `translate3d(${-tr}px, ${-tb}px, 0)`;
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      // One task, so no paint can interleave: write the final transform imperatively
      // (a no-op if the last rAF already did), then commit the SAME numbers — React's
      // render re-writes the identical transform string. The compositor sees no change.
      el.style.transform = `translate3d(${-tr}px, ${-tb}px, 0)`;
      flushSync(() => setGeom((g) => ({ ...g, r: tr, bottom: tb })));
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
      // right edge is the anchor, so the handle rides the LEFT edge: drag left = wider
      w = Math.max(MIN_W, Math.min(w0 - (ev.clientX - x0), window.innerWidth - 40));
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

  // Positioned by transform off a right:0/bottom:0 anchor — the same property the
  // drag writes, so drag and rest are one rendering path (see startDrag). The
  // negative translate keeps the BOTTOM-RIGHT corner pinned when collapse/expand
  // changes the height OR width (the corner is where the toggle button lives).
  // Clamped so a drag (or a position persisted from a larger window) can't strand
  // the dock offscreen with no way to grab it back.
  // clamp against the width actually RENDERED: an expanded dock dragged far left
  // (legitimate negative r) that then collapses to ~150px would otherwise sit
  // entirely offscreen, persisted, with nothing left to grab
  const effW = geom.collapsed ? 150 : geom.w;
  const pos = geom.r !== null && geom.bottom !== null
    ? {
        right: 0, bottom: 0, left: "auto" as const, top: "auto" as const,
        transform: `translate3d(${-Math.max(60 - effW, Math.min(geom.r, window.innerWidth - 60))}px, ${
          -Math.max(0, Math.min(geom.bottom, window.innerHeight - 40))}px, 0)`,
      }
    : { right: DEFAULT_RIGHT(minimapWidth), bottom: DEFAULT_BOTTOM };

  return (
    <div className={"vdock" + (geom.collapsed ? " collapsed" : "")}
      style={{
        // collapsed: shrink to the controls (grip + transport + expand), no title —
        // a minimised dock shouldn't cost a filename's width of screen.
        // expanded: floor the width by the text size — magnified chrome in a 380px
        // dock wraps into a three-row jumble. A dragged width wins above the floor.
        width: geom.collapsed ? "auto"
          : Math.min(Math.max(cur ? geom.w : MIN_W, fs * 20, MIN_W), window.innerWidth - 48),
        fontSize: fs, ...pos,
      }}>
      {cur ? (
        <div className="vbody">
          {!geom.collapsed && (
            <div className="vctrl" onMouseDown={startDrag}>
              {/* top control: find the current playback position in the transcript.
                  The strip is also a drag handle (like vhead) — buttons/inputs opt out. */}
              <button className="vbtn accent" onClick={syncToLine}
                title="Select the transcript line playing now, and scroll to it">
                <Icon name="target" size={fs + 2} /> Transcript
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
                <Icon name="reload" size={fs + 2} />
              </button>
            </div>
          )}
          {/* stays mounted when collapsed (0x0) so audio keeps playing but the
              video's dimensions don't affect the collapsed bar's auto width */}
          <video ref={videoRef} src={cur.url} controls disablePictureInPicture aria-label={cur.name}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoaded}
            style={{ width: geom.collapsed ? 0 : "100%", height: geom.collapsed ? 0 : "auto", display: "block", background: "#000" }} />
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
        <span className="vgrip" aria-hidden="true"><Icon name="grip-horizontal" size={fs + 1} /></span>
        {/* minimised with media: controls only — the filename returns on expand.
            With no media the pill keeps a plain "Video" label; a bare grip and
            chevron says nothing about what it is. */}
        {!(geom.collapsed && cur) && <span className="vtitle">{cur ? cur.name : "Video"}</span>}
        <span style={{ flex: 1 }} />
        {cur && (
          <>
            <button className="vbtn playbtn" onClick={togglePlay} title="Play / pause"
              aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} size={fs} />
            </button>
            {/* speed lives in a popover now — ten steps would not fit as pills */}
            <div className="vspeedwrap" ref={speedRef}>
              <button className={"vbtn speed" + (speedMenu ? " on" : "")}
                onClick={(e) => {
                  // rect BEFORE setState: React nulls currentTarget after dispatch,
                  // and the functional updater may run later than the handler
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  // ~1.9em per row + padding: enough headroom above, or open downward
                  const menuH = SPEEDS.length * fs * 1.9 + 16;
                  const up = r.top - 6 - menuH > 8;
                  setSpeedMenu((m) => m ? null : { x: r.right, y: up ? r.top - 6 : r.bottom + 6, up });
                }} title="Playback speed"
                aria-haspopup="menu" aria-expanded={speedMenu !== null}>{geom.rate}×</button>
              {/* PORTALED to body: .vdock is overflow:hidden AND transformed, so a
                  fixed child would position against the dock (not the viewport) and
                  get clipped at its top edge. The dismiss hook's ignore predicate
                  (above) covers the portal. */}
              {speedMenu && createPortal(
                <div className={"vspeedmenu" + (speedMenu.up ? "" : " down")}
                  role="menu" aria-label="Playback speed"
                  style={{ left: speedMenu.x, top: speedMenu.y, fontSize: fs }}>
                  {SPEEDS.map((s) => (
                    <button key={s} role="menuitemradio" aria-checked={geom.rate === s}
                      className={"vspeeditem" + (geom.rate === s ? " on" : "")}
                      onClick={() => { setRate(s); setSpeedMenu(null); }}>
                      {/* the ✓ is the non-colour cue for the current rate — the
                          accent fill alone would be colour-only signalling */}
                      {s}×{geom.rate === s ? " ✓" : ""}</button>
                  ))}
                </div>, document.body)}
            </div>
          </>
        )}
        {/* ghost, not a bordered pill: it's a panel affordance (collapse), and
            looked like a sibling of the speed control when framed the same way */}
        <button className="vbtn icononly ghost" onClick={() => setGeom((g) => ({ ...g, collapsed: !g.collapsed }))}
          title={geom.collapsed ? "Expand" : "Collapse to audio"}>
          <Icon name={geom.collapsed ? "chevron-up" : "chevron-down"} size={fs + 3} />
        </button>
      </div>
      {/* resize lives on the BAR's corner, not over the video picture */}
      {cur && !geom.collapsed && <div className="vresize" onMouseDown={startResize} title="Resize" />}
      <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: "none" }}
        onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
