// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Assist tab: everything the AI proposes, in one place. Two panels today —
// observations (instances it marked, staged into codes) and merge (near-duplicate
// code pairs to fold together). Code-suggestion lands here later.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type Segment } from "../state/store";
import { Resizer } from "./Resizer";
import { CodeCombobox } from "./CodeCombobox";
import { LENSES, hashLine, spanLens } from "../ai/flag";
import { MergeModal } from "./MergeModal";
import type { MergeProposal } from "../ai/dedupe";
import { excerptOf } from "../contract/excerpt";
import { Icon } from "./Icon";

// One AI observation, resolved against the current text (a stale hash means the line
// was edited since the scan — those don't appear) and against your segments (an
// instance is "coded" once any non-rejected segment covers its line).
interface Notice {
  pid: string; id: number; speaker: string; text: string;
  quote: string; reason: string; lens: string; codedAs: string | null;
}

// working state survives leaving the tab (the view unmounts on tab change) via
// this module-level cache. proposals are AI output held in memory only — never
// written to the project file, so they clear on reload. The active panel lives
// in the store (ui.assistPanel) — the Assist tab's own menu sets it.
const remembered = {
  lens: null as string | null,
  onlyUncoded: true,
  proposals: [] as MergeProposal[],
  flipped: new Set<string>(),
  suggestBy: "transcript" as "transcript" | "code",
  suggestSel: null as string | null, // selected transcript/code, null = all
};
// stable key for a proposal, direction-independent (NUL can't occur in a code name)
const pairKey = (p: MergeProposal) => JSON.stringify([p.from, p.into].sort());

