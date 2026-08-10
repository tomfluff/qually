// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Assist tab: everything the AI proposes, in one place. Three panels —
// observations (instances it marked, staged into codes), merge (near-duplicate
// code pairs to fold together) and suggest (candidate codings). Observations and
// suggest are also where their runs START: each groups by transcript or by its own
// axis, and a transcript row carries the sparkle that opens that run's consent gate.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type Segment } from "../state/store";
import { Resizer } from "./Resizer";
import { CodeCombobox } from "./CodeCombobox";
import { LENSES, hashLine, spanLens, lensOf } from "../ai/flag";
import { MergeModal } from "./MergeModal";
import { SuggestModal } from "./SuggestModal";
import { AiCheckModal } from "./AiCheckModal";
import { SummarizeModal } from "./SummarizeModal";
import { openSummary } from "./SummaryView";
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
  obsBy: "lens" as "lens" | "transcript",
  obsSel: null as string | null, // selected lens/transcript, null = all
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
  const markers = useStore((s) => s.markers);
  const summaries = useStore((s) => s.summaries);
  const codebook = useStore((s) => s.codebook);
  const aiFlags = useStore((s) => s.aiFlags);
  const tabs = useStore((s) => s.tabs);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const panel = useStore((s) => s.ui.assistPanel);
  const [obsBy, setObsBy] = useState(remembered.obsBy);
  const [obsSel, setObsSel] = useState(remembered.obsSel);
  const [onlyUncoded, setOnlyUncoded] = useState(remembered.onlyUncoded);
  const [proposals, setProposals] = useState<MergeProposal[]>(remembered.proposals);
  const [flipped, setFlipped] = useState<Set<string>>(remembered.flipped);
  const [mergeOpen, setMergeOpen] = useState(false);
  // null = closed; "" = open with nothing picked; a pid = open on that transcript
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [sumFor, setSumFor] = useState<string | null>(null);
  const [suggestBy, setSuggestBy] = useState(remembered.suggestBy);
  const [suggestSel, setSuggestSel] = useState(remembered.suggestSel);
  useEffect(() => { Object.assign(remembered, { obsBy, obsSel, onlyUncoded, proposals, flipped, suggestBy, suggestSel }); },
    [obsBy, obsSel, onlyUncoded, proposals, flipped, suggestBy, suggestSel]);
  const pickSuggestBy = (by: "transcript" | "code") => { setSuggestBy(by); setSuggestSel(null); };
  const pickObsBy = (by: "lens" | "transcript") => { setObsBy(by); setObsSel(null); };
  // open tabs first, then the rest of what's loaded — the order both panels list in
  const allPids = useMemo(() =>
    [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))].filter((p) => transcripts[p]),
    [tabs, transcripts]);

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
    // Grouped by transcript the list is the CORPUS, not just what already has
    // candidates: the row is also where a run starts, so a transcript nobody has
    // run yet has to be on it. Open tabs first, then the rest of what's loaded.
    const keys = suggestBy === "transcript" ? allPids : [...n.keys()].sort();
    return keys.map((key) => ({ key, n: n.get(key) ?? 0 }));
  }, [candidates, suggestBy, allPids]);
  const hasCodes = Object.keys(codebook).length > 0;
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

  // every live observation across all LOADED transcripts (not just open tabs — a
  // closed tab's marks are still project data, the same rule the export follows),
  // in tab + line order
  const notices = useMemo(() => {
    const out: Notice[] = [];
    for (const pid of allPids) {
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
  }, [aiFlags, allPids, transcripts, segments]);
  const hasNotices = notices.length > 0;

  const observeLenses = LENSES.filter((l) => l.id !== "transcription");
  const lensStats = (id: string) => {
    const of = notices.filter((n) => n.lens === id);
    return { n: of.length, pids: new Set(of.map((x) => x.pid)).size };
  };
  // What the observation list is sliced by. null = all of it; otherwise a lens id
  // or a pid, depending on the grouping. The worklist below then groups by the OTHER
  // axis, which is what makes "one lens across transcripts" and "one transcript
  // across lenses" both reachable.
  const shownNotices = obsSel == null ? notices
    : notices.filter((n) => (obsBy === "lens" ? n.lens : n.pid) === obsSel);

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* the panel (Observations / Merge / Suggest) is picked from the Assist tab's
            own menu — this heading just names what's showing. It stays fixed; the
            list below scrolls inside cbList so the scrollbar clears the drag divider. */}
        <div className="bSideHead">{panel === "merge" ? "Merge codes" : panel === "suggest" ? "Suggest codes" : panel === "summary" ? "Transcript summary" : "Observations"}</div>

        <div className="cbList nicescroll">
        {panel === "observations" ? (
          <>
            {/* Same two ways in as the Suggest panel: a button that works in every
                state, and a sparkle on each transcript row (grouped by transcript). */}
            <button className="btn groundBtn" onClick={() => setScanFor("")} disabled={allPids.length === 0}
              title={allPids.length
                ? "Pick a transcript and let the AI mark instances under the lenses you tick (sends those lines to OpenAI after your approval)"
                : "Import a transcript first"}>
              <Icon name="sparkle" size={15} /> AI observation scan…
            </button>
            <div className="aByLabel" id="obsByLabel">Group by</div>
            <div className="segmented aSuggestBy" role="group" aria-labelledby="obsByLabel">
              <button className={"seg" + (obsBy === "transcript" ? " on" : "")}
                aria-pressed={obsBy === "transcript"}
                onClick={() => pickObsBy("transcript")}>Transcript</button>
              <button className={"seg" + (obsBy === "lens" ? " on" : "")}
                aria-pressed={obsBy === "lens"}
                onClick={() => pickObsBy("lens")}>Lens</button>
            </div>
            {obsBy === "transcript" && allPids.length === 0 ? (
              <div className="bSideNote">No transcripts loaded yet — import one and the AI can scan it from here.</div>
            ) : (
              <>
                <div className={"nLens" + (obsSel === null ? " sel" : "")}
                  tabIndex={0} role="button" aria-pressed={obsSel === null}
                  onClick={() => setObsSel(null)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setObsSel(null); } }}>
                  <span className="nName">All</span>
                  <span className="cnt">{notices.length}</span>
                </div>
                {obsBy === "lens" ? observeLenses.map((l) => {
                  const st = lensStats(l.id);
                  return (
                    <div key={l.id} className={"nLens" + (obsSel === l.id ? " sel" : "") + (st.n === 0 ? " none" : "")}
                      tabIndex={0} role="button" aria-pressed={obsSel === l.id}
                      onClick={() => setObsSel(l.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setObsSel(l.id); } }}>
                      <span className="nDot" style={{ background: l.color }} />
                      <span className="nName">{l.label}</span>
                      <span className="cnt">{st.n}·{st.pids}</span>
                    </div>
                  );
                }) : allPids.map((p) => {
                  const n = notices.filter((x) => x.pid === p).length;
                  return (
                    <div key={p} className={"nLens" + (obsSel === p ? " sel" : "") + (n === 0 ? " none" : "")}
                      tabIndex={0} role="button" aria-pressed={obsSel === p}
                      onClick={() => setObsSel(p)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return; // the run button's keys are its own
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setObsSel(p); }
                      }}>
                      <span className="nName">{p}</span>
                      {/* an em dash, not 0: the row is a launcher too, and "0 observations"
                          reads as a result where "never scanned" is the actual state */}
                      <span className="cnt">{n || "—"}</span>
                      <button className="rowRun" aria-label={`AI observation scan for ${p}`}
                        title={`AI observation scan for ${p}`}
                        onClick={(e) => { e.stopPropagation(); setScanFor(p); }}>
                        <Icon name="sparkle" size={14} />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </>
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
        ) : panel === "summary" ? (
          <>
            {/* Same two ways in as the other panels: the button picks in the modal,
                a row's sparkle opens it already scoped to that transcript. */}
            <button className="btn groundBtn" onClick={() => setSumFor("")} disabled={allPids.length === 0}
              title={allPids.length
                ? "Pick a transcript and let the AI draft its session summary from the events and coded excerpts (sends them to OpenAI after your approval)"
                : "Import a transcript first"}>
              <Icon name="sparkle" size={15} /> AI transcript summary…
            </button>
            {allPids.length === 0 ? (
              <div className="bSideNote">No transcripts loaded yet — import one and its session can be summarised from here.</div>
            ) : allPids.map((p) => {
              const ev = markers.filter((m) => m.pid === p).length;
              const seg = segments.filter((s) => s.pid === p && s.status === "accepted").length;
              return (
                <div key={p} className={"nLens" + (ev + seg === 0 ? " none" : "")}
                  tabIndex={0} role="button"
                  onClick={() => openSummary(p)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSummary(p); }
                  }}>
                  <span className="nName">{p}</span>
                  <span className="cnt">{ev + seg || "—"}</span>
                  <button className="rowRun" aria-label={`AI transcript summary for ${p}`}
                    title={`AI transcript summary for ${p}`}
                    onClick={(e) => { e.stopPropagation(); setSumFor(p); }}>
                    <Icon name="sparkle" size={14} />
                  </button>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {/* Two ways in, one modal. The button is the one that works in every
                state (the per-row sparkles below only exist while grouping by
                transcript); a row's sparkle just opens the same dialog on that
                transcript, where the model, the payload and the price still are. */}
            <button className="btn groundBtn" onClick={() => setSuggestFor("")} disabled={!hasCodes}
              title={hasCodes
                ? "Pick a transcript and let the AI propose where your codes apply (sends it to OpenAI after your approval)"
                : "Add a code first — suggestions apply your existing codes"}>
              <Icon name="sparkle" size={15} /> AI code suggestion…
            </button>
            {/* two equal halves rather than the pill pair that sized to its own
                text and left a dead rail on the right; the label says GROUPING,
                which the bare pair read as filtering */}
            <div className="aByLabel" id="suggestByLabel">Group by</div>
            <div className="segmented aSuggestBy" role="group" aria-labelledby="suggestByLabel">
              <button className={"seg" + (suggestBy === "transcript" ? " on" : "")}
                aria-pressed={suggestBy === "transcript"}
                onClick={() => pickSuggestBy("transcript")}>Transcript</button>
              <button className={"seg" + (suggestBy === "code" ? " on" : "")}
                aria-pressed={suggestBy === "code"}
                onClick={() => pickSuggestBy("code")}>Code</button>
            </div>
            {suggestGroups.length === 0 ? (
              <div className="bSideNote">
                {suggestBy === "transcript"
                  ? "No transcripts loaded yet — import one and it can be sent for suggestions from here."
                  : "No candidate codings yet. Run AI code suggestion on a transcript; they land here and striped in the transcript."}
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
                  <div key={g.key} className={"nLens" + (suggestSel === g.key ? " sel" : "") + (g.n === 0 ? " none" : "")}
                    tabIndex={0} role="button" aria-pressed={suggestSel === g.key}
                    onClick={() => setSuggestSel(g.key)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return; // the run button's keys are its own
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSuggestSel(g.key); }
                    }}>
                    {suggestBy === "code" && <span className="nDot" style={{ background: codebook[g.key]?.color ?? "#888" }} />}
                    <span className="nName">{g.key}</span>
                    {/* an em dash, not 0: the row is a launcher too, and "0 candidates"
                        reads as a result where "never run" is the actual state */}
                    <span className="cnt">{g.n || "—"}</span>
                    {suggestBy === "transcript" && (
                      <button className="rowRun" aria-label={`AI code suggestion for ${g.key}`}
                        title={hasCodes ? `AI code suggestion for ${g.key}` : "Add a code first — suggestions apply your existing codes"}
                        disabled={!hasCodes}
                        onClick={(e) => { e.stopPropagation(); setSuggestFor(g.key); }}>
                        <Icon name="sparkle" size={14} />
                      </button>
                    )}
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
              notices={shownNotices}
              groupBy={obsBy === "lens" ? "transcript" : "lens"}
              pidOrder={allPids}
              onlyUncoded={onlyUncoded}
              setOnlyUncoded={setOnlyUncoded}
            />
          ) : (
            <div className="empty">
              Nothing to review yet. Run an <b>AI observation scan</b> on a transcript — the button
              on the left, or the sparkle on any transcript row — and its marks show up here.
              It points, you decide what becomes a code.
            </div>
          )
        ) : panel === "merge" ? (
          <MergeList proposals={liveProposals} codebook={codebook} flipped={flipped}
            onAccept={accept} onSkip={skip} onFlip={toggleFlip} />
        ) : panel === "summary" ? (
          <SummaryList pids={allPids} summaries={summaries} onGenerate={setSumFor} />
        ) : (
          <SuggestList candidates={shownCandidates} groupBy={suggestBy}
            transcripts={transcripts} codebook={codebook} tabs={tabs} />
        )}
      </div>
      {mergeOpen && <MergeModal onProposals={(p) => { setProposals(p); setFlipped(new Set()); }}
        onClose={() => setMergeOpen(false)} />}
      {suggestFor !== null && <SuggestModal pid={suggestFor} choose
        onClose={() => setSuggestFor(null)} />}
      {scanFor !== null && <AiCheckModal pid={scanFor} choose
        onClose={() => setScanFor(null)} />}
      {sumFor !== null && <SummarizeModal pid={sumFor} choose
        onClose={() => setSumFor(null)} />}
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
        No candidate codings here. Run <b>AI code suggestion</b> on a transcript — the button on the
        left, or the sparkle on any transcript row — and the AI's proposals (existing codes applied
        to line ranges) show up here to accept or reject.
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

// What each session's summary says, at a glance — the full text lives (and is
// edited) in the Summary tab; "open" lands there on that transcript.
function SummaryList({ pids, summaries, onGenerate }: {
  pids: string[]; summaries: Record<string, string>; onGenerate: (pid: string) => void;
}) {
  if (!pids.length) {
    return <div className="empty">No transcripts loaded yet — import one and its session can be summarised here.</div>;
  }
  return (
    <div className="mList">
      {pids.map((p) => {
        const text = summaries[p]?.trim() ?? "";
        return (
          <div key={p} className="nInst sumSnip">
            <div className="nGrp">{p}</div>
            {text
              ? <div className="nLine sumSnipText">{text}</div>
              : <div className="nLine"><em>No summary yet — write one in the Summary tab, or draft it with AI.</em></div>}
            <div className="nFoot">
              <span className="nActs">
                <button className="nBtn pri" onClick={() => onGenerate(p)}>{text ? "regenerate…" : "generate…"}</button>
                <button className="nBtn" onClick={() => openSummary(p)}>open</button>
              </span>
            </div>
          </div>
        );
      })}
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

// The instances the sidebar's slice let through, grouped by the axis the sidebar
// ISN'T slicing by (pick a lens, read it across transcripts; pick a transcript,
// read it across lenses). The staging area for the move from observation to code:
// "code…" writes a segment for the instance's LINE (your unit of analysis),
// authored by you — the AI pointed, you named it. Coded instances stay visible with
// a badge (hiding them would misreport what the AI found); the Only-uncoded filter
// is what turns the list into a worklist.
function NoticeList({ notices, groupBy, pidOrder, onlyUncoded, setOnlyUncoded }: {
  notices: Notice[];
  groupBy: "transcript" | "lens";
  pidOrder: string[];
  onlyUncoded: boolean;
  setOnlyUncoded: (v: boolean) => void;
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

  // group headers: transcripts in tab order, lenses in the order the scan lists them
  const groups = (groupBy === "transcript"
    ? pidOrder
    : LENSES.filter((l) => l.id !== "transcription").map((l) => l.id)
  ).filter((k) => shown.some((n) => (groupBy === "transcript" ? n.pid : n.lens) === k));

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
            ? "Nothing here yet — scan a transcript with the lens you're after ticked."
            : "No uncoded instances left here — you've been through everything the AI found."}
        </div>
      )}
      {groups.map((g) => (
        <div key={g} className="bGroup">
          <div className="nGrp">
            {groupBy === "lens" && <span className="nDot" style={{ background: lensOf(g)?.color ?? "#888", marginRight: 6 }} />}
            {groupBy === "lens" ? lensOf(g)?.label ?? g : g}
          </div>
          {shown.filter((n) => (groupBy === "transcript" ? n.pid : n.lens) === g).map((n) => {
            const key = `${n.pid}:${n.id}:${n.quote}`;
            // colour comes from the instance's OWN lens: a group can hold several
            // (grouped by transcript) and one shared colour would misattribute them
            const c = lensOf(n.lens)?.color ?? "#888";
            return (
              <div key={key} className="nInst" style={{ "--lens-c": c } as CSSProperties}>
                <div className="nLine">{lineWithQuote(n.text, n.quote, c)}</div>
                <div className="nWhy">{n.reason}</div>
                {coding === key ? (
                  <div className="nCode">
                    <CodeCombobox autoFocus placeholder="code this line…"
                      onPick={(c) => codeInstance(n, c)} onClose={() => setCoding(null)} />
                  </div>
                ) : (
                  <div className="nFoot">
                    <span className="nRef">{n.pid}:{n.id} · {n.speaker}
                      {groupBy === "transcript" && ` · ${lensOf(n.lens)?.label ?? n.lens}`}</span>
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
