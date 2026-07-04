import { useState } from "react";
import { useStore, type Segment } from "../state/store";
import { norm } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";
import { Resizer } from "./Resizer";

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.fontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const jumpTo = useStore((s) => s.jumpTo);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
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

  const allCodes = Object.keys(codebook).sort();
  const listed = allCodes.filter((c) => c.toLowerCase().includes(filter.toLowerCase()));
  const chosen = allCodes.filter((c) => selected.has(c));

  // selection mirrors transcript lines: plain = one (or deselect), Shift = range, Ctrl = toggle
  const select = (c: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.shiftKey && anchor && listed.includes(anchor)) {
      const a = listed.indexOf(anchor), b = listed.indexOf(c);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(listed.slice(lo, hi + 1)));
      return; // keep anchor
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected); n.has(c) ? n.delete(c) : n.add(c);
      setSelected(n); setAnchor(c); return;
    }
    if (selected.size === 1 && selected.has(c)) { setSelected(new Set()); setAnchor(null); return; }
    setSelected(new Set([c])); setAnchor(c);
  };

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left nicescroll" style={{ width: leftWidth }}>
        <input type="search" placeholder="filter codes…" value={filter}
          onChange={(e) => setFilter(e.target.value)} />
        {listed.map((c) => (
          <div key={c} className={"bCode" + (selected.has(c) ? " sel" : "")} onClick={(e) => select(c, e)}>
            <div className="bCodeMain">
              <span className="swatch" style={{ background: codebook[c].color }} />
              <span className="bCodeName">{c}</span>
              <span className="cnt">{counts[c]?.segs || 0}·{counts[c]?.pids.size || 0}</span>
            </div>
            {codebook[c].def && <div className="bCodeDef">{codebook[c].def}</div>}
          </div>
        ))}
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(160, Math.min(520, w)) })} />

      <div className="browse-right nicescroll">
        {chosen.length === 0 ? (
          <div className="empty">Select a code on the left to see its excerpts.</div>
        ) : (
          <>
            <label className="bToggle">
              <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
              Show rejected
            </label>
            {chosen.map((code) => {
              const segs = segments.filter((s) => norm(s.code) === norm(code) &&
                (s.status === "accepted" || (showRejected && s.status === "rejected")));
              return (
                <div key={code} className="bGroup">
                  <h2 className="bTitle">
                    <span className="swatch" style={{ background: codebook[code].color }} />{code}
                  </h2>
                  {codebook[code].def && <div className="bDef">{codebook[code].def}</div>}
                  {segs.length === 0 && <div className="bDef">No excerpts yet.</div>}
                  {segs.map((s) => {
                    const ex = excerptFor(s);
                    const loaded = !!transcripts[s.pid];
                    const rej = s.status === "rejected";
                    return (
                      <div key={s.sid} className={"bExcerpt" + (rej ? " rejected" : "")}
                        style={{ borderLeftColor: codebook[code].color || "var(--line)" }}>
                        <div>{rej && <span className="rejtag">rejected</span>}{ex || "(excerpt in coded-segments.csv)"}</div>
                        <div className={"ref" + (loaded ? " open" : "")}
                          onClick={() => loaded && jumpTo(s.pid, s.start)}>
                          {s.pid}:{s.start}{s.end !== s.start ? `-${s.end}` : ""}{loaded ? "  → open in transcript" : "  (transcript not loaded)"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