export function AssistView() {
  const transcripts = useStore((s) => s.transcripts);
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const aiFlags = useStore((s) => s.aiFlags);
  const tabs = useStore((s) => s.tabs);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const panel = useStore((s) => s.ui.assistPanel);
  const [lens, setLens] = useState(remembered.lens);
  const [onlyUncoded, setOnlyUncoded] = useState(remembered.onlyUncoded);
  const [proposals, setProposals] = useState<MergeProposal[]>(remembered.proposals);
  const [flipped, setFlipped] = useState<Set<string>>(remembered.flipped);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [suggestBy, setSuggestBy] = useState(remembered.suggestBy);
  const [suggestSel, setSuggestSel] = useState(remembered.suggestSel);
  useEffect(() => { Object.assign(remembered, { lens, onlyUncoded, proposals, flipped, suggestBy, suggestSel }); },
    [lens, onlyUncoded, proposals, flipped, suggestBy, suggestSel]);
  const pickSuggestBy = (by: "transcript" | "code") => { setSuggestBy(by); setSuggestSel(null); };

  // codes with at least one accepted segment — merge needs two to compare
  const mergeableCount = useMemo(() =>
    new Set(segments.filter((s) => s.status === "accepted").map((s) => s.code)).size, [segments]);
  // a proposal is live only while BOTH its codes still exist (accepting one merge
  // can dissolve a code another proposal named — drop those rather than merge into a ghost)
  const liveProposals = proposals.filter((p) => codebook[p.from] && codebook[p.into]);

  // candidate codings (F3) for the Suggest panel — only loaded transcripts (an
  // excerpt needs its lines). Grouped either by transcript or by code for navigation.
  const candidates = useMemo(() =>
    segments.filter((s) => s.status === "candidate" && transcripts[s.pid]), [segments, transcripts]);
  const suggestGroups = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of candidates) {
      const k = suggestBy === "transcript" ? c.pid : c.code;
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    const keys = suggestBy === "transcript" ? tabs.filter((p) => n.has(p)) : [...n.keys()].sort();
    return keys.map((key) => ({ key, n: n.get(key)! }));
  }, [candidates, suggestBy, tabs]);
  const shownCandidates = suggestSel == null ? candidates
    : candidates.filter((c) => (suggestBy === "transcript" ? c.pid : c.code) === suggestSel);

  const accept = (p: MergeProposal) => {
    const swap = flipped.has(pairKey(p));
    const from = swap ? p.into : p.from, into = swap ? p.from : p.into;
    useStore.getState().mergeCode(from, into); // undoable (pushes its own undo)
    setProposals((ps) => ps.filter((x) => x !== p));
  };
  const skip = (p: MergeProposal) => setProposals((ps) => ps.filter((x) => x !== p));
  const toggleFlip = (p: MergeProposal) => setFlipped((f) => {
    const n = new Set(f); const k = pairKey(p); n.has(k) ? n.delete(k) : n.add(k); return n;
  });

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
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* the panel (Observations / Merge / Suggest) is picked from the Assist tab's
            own menu — this heading just names what's showing. It stays fixed; the
            list below scrolls inside cbList so the scrollbar clears the drag divider. */}
        <div className="bSideHead">{panel === "merge" ? "Merge codes" : panel === "suggest" ? "Suggest codes" : "Observations"}</div>

        <div className="cbList nicescroll">
        {panel === "observations" ? (
          hasNotices ? observeLenses.map((l) => {
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
          )
        ) : panel === "merge" ? (
          <>
            <button className="btn groundBtn" onClick={() => setMergeOpen(true)} disabled={mergeableCount < 2}
              title="Ask the AI to propose near-duplicate codes to merge (sends the codebook to OpenAI after your approval)">
              <Icon name="sparkle" size={15} /> Find duplicates…
            </button>
            <div className="bSideNote">
              {mergeableCount < 2
                ? "Code at least two different codes first, then the AI can look for duplicates."
                : "The AI proposes pairs that look like the same concept. You accept each merge — nothing changes on its own."}
            </div>
          </>
        ) : (
          <>
            <div className="nPills aSuggestBy">
              <button className={"nPill" + (suggestBy === "transcript" ? " on" : "")}
                onClick={() => pickSuggestBy("transcript")}>By transcript</button>
              <button className={"nPill" + (suggestBy === "code" ? " on" : "")}
                onClick={() => pickSuggestBy("code")}>By code</button>
            </div>
            {suggestGroups.length === 0 ? (
              <div className="bSideNote">
                No candidate codings yet. Run <b>Suggest codes</b> from a transcript's code
                sidebar; they land here and striped in the transcript.
              </div>
            ) : (
              <>
                <div className={"nLens" + (suggestSel === null ? " sel" : "")}
                  tabIndex={0} role="button" aria-pressed={suggestSel === null}
                  onClick={() => setSuggestSel(null)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSuggestSel(null); } }}>
                  <span className="nName">All</span>
                  <span className="cnt">{candidates.length}</span>
                </div>
                {suggestGroups.map((g) => (
                  <div key={g.key} className={"nLens" + (suggestSel === g.key ? " sel" : "")}
                    tabIndex={0} role="button" aria-pressed={suggestSel === g.key}
                    onClick={() => setSuggestSel(g.key)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSuggestSel(g.key); } }}>
                    {suggestBy === "code" && <span className="nDot" style={{ background: codebook[g.key]?.color ?? "#888" }} />}
                    <span className="nName">{g.key}</span>
                    <span className="cnt">{g.n}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        </div>
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(160, Math.min(520, w)) })} />

      <div className="browse-right nicescroll">
        {panel === "observations" ? (
          hasNotices ? (
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
          )
        ) : panel === "merge" ? (
          <MergeList proposals={liveProposals} codebook={codebook} flipped={flipped}
            onAccept={accept} onSkip={skip} onFlip={toggleFlip} />
        ) : (
          <SuggestList candidates={shownCandidates} groupBy={suggestBy}
            transcripts={transcripts} codebook={codebook} tabs={tabs} />
        )}
      </div>
      {mergeOpen && <MergeModal onProposals={(p) => { setProposals(p); setFlipped(new Set()); }}
        onClose={() => setMergeOpen(false)} />}
    </div>
  );
}

