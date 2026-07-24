// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Assist tab: everything the AI proposes, in one place. Today that's the
// observations — instances it marked across transcripts under each lens, staged
// for you to turn into codes. Merge and code-suggestion land here later.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../state/store";
import { Resizer } from "./Resizer";
import { CodeCombobox } from "./CodeCombobox";
import { LENSES, hashLine, spanLens } from "../ai/flag";

// One AI observation, resolved against the current text (a stale hash means the line
// was edited since the scan — those don't appear) and against your segments (an
// instance is "coded" once any non-rejected segment covers its line).
interface Notice {
  pid: string; id: number; speaker: string; text: string;
  quote: string; reason: string; lens: string; codedAs: string | null;
}

// working state survives leaving the tab (the view unmounts on tab change)
const remembered = { lens: null as string | null, onlyUncoded: true };

export function AssistView() {
  const transcripts = useStore((s) => s.transcripts);
  const segments = useStore((s) => s.segments);
  const aiFlags = useStore((s) => s.aiFlags);
  const tabs = useStore((s) => s.tabs);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const [lens, setLens] = useState(remembered.lens);
  const [onlyUncoded, setOnlyUncoded] = useState(remembered.onlyUncoded);
  useEffect(() => { Object.assign(remembered, { lens, onlyUncoded }); }, [lens, onlyUncoded]);

  // every live observation across all open transcripts, in tab + line order
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

  const observeLenses = LENSES.filter((l) => l.id !== "transcription");
  const lensStats = (id: string) => {
    const of = notices.filter((n) => n.lens === id);
    return { n: of.length, pids: new Set(of.map((x) => x.pid)).size };
  };
  // the selected lens, defaulting to the first that actually has instances
  const curLens = lens ?? observeLenses.find((l) => lensStats(l.id).n > 0)?.id ?? observeLenses[0].id;

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left nicescroll" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        <div className="bSideHead">Observations</div>
        {hasNotices ? observeLenses.map((l) => {
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
        }) : (
          <div className="bSideNote">No observations yet. Open a transcript and run an <b>AI scan</b> from its code sidebar.</div>
        )}
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(160, Math.min(520, w)) })} />

      <div className="browse-right nicescroll">
        {hasNotices ? (
          <NoticeList
            notices={notices.filter((n) => n.lens === curLens)}
            lensColor={observeLenses.find((l) => l.id === curLens)?.color ?? "#888"}
            onlyUncoded={onlyUncoded}
            setOnlyUncoded={setOnlyUncoded}
            tabs={tabs}
          />
        ) : (
          <div className="empty">
            Nothing to review yet. The AI's observations show up here after you run a scan —
            it points, you decide what becomes a code.
          </div>
        )}
      </div>
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
// from observation to code: "code…" writes a segment for the instance's LINE (your
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
            : "No uncoded instances left under this lens — you've been through everything it found."}
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
                      <button className="nBtn" title="Remove this observation (it won't be re-fetched)"
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
