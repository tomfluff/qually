import { useState } from "react";
import { useStore, type Segment } from "../state/store";
import { norm } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";
import { Icon } from "./Icon";

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.fontSize);
  const jumpTo = useStore((s) => s.jumpTo);
  const [code, setCode] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showRejected, setShowRejected] = useState(false);

  const counts: Record<string, { segs: number; pids: Set<string> }> = {};
  segments.filter((s) => s.status === "accepted").forEach((s) => {
    (counts[s.code] ??= { segs: 0, pids: new Set() });
    counts[s.code].segs++; counts[s.code].pids.add(s.pid);
  });

  const excerptFor = (s: Segment): string | null => {
    const t = transcripts[s.pid];
    if (!t) return null;
    return excerptOf(t.lines.filter((l) => l.id >= s.start && l.id <= s.end)
      .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt;
  };

  // metadata (ref/pid) scales with transcript size but always at 80% (W6 item 17)
  return (
    <div id="browse" style={{ fontSize }}>
      {!code ? (
        <>
          <input type="search" placeholder="filter codes…" value={filter}
            onChange={(e) => setFilter(e.target.value)} />
          {Object.keys(codebook).sort()
            .filter((c) => c.toLowerCase().includes(filter.toLowerCase()))
            .map((c) => (
              <div key={c} className="bCode" onClick={() => setCode(c)}>
                <span className="swatch" style={{ background: codebook[c].color }} />
                <span>{c}</span>
                <span className="cnt">{counts[c]?.segs || 0} segs · {counts[c]?.pids.size || 0} pids</span>
              </div>
            ))}
        </>
      ) : (
        <>
          <div className="bDetailHead">
            <button className="btn bBack" onClick={() => setCode(null)}>
              <Icon name="chevron-left" size={15} /> All codes
            </button>
            <label className="bToggle">
              <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
              Show rejected
            </label>
          </div>
          <h2 className="bTitle">
            <span className="swatch" style={{ background: codebook[code]?.color }} />{code}
          </h2>
          {segments.filter((s) => norm(s.code) === norm(code) &&
            (s.status === "accepted" || (showRejected && s.status === "rejected")))
            .map((s) => {
              const ex = excerptFor(s);
              const loaded = !!transcripts[s.pid];
              const rej = s.status === "rejected";
              return (
                <div key={s.sid} className={"bExcerpt" + (rej ? " rejected" : "")}
                  style={{ borderLeftColor: codebook[code]?.color || "var(--line)" }}>
                  <div>{rej && <span className="rejtag">rejected</span>}{ex || "(excerpt in coded-segments.csv)"}</div>
                  <div className={"ref" + (loaded ? " open" : "")}
                    onClick={() => loaded && jumpTo(s.pid, s.start)}>
                    {s.pid}:{s.start}{s.end !== s.start ? `-${s.end}` : ""}{loaded ? "  → open in transcript" : "  (transcript not loaded)"}
                  </div>
                </div>
              );
            })}
        </>
      )}
    </div>
  );
}