// The merge proposals, each a pair the AI thinks is one concept. Accept runs the
// undoable mergeCode; the swap flips which code survives before you commit.
function MergeList({ proposals, codebook, flipped, onAccept, onSkip, onFlip }: {
  proposals: MergeProposal[];
  codebook: Record<string, { color: string; def: string; status: string }>;
  flipped: Set<string>;
  onAccept: (p: MergeProposal) => void;
  onSkip: (p: MergeProposal) => void;
  onFlip: (p: MergeProposal) => void;
}) {
  if (!proposals.length) {
    return (
      <div className="empty">
        No merge proposals. Run <b>Find duplicates</b> on the left, and any near-duplicate
        code pairs will show up here for you to accept or skip.
      </div>
    );
  }
  const swatch = (code: string) => (
    <span className="mSw" style={{ background: codebook[code]?.color || "#999" }} />
  );
  return (
    <div className="mList">
      {proposals.map((p) => {
        const swap = flipped.has(pairKey(p));
        const from = swap ? p.into : p.from, into = swap ? p.from : p.into;
        return (
          <div key={`${p.from}|${p.into}`} className="mProp">
            <div className="mPair">
              <span className="mCode mDrop">{swatch(from)}{from}</span>
              <button className="mSwap" onClick={() => onFlip(p)} aria-label="Swap which code is kept"
                title="Swap which code is kept">→</button>
              <span className="mCode mKeep">{swatch(into)}{into}<span className="mKeepTag">kept</span></span>
            </div>
            {p.rationale && <div className="mWhy">{p.rationale}</div>}
            <div className="mActs">
              <button className="nBtn pri" onClick={() => onAccept(p)}>Merge</button>
              <button className="nBtn" onClick={() => onSkip(p)}>Skip</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The AI's candidate codings (status "candidate"), grouped by transcript OR by
// code (the sidebar picks which) — a worklist mirror of what's striped in the
// transcript. Accept/Reject use the same setStatus the segment popover does, so a
// verdict here or there is the same verdict. Candidates come pre-filtered.
function SuggestList({ candidates, groupBy, transcripts, codebook, tabs }: {
  candidates: Segment[];
  groupBy: "transcript" | "code";
  transcripts: Record<string, { lines: { id: number; speaker: string; text: string }[] }>;
  codebook: Record<string, { color: string; def: string; status: string }>;
  tabs: string[];
}) {
  const setStatus = useStore((s) => s.setStatus);
  const jumpTo = useStore((s) => s.jumpTo);
  if (!candidates.length) {
    return (
      <div className="empty">
        No candidate codings here. Run <b>Suggest codes</b> from a transcript's code sidebar and the
        AI's proposals — existing codes applied to line ranges — show up here to accept or reject.
      </div>
    );
  }
  const excerptFor = (s: Segment): string => {
    const t = transcripts[s.pid];
    if (!t) return "";
    return excerptOf(t.lines.filter((l) => l.id >= s.start && l.id <= s.end)
      .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
  };
  const row = (s: Segment) => {
    const range = `${s.start}${s.end !== s.start ? `-${s.end}` : ""}`;
    return (
      <div key={s.sid} className="nInst" style={{ "--lens-c": codebook[s.code]?.color ?? "#888" } as CSSProperties}>
        <div className="mPair" style={{ marginBottom: 4 }}>
          <span className="mCode"><span className="mSw" style={{ background: codebook[s.code]?.color || "#999" }} />{s.code}</span>
          <span className="nRef">{s.proposedBy}</span>
        </div>
        <div className="nLine">{excerptFor(s) || "(excerpt unavailable)"}</div>
        <div className="nFoot">
          <span className="nRef">{s.pid}:{range}</span>
          <span className="nActs">
            <button className="nBtn pri" onClick={() => setStatus(s.sid, "accepted")}>Accept</button>
            <button className="nBtn" onClick={() => setStatus(s.sid, "rejected")}>Reject</button>
            <button className="nBtn" onClick={() => jumpTo(s.pid, s.start)}>open</button>
          </span>
        </div>
      </div>
    );
  };
  // group headers: transcripts in tab order, codes alphabetically
  const groups = groupBy === "transcript"
    ? tabs.filter((pid) => candidates.some((c) => c.pid === pid))
    : [...new Set(candidates.map((c) => c.code))].sort();
  const inGroup = (g: string) => candidates.filter((c) => (groupBy === "transcript" ? c.pid : c.code) === g);
  return (
    <div className="mList">
      {groups.map((g) => (
        <div key={g} className="bGroup">
          <div className="nGrp">
            {groupBy === "code" && <span className="mSw" style={{ background: codebook[g]?.color || "#999", marginRight: 6 }} />}
            {g}
          </div>
          {inGroup(g).map(row)}
        </div>
      ))}
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
