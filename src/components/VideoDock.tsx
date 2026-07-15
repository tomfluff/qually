import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useStore } from "../state/store";
import { registerVideo, tsToSec } from "../video/seek";
import { Icon } from "./Icon";

// bottom-anchored so expanding/collapsing grows and shrinks upward
interface Geom { x: number | null; bottom: number | null; w: number; collapsed: boolean; rate: number; }
const DEFAULT: Geom = { x: null, bottom: null, w: 380, collapsed: true, rate: 1 };
const SPEEDS = [0.75, 1, 1.5, 2];

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    const el = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
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

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = geom.w;
    const move = (ev: MouseEvent) => setGeom((g) => ({ ...g, w: Math.max(220, w0 + (ev.clientX - x0)) }));
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
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
            <div className="vctrl">
              {/* top control: find the current playback position in the transcript */}
              <button className="vbtn accent" onClick={syncToLine}
                title="Select the transcript line playing now, and scroll to it">
                <Icon name="target" size={15} /> Jump to line
              </button>
              <span style={{ flex: 1 }} />
              <span className="vlabel">Offset</span>
              <div className="stepper">
                <button onClick={() => setOffset(offset - 1)} title="−1s">−</button>
                <input type="number" step={1} value={offset} onChange={(e) => setOffset(+e.target.value || 0)} />
                <button onClick={() => setOffset(offset + 1)} title="+1s">+</button>
              </div>
              <span className="unit">s</span>
              <button className="vbtn icononly" onClick={() => fileRef.current?.click()} title="Change media">
                <Icon name="upload" size={15} />
              </button>
            </div>
          )}
          {/* stays mounted when collapsed (0x0) so audio keeps playing but the
              video's dimensions don't affect the collapsed bar's auto width */}
          <video ref={videoRef} src={cur.url} controls
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
        <span className="vtitle">{cur ? cur.name : `video · ${pid}`}</span>
        <span style={{ flex: 1 }} />
        {cur && (
          <>
            <button className="vbtn icononly" onClick={togglePlay} title="Play / pause">
              <Icon name={playing ? "pause" : "play"} size={15} />
            </button>
            <div className="vspeeds">
              {SPEEDS.map((s) => (
                <button key={s} className={"vbtn speed" + (geom.rate === s ? " on" : "")}
                  onClick={() => setRate(s)} title={`${s}× speed`}>{s}×</button>
              ))}
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
