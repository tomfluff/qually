// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore, isTranscriptView } from "../state/store";
import { registerVideo, tsToSec, isLooping, playheadSec } from "../video/seek";
import { useDismiss, OVERLAY_SELECTOR } from "../usePopover";
import { Icon } from "./Icon";

// bottom-RIGHT-anchored: expanding/collapsing grows upward and LEFTWARD, so the
// corner holding the expand/collapse button never moves out from under the
// pointer. `r` is the distance from the window's right edge to the dock's.
// (An older persisted geom stored the LEFT edge as `x`; it has no `r`, so those
// users get one reset to the default corner.)
interface Geom { r: number | null; bottom: number | null; w: number; collapsed: boolean; rate: number; }
const DEFAULT: Geom = { r: null, bottom: null, w: 220, collapsed: true, rate: 1 };
const MIN_W = 220; // expanded minimum (collapsed shrinks to its controls) — must match video.css .vdock min-width
// Where an untouched dock rests: bottom right of the transcript surface, clear of
// the minimap and to the LEFT of the focus button's column (the dock is
// bottom-anchored and covers whatever it lands on at z 74, so the default has to
// leave both reachable).
const DEFAULT_BOTTOM = 45;
const DEFAULT_RIGHT = (minimapWidth: number) => minimapWidth + 84;
const DOCK_FS = 12.4; // the dock's base size — video.css is em-based off this one number
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
  const onTranscript = isTranscriptView(pid) && hasTranscript;
  // Fixed size, not the sidebar setting — DOCK_FS sizes the whole panel: rows,
  // buttons, the speed menu, and the icons below.
  const fs = DOCK_FS;
  const minimapWidth = useStore((s) => s.ui.minimapWidth); // the default rest spot clears it
  // WHICH transcript's media the dock's one <video> element is playing.
  //
  // Normally the active transcript (and the last one you were on, while you're
  // off in Codebook/Summary/Assist). But a floating video PINS it: popping out
  // means "keep this on my other screen while I work", and that has to survive
  // every tab change, including switching to a transcript with no media of its
  // own. Unmounting the element leaves the browser holding a DETACHED orphan —
  // the window keeps showing a video no control can reach, and the leave event
  // never arrives (a detached node's events don't reach the document), so the
  // toggle stayed lit over a window that wasn't there.
  const [pipPid, setPipPid] = useState("");
  // The user's INTENT, which outlives the window itself: once PiP is turned on,
  // every transcript with media should float. Landing on one WITHOUT media has
  // to close the window (its dock owns no video) — but that exit isn't the user
  // changing their mind, so the intent stays and the next transcript with media
  // re-enters PiP. Only the user's own exits (our toggle, the window's ×/back)
  // clear it. A ref, not state: nothing renders from it.
  const pipWant = useRef(false);
  const lastTab = useRef("");
  useEffect(() => { if (onTranscript) lastTab.current = pid; }, [onTranscript, pid]);
  const [media, setMedia] = useState<Record<string, { url: string; name: string }>>({});
  const wantPid = onTranscript ? pid : lastTab.current;
  // The pin is the FALLBACK, not an override: a transcript with its own media
  // takes the element (swapping src keeps the floating window — PiP follows the
  // element, not the source, so it simply starts showing this transcript). The
  // pin only holds OFF transcripts (Codebook/Summary/Assist). A transcript
  // WITHOUT media doesn't hold the float: its dock owns no video, so its
  // controls would drive a picture belonging to another tab — instead the
  // element unmounts and the render-time syncPip below closes the window.
  const vidPid = media[wantPid] ? wantPid : (!onTranscript && pipPid ? pipPid : wantPid);
  const offset = useStore((s) => s.video[vidPid]?.offset ?? 0);
  // keyed to the media on screen, which is the transcript the offset belongs to
  const setOffset = (v: number) =>
    useStore.setState((s) => ({ video: { ...s.video, [vidPid]: { ...s.video[vidPid], offset: v } } }));

  const [geom, setGeom] = useState<Geom>(loadGeom);
  const [playing, setPlaying] = useState(false);
  const [pip, setPip] = useState(false); // the video floats in a picture-in-picture window
  const [time, setTime] = useState(0);   // playhead, for the head's timecode
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
  const cur = media[vidPid];
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
  // Keep the seek bridge pointed at the current element + offset. Runs after
  // EVERY render, like syncPip below and for the same reason: leaving a
  // transcript unmounts the <video> (the early return at the bottom) without
  // changing cur/offset/vidPid, so a dep list left the bridge holding a
  // detached node — timecode chips and the line-editor repair loop then drove
  // an invisible element while the one on screen never moved.
  useEffect(() => { registerVideo(videoRef.current, offset, vidPid); });
  // the source is about to change (tab switch / new media): ignore the reset-to-0
  // timeupdate that follows, so it can't clobber the position we'll restore on load
  useEffect(() => { switching.current = true; }, [cur?.url]);
  // Apply the persisted playback rate — unless a line-edit loop owns the rate
  // right now (it restores the dock's rate on stop). Every render, not on
  // [cur, geom.rate]: a remounted <video> defaults to 1× while the button and
  // the speed menu still claim 1.75×.
  useEffect(() => { if (videoRef.current && !isLooping()) videoRef.current.playbackRate = geom.rate; });
  // PiP is entered and left from several places — our button, the video's own
  // native control, the floating window's × and back-to-tab, and the browser
  // itself. The button can only mirror that if it reads the truth rather than
  // its own last click, so the state is DERIVED, never remembered: the floating
  // element must be the one this dock is holding.
  //
  // Runs after EVERY render, not just on the events. Events alone were not
  // enough: a video removed from the document takes its leave event with it (a
  // detached node's events never reach the listener), which is precisely the
  // case that left a lit toggle over a window that was gone. Re-deriving costs
  // one identity comparison, and React drops the re-render when nothing moved.
  // The document listeners stay for the transitions that happen while nothing
  // else is re-rendering.
  const syncPip = useCallback(() => {
    const el = document.pictureInPictureElement;
    const ours = !!videoRef.current && el === videoRef.current;
    setPip(ours);
    // A floating element that ISN'T ours is a leftover no control can reach.
    // Close it rather than leave a dead window on someone's second screen.
    if (el && !ours) void document.exitPictureInPicture().catch(() => { /* already gone */ });
    setPipPid((prev) => (ours ? (prev || vidPidRef.current) : ""));
  }, []);
  // vidPid as a ref: syncPip is a stable callback (the listeners below subscribe
  // once) and must still see which transcript is playing right now
  const vidPidRef = useRef(vidPid);
  useEffect(() => { vidPidRef.current = vidPid; }, [vidPid]);
  useEffect(syncPip);
  useEffect(() => {
    // A leave on OUR mounted element is the user closing the floating window
    // (the ×, or back-to-tab) — that's a real "turn it off". The programmatic
    // exit when a video-less transcript unmounts the element never gets here:
    // a detached node's leave event doesn't reach the document, which is
    // exactly what lets the intent survive that case.
    const onLeave = (e: Event) => {
      if (e.target === videoRef.current) pipWant.current = false;
      syncPip();
    };
    // …and entering from the VIDEO's own native control is the same "float this"
    // as our button. Recording intent here too keeps the two routes identical:
    // otherwise a native pop-out silently opted out of carrying across tabs.
    const onEnter = (e: Event) => {
      if (e.target === videoRef.current) pipWant.current = true;
      syncPip();
    };
    document.addEventListener("enterpictureinpicture", onEnter);
    document.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      document.removeEventListener("enterpictureinpicture", onEnter);
      document.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [syncPip]);

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
      // role=button covers the div rows every code list is built from: they
      // handle Space themselves and only preventDefault, so without this a
      // Space on a code row applied the code AND toggled playback.
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"
        || t.tagName === "BUTTON" || t.isContentEditable
        || t.getAttribute("role") === "button") return;
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

  // Off a transcript the dock normally goes away — EXCEPT while its video is
  // floating: then it stays as its collapsed pill, so the play/pause, speed and
  // pop-back controls keep reaching the window on your other screen while you
  // work in the Codebook, Summary or Assist tab.
  if (!onTranscript && !(pip && cur)) return null;
  // One flag for "show only the pill": collapsed by choice, or showing a video
  // that isn't this tab's — off a transcript entirely, or floating another
  // transcript's media. The offset and sync-to-line controls read the ACTIVE
  // transcript, so they'd be acting on one transcript while the picture is
  // another's; the pill's transport is the only thing that still makes sense.
  const shut = geom.collapsed || !onTranscript || vidPid !== pid;

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
  // Pop the video into the browser's picture-in-picture window — a real window
  // that moves to another monitor while the SAME element keeps answering every
  // dock control (play/pause, speed, offset, sync). Audio-only media rejects;
  // the catch keeps that (and unsupported browsers) a silent no-op.
  const togglePip = async () => {
    const v = videoRef.current; if (!v) return;
    try {
      // identity, not truthiness: only OUR video floating means "click = bring it back"
      if (document.pictureInPictureElement === v) {
        pipWant.current = false; // an explicit "off" — don't re-enter on the next tab
        await document.exitPictureInPicture();
      } else {
        await v.requestPictureInPicture();
        pipWant.current = true; // only a SUCCESSFUL entry records the intent
      }
    } catch { /* audio-only source, or PiP unavailable */ }
  };

  // remember this tab's position as it plays; restore it when its source loads
  const onTimeUpdate = () => {
    const v = videoRef.current; if (!v) return;
    if (!switching.current) lastTime.current[vidPid] = v.currentTime;
    setTime(v.currentTime);
  };
  const onLoaded = () => {
    const v = videoRef.current; if (!v) return;
    const t = lastTime.current[vidPid];
    if (t != null && t > 0.05) v.currentTime = t;
    switching.current = false;
    setTime(v.currentTime);
    // `playing` survives the unmount but the element does not: returning to a
    // transcript you left mid-playback showed a Pause icon (and announced
    // "Pause") over a paused video. Re-seed both from the element.
    setPlaying(!v.paused);
    // Standing PiP intent + a fresh source and no window up = we're arriving on
    // a transcript with media after PiP was force-closed elsewhere — re-enter.
    // Here (metadata ready) and not earlier: PiP rejects on an unloaded video.
    // The tab click that brought us here is the transient user activation this
    // call spends; if the browser refuses anyway, the toggle just stays off.
    if (pipWant.current && !document.pictureInPictureElement && document.pictureInPictureEnabled)
      void v.requestPictureInPicture().catch(() => { /* no activation, or audio-only */ });
  };
  // H:MM:SS only once there's an hour to show
  const clock = (s: number) => {
    const t = Math.floor(Math.max(0, s));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
    const two = (n: number) => String(n).padStart(2, "0");
    return h ? `${h}:${two(m)}:${two(ss)}` : `${two(m)}:${two(ss)}`;
  };

  // Feature: jump the transcript to whatever is playing now. The line's position in the
  // video is tsToSec(line.ts) + offset; the line being spoken is the last one whose video
  // start is at or before the playhead. Select it (undoable) and scroll it into view.
  const syncToLine = () => {
    const v = videoRef.current; if (!v) return;
    const t = v.currentTime;
    // the transcript whose media is playing — the button only shows when that is
    // the active one, and keying it to the video keeps the two from ever diverging
    const lines = useStore.getState().transcripts[vidPid]?.lines ?? [];
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
  const effW = shut ? 150 : geom.w;
  const pos = geom.r !== null && geom.bottom !== null
    ? {
        right: 0, bottom: 0, left: "auto" as const, top: "auto" as const,
        transform: `translate3d(${-Math.max(60 - effW, Math.min(geom.r, window.innerWidth - 60))}px, ${
          -Math.max(0, Math.min(geom.bottom, window.innerHeight - 40))}px, 0)`,
      }
    : { right: DEFAULT_RIGHT(minimapWidth), bottom: DEFAULT_BOTTOM };

  return (
    <div className={"vdock" + (shut ? " collapsed" : "")}
      style={{
        // collapsed: shrink to the controls (grip + transport + expand), no title —
        // a minimised dock shouldn't cost a filename's width of screen.
        // expanded: floor the width by the text size — magnified chrome in a 380px
        // dock wraps into a three-row jumble. A dragged width wins above the floor.
        width: shut ? "auto"
          : Math.min(Math.max(cur ? geom.w : MIN_W, MIN_W), window.innerWidth - 48),
        fontSize: fs, ...pos,
      }}>
      {cur ? (
        <div className="vbody">
          {!shut && (
            <div className="vctrl" onMouseDown={startDrag}>
              {/* top control: find the current playback position in the transcript.
                  The strip is also a drag handle (like vhead) — buttons/inputs opt out. */}
              <button className="vbtn accent" onClick={syncToLine}
                title="Select the transcript line playing now, and scroll to it">
                <Icon name="target" size={fs + 2} /> Transcript
              </button>
              {/* the twin of "Transcript": that one takes the playhead TO the text,
                  this one leaves a note AT the playhead. Only offered while you're
                  on the transcript the media belongs to — an event is filed against
                  that transcript, so marking from another tab would file it wrong. */}
              {onTranscript && vidPid === pid && (
                // disabled during the pre-roll (offset puts the playhead before the
                // transcript): a click that silently recorded nothing would lose a
                // live observation. `time` re-renders on timeupdate, so this tracks.
                <button className="vbtn" disabled={playheadSec() === null}
                  onClick={() => {
                    const t = playheadSec();
                    if (t !== null) useStore.getState().setEventAt(t);
                  }}
                  title={playheadSec() === null
                    ? "The playhead is before the transcript starts — nothing to mark yet"
                    : "Add a session event at the playhead"}>
                  <Icon name="bookmark" size={fs + 2} /> Mark
                </button>
              )}
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
          <video ref={videoRef} src={cur.url} controls aria-label={cur.name}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoaded}
            style={{ width: shut ? 0 : "100%", height: shut ? 0 : "auto", display: "block", background: "#000" }} />
        </div>
      ) : (!shut && (
        <div className="vbody">
          <div className="vempty">
            <div>No media loaded for {pid}.</div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => fileRef.current?.click()}>Choose video/audio</button>
          </div>
        </div>
      ))}

      <div className="vhead" onMouseDown={startDrag}>
        <span className="vgrip" aria-hidden="true"><Icon name="grip-horizontal" size={fs + 1} /></span>
        {/* minimised with media: controls only — the timecode returns on expand.
            With media it's the playhead (the filename lives in its tooltip);
            with none, a plain "Video" label — a bare grip and chevron says
            nothing about what it is. */}
        {!(shut && cur) && (
          <span className={"vtitle" + (cur ? " vclock" : "")}
            // when the picture belongs to another transcript (a floating video
            // held while you work elsewhere), say whose — the filename alone
            // wouldn't tell you why this tab is showing someone else's video
            title={cur ? (vidPid === pid ? cur.name : `${vidPid} — ${cur.name}`) : undefined}>
            {cur ? clock(time) : "Video"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {cur && (
          <>
            <button className="vbtn playbtn" onClick={togglePlay} title="Play / pause"
              aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} size={fs} />
            </button>
            {"pictureInPictureEnabled" in document && document.pictureInPictureEnabled && (
              <button className={"vbtn icononly" + (pip ? " on" : "")} onClick={() => void togglePip()}
                title={pip ? "Bring the video back to the dock" : "Pop the video out — a floating window you can move to another screen; every control here still drives it"}
                aria-label={pip ? "Exit picture-in-picture" : "Open picture-in-picture"} aria-pressed={pip}>
                <Icon name="pip" size={fs + 2} />
              </button>
            )}
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
            looked like a sibling of the speed control when framed the same way.
            Off a transcript the pill can't expand (there's nothing to expand
            INTO), so the chevron would be a button that does nothing — hidden. */}
        {onTranscript && (
          <button className="vbtn icononly ghost" onClick={() => setGeom((g) => ({ ...g, collapsed: !g.collapsed }))}
            title={shut ? "Expand" : "Collapse to audio"}
            aria-label={shut ? "Expand the video dock" : "Collapse the video dock to audio"}
            aria-expanded={!shut}>
            <Icon name={shut ? "chevron-up" : "chevron-down"} size={fs + 3} />
          </button>
        )}
      </div>
      {/* Resize lives on the BAR's corner, not over the video picture. A focusable
          slider, not a bare mousedown target: dragging is the only way to size the
          dock, and a drag is exactly what a tremor or a keyboard-only user cannot
          do. Arrows step, Home/End take the extremes. */}
      {cur && !shut && (
        <div className="vresize" onMouseDown={startResize} title="Resize"
          role="slider" tabIndex={0} aria-label="Video dock width"
          aria-valuemin={MIN_W} aria-valuemax={Math.round(window.innerWidth - 40)}
          aria-valuenow={Math.round(geom.w)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 80 : 20;
            const max = window.innerWidth - 40;
            const to = (w: number) => {
              e.preventDefault();
              setGeom((g) => ({ ...g, w: Math.max(MIN_W, Math.min(w, max)) }));
            };
            if (e.key === "ArrowLeft" || e.key === "ArrowUp") to(geom.w + step);
            else if (e.key === "ArrowRight" || e.key === "ArrowDown") to(geom.w - step);
            else if (e.key === "Home") to(MIN_W);
            else if (e.key === "End") to(max);
          }} />
      )}
      <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: "none" }}
        onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
