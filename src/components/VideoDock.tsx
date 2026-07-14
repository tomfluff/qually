import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { registerVideo } from "../video/seek";
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

  useEffect(() => { localStorage.setItem("coding-app-dock", JSON.stringify(geom)); }, [geom]);
  const cur = media[pid];
  // keep the seek bridge pointed at the current element + offset
  useEffect(() => { registerVideo(videoRef.current, offset); }, [cur, offset, pid]);
  // apply persisted playback rate whenever the source or rate changes
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = geom.rate; }, [cur, geom.rate]);

  if (pid === "browse" || !hasTranscript) return null;

  const pickMedia = (f: File | undefined) => {
    if (!f) return;
    setMedia((m) => {
      if (m[pid]) URL.revokeObjectURL(m[pid].url);
      return { ...m, [pid]: { url: URL.createObjectURL(f), name: f.name } };
    });
  };

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) return;
    const el = (e.currentTarget as HTMLElement).parentElement!;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top, h0 = r.height;
    // track the BOTTOM edge so collapse/expand keeps the dock's bottom pinned
    const move = (ev: MouseEvent) => setGeom((g) => ({
      ...g, x: ev.clientX - dx, bottom: window.innerHeight - (ev.clientY - dy + h0),
    }));
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
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

  // clamp so a drag (or a persisted position from a larger window) can't
  // strand the dock offscreen with no way to grab it back
  const pos = geom.x !== null && geom.bottom !== null
    ? {
        left: Math.max(60 - geom.w, Math.min(geom.x, window.innerWidth - 60)),
        bottom: Math.max(0, Math.min(geom.bottom, window.innerHeight - 40)),
        right: "auto" as const, top: "auto" as const,
      }
    : { right: 24, bottom: 24 };

  return (
    <div className={"vdock" + (geom.collapsed ? " collapsed" : "")}
      style={{ width: cur ? geom.w : 260, ...pos }}>
      {cur ? (
        <div className="vbody">
          {!geom.collapsed && (
            <div className="vctrl">
              <span className="vlabel">Offset</span>
              <div className="stepper">
                <button onClick={() => setOffset(offset - 1)} title="−1s">−</button>
                <input type="number" step={1} value={offset} onChange={(e) => setOffset(+e.target.value || 0)} />
                <button onClick={() => setOffset(offset + 1)} title="+1s">+</button>
              </div>
              <span className="unit">sec</span>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => fileRef.current?.click()}>Change media</button>
            </div>
          )}
          {/* stays mounted when collapsed (0x0) so audio keeps playing but the
              video's dimensions don't affect the collapsed bar's auto width */}
          <video ref={videoRef} src={cur.url} controls
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
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
            <button className="btn" onClick={togglePlay} title="play/pause">
              <Icon name={playing ? "pause" : "play"} />
            </button>
            {SPEEDS.map((s) => (
              <button key={s} className={"btn speed" + (geom.rate === s ? " on" : "")}
                onClick={() => setRate(s)}>{s}×</button>
            ))}
          </>
        )}
        <button className="btn vcollapse" onClick={() => setGeom((g) => ({ ...g, collapsed: !g.collapsed }))}
          title={geom.collapsed ? "expand" : "collapse to audio"}>
          <Icon name={geom.collapsed ? "chevron-up" : "chevron-down"} size={18} />
        </button>
      </div>
      <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: "none" }}
        onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
