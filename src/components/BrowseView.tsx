// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type Segment } from "../state/store";
import { norm } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";
import { Resizer } from "./Resizer";
import { CodeMenu } from "./CodeMenu";
import { CodeCombobox } from "./CodeCombobox";
import { openColorPicker } from "../colorPicker";
import { LENSES, hashLine, spanLens } from "../ai/flag";

// Browse's working state (chosen codes, filter, toggles) survives leaving the tab —
// the view unmounts, so plain useState would reset it on every visit.
const remembered = {
  selected: new Set<string>(),
  anchor: null as string | null,
  filter: "",
  showRejected: false,
  mode: "codes" as "codes" | "notices",
  lens: null as string | null,
  onlyUncoded: true,
};

// One AI noticing, resolved against the current text (a stale hash means the line
// was edited since the scan — those don't appear) and against your segments (an
// instance is "coded" once any non-rejected segment covers its line).
interface Notice {
  pid: string; id: number; speaker: string; text: string;
  quote: string; reason: string; lens: string; codedAs: string | null;
}

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const setColor = useStore((s) => s.setColor);
  const jumpTo = useStore((s) => s.jumpTo);
  const aiFlags = useStore((s) => s.aiFlags);
  const tabs = useStore((s) => s.tabs);
  const [selected, setSelected] = useState<Set<string>>(remembered.selected);
  const [anchor, setAnchor] = useState<string | null>(remembered.anchor);
  const [filter, setFilter] = useState(remembered.filter);
  const [showRejected, setShowRejected] = useState(remembered.showRejected);
  const [mode, setMode] = useState(remembered.mode);
  const [lens, setLens] = useState(remembered.lens);
  const [onlyUncoded, setOnlyUncoded] = useState(remembered.onlyUncoded);
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  useEffect(() => { Object.assign(remembered, { selected, anchor, filter, showRejected, mode, lens, onlyUncoded }); },
    [selected, anchor, filter, showRejected, mode, lens, onlyUncoded]);

  // every live noticing across all open transcripts, in tab + line order
  const notices = useMemo(() => {
    const out: Notice[] = [];
    for (const pid of tabs) {
      const t = transcripts[pid];
      if (!t) continue;
      for (const l of t.lines) {
        const f = aiFlags[`${pid}:${l.id}`];
        if (!f || !f.spans.length || f.hash !== hashLine(l.text)) continue;
        for (const sp of f.spans) {
          if (spanLens(sp) === "transcription") continue; // errors live in the line editor, not here
          const cover = segments.find((sg) => sg.pid === pid && sg.status !== "rejected" && sg.start <= l.id && l.id <= sg.end);
          out.push({ pid, id: l.id, speaker: l.speaker, text: l.text, quote: sp.quote, reason: sp.reason, lens: spanLens(sp), codedAs: cover?.code ?? null });
        }
      }
    }
    return out;
  }, [aiFlags, tabs, transcripts, segments]);
  const hasNotices = notices.length > 0;

  const counts: Record<string, { segs: number; pids: Set<string> }> = {};
  segments.filter((s) => s.status === "accepted").forEach((s) => {
    (counts[s.code] ??= { segs: 0, pids: new Set() });
    counts[s.code].segs++; counts[s.code].pids.add(s.pid);
  });

  // The excerpt's dominant speaker is shown as its own field in the ref row (below),
  // so the display text drops the "[R:] " prefix the export keeps baked in.
  const excerptFor = (s: Segment): { text: string; speaker: string } | null => {
    const t = transcripts[s.pid];
    if (!t) return null;
    const r = excerptOf(t.lines.filter((l) => l.id >= s.start && l.id <= s.end)
      .map((l) => ({ text: l.text, speaker: l.speaker })));
    return { text: r.excerpt.replace(/^\[R:\] /, ""), speaker: r.speaker };
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

  // keyboard/visible route to the same menu right-click opens (mirrors CodeSidebar)
  const openMenuAt = (code: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ code, x: r.left, y: r.bottom + 2 });
  };

  const noticeLenses = LENSES.filter((l) => l.id !== "transcription");
  const lensStats = (id: string) => {
    const of = notices.filter((n) => n.lens === id);
    return { n: of.length, pids: new Set(of.map((x) => x.pid)).size };
  };
  // the selected lens, defaulting to the first that actually has instances
  const curLens = lens ?? noticeLenses.find((l) => lensStats(l.id).n > 0)?.id ?? noticeLenses[0].id;

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left nicescroll" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {hasNotices && (
          <div className="bMode">
            <button className={mode === "codes" ? "on" : ""} onClick={() => setMode("codes")}>Codes</button>
            <button className={mode === "notices" ? "on" : ""} onClick={() => setMode("notices")}>Noticings</button>
          </div>
        )}
        {mode === "notices" && hasNotices ? (
          noticeLenses.map((l) => {
            const st = lensStats(l.id);
            return (
              <div key={l.id} className={"nLens" + (curLens === l.id ? " sel" : "") + (st.n === 0 ? " none" : "")}
                tabIndex={0} role="button" aria-pressed={curLens === l.id}
                onClick={() => setLens(l.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLens(l.id); } }}>
                <span className="nDot" style={{ background: l.color }} />
                <span className="nName">{l.label}</span>
                <span className="cnt">{st.n}·{st.pids}</span>
              </div>
            );
          })
        ) : (
          <>
        <input type="search" placeholder="filter codes…" value={filter}
          onChange={(e) => setFilter(e.target.value)} />
        {listed.map((c) => (
          <div key={c} className={"bCode" + (selected.has(c) ? " sel" : "")} tabIndex={0} role="button"
            aria-label={`Show excerpts for ${c}, ${counts[c]?.segs || 0} segment${counts[c]?.segs === 1 ? "" : "s"}`}
            aria-pressed={selected.has(c)} onClick={(e) => select(c, e)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return; // let the ⋯ button's keys be its own
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c, e); }
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault(); openMenuAt(c, e.currentTarget);
              }
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ code: c, x: e.clientX, y: e.clientY }); }}
            data-tip={c}>
            <div className="bCodeMain">
              {/* right-click only, matching the main sidebar's swatch */}
              <span className="codebar"
                style={{ background: codebook[c].color }} title="right-click to recolor"
                onContextMenu={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  openColorPicker(codebook[c].color, (v) => setColor(c, v), e.currentTarget);
                }} />
              <span className="bCodeName">{c}</span>
              {/* the count is already in the row's aria-label — don't double-speak */}
              <span className="cnt" aria-hidden="true">{counts[c]?.segs || 0}·{counts[c]?.pids.size || 0}</span>
              <button className="rowMenu" aria-label={`Options for ${c}`}
                onClick={(e) => { e.stopPropagation(); openMenuAt(c, e.currentTarget); }}>⋯</button>
            </div>
            {codebook[c].def && <div className="bCodeDef">{codebook[c].def}</div>}
          </div>
        ))}
          </>
        )}
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(160, Math.min(520, w)) })} />

      <div className="browse-right nicescroll">
        {mode === "notices" && hasNotices ? (
          <NoticeList
            notices={notices.filter((n) => n.lens === curLens)}
            lensColor={noticeLenses.find((l) => l.id === curLens)?.color ?? "#888"}
            onlyUncoded={onlyUncoded}
            setOnlyUncoded={setOnlyUncoded}
            tabs={tabs}
          />
        ) : chosen.length === 0 ? (
          <div className="empty">Select a code on the left to see its excerpts.</div>
        ) : (
          <>
            <div className="bOptions">
              <button className="switchRow" role="switch" aria-checked={showRejected}
                onClick={() => setShowRejected((v) => !v)}>
                <span className={"switch" + (showRejected ? " on" : "")}><span className="knob" /></span>
                <span className="switchLabel">Show rejected excerpts</span>
              </button>
            </div>
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
                    const range = `${s.start}${s.end !== s.start ? `-${s.end}` : ""}`;
                    return (
                      <div key={s.sid} className={"bExcerpt" + (rej ? " rejected" : "")}
                        style={{ borderLeftColor: codebook[code].color || "var(--line)" }}>
                        <div>{rej && <span className="rejtag">rejected</span>}{ex?.text || "(excerpt in coded-segments.csv)"}</div>
                        {s.notes && <div className="bNote">{s.notes}</div>}
                        <div className={"ref" + (loaded ? " open" : "")}
                          tabIndex={loaded ? 0 : undefined} role={loaded ? "button" : undefined}
                          aria-label={loaded ? `Open in transcript: ${s.pid} line${s.end !== s.start ? "s" : ""} ${range}` : undefined}
                          onClick={() => loaded && jumpTo(s.pid, s.start)}
                          onKeyDown={(e) => {
                            if (loaded && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); jumpTo(s.pid, s.start); }
                          }}>
                          {ex?.speaker && <span className="refspk">{ex.speaker}</span>}
                          {s.pid}:{range}{loaded ? "  → open in transcript" : "  (transcript not loaded)"}
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
      {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

// the quoted span highlighted inside its full line, in the lens color
function lineWithQuote(text: string, quote: string, color: string): ReactNode {
  const at = text.indexOf(quote);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="nHl" style={{ "--lens-c": color } as CSSProperties}>{quote}</span>
      {text.slice(at + quote.length)}
    </>
  );
}

// Instances of one lens, grouped by participant. The staging area for the move
// from noticing to code: "code…" writes a segment for the instance's LINE (your
// unit of analysis), authored by you — the AI pointed, you named it. Coded
// instances stay visible with a badge (hiding them would misreport what the AI
// found); the Only-uncoded filter is what turns the list into a worklist.
function NoticeList({ notices, lensColor, onlyUncoded, setOnlyUncoded, tabs }: {
  notices: Notice[];
  lensColor: string;
  onlyUncoded: boolean;
  setOnlyUncoded: (v: boolean) => void;
  tabs: string[];
}) {
  const jumpTo = useStore((s) => s.jumpTo);
  const [coding, setCoding] = useState<string | null>(null); // "pid:id:quote" of the open combobox
  const shown = onlyUncoded ? notices.filter((n) => !n.codedAs) : notices;
  const uncoded = notices.filter((n) => !n.codedAs).length;

  const codeInstance = (n: Notice, code: string) => {
    const st = useStore.getState();
    st.pushUndo();
    st.addSegment(n.pid, n.id, n.id, code);
    setCoding(null);
  };

  return (
    <>
      <div className="bOptions nOpts">
        <div className="nPills">
          <button className={"nPill" + (onlyUncoded ? " on" : "")} onClick={() => setOnlyUncoded(true)}>Only uncoded</button>
          <button className={"nPill" + (!onlyUncoded ? " on" : "")} onClick={() => setOnlyUncoded(false)}>All</button>
        </div>
        <span className="nCount">{notices.length} instance{notices.length === 1 ? "" : "s"} · {uncoded} uncoded</span>
      </div>
      {shown.length === 0 && (
        <div className="empty">
          {notices.length === 0
            ? "Nothing under this lens yet — run an AI scan with it ticked."
            : "No uncoded instances left under this lens — you've been through everything it noticed."}
        </div>
      )}
      {tabs.filter((pid) => shown.some((n) => n.pid === pid)).map((pid) => (
        <div key={pid} className="bGroup">
          <div className="nGrp">{pid}</div>
          {shown.filter((n) => n.pid === pid).map((n) => {
            const key = `${n.pid}:${n.id}:${n.quote}`;
            return (
              <div key={key} className="nInst" style={{ "--lens-c": lensColor } as CSSProperties}>
                <div className="nLine">{lineWithQuote(n.text, n.quote, lensColor)}</div>
                <div className="nWhy">{n.reason}</div>
                {coding === key ? (
                  <div className="nCode">
                    <CodeCombobox autoFocus placeholder="code this line…"
                      onPick={(c) => codeInstance(n, c)} onClose={() => setCoding(null)} />
                  </div>
                ) : (
                  <div className="nFoot">
                    <span className="nRef">{n.pid}:{n.id} · {n.speaker}</span>
                    {n.codedAs && <span className="nCoded">coded · {n.codedAs}</span>}
                    <span className="nActs">
                      {!n.codedAs && <button className="nBtn pri" onClick={() => setCoding(key)}>code…</button>}
                      <button className="nBtn" onClick={() => jumpTo(n.pid, n.id)}>open</button>
                      <button className="nBtn" title="Remove this noticing (it won't be re-fetched)"
                        onClick={() => useStore.getState().dismissNotice(n.pid, n.id, n.lens, n.quote)}>dismiss</button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
