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
import { DescribeModal } from "./DescribeModal";
import { AskModal } from "./AskModal";
import { AskList, ScopeGroup } from "./AskPanel";
import { SuggestModal } from "./SuggestModal";
import { AiCheckModal } from "./AiCheckModal";
import { SummarizeModal } from "./SummarizeModal";
import { openSummary } from "./SummaryView";
import type { MergeProposal } from "../ai/dedupe";
import { segExcerpt } from "../contract/excerpt";
import { DefLine } from "./CodeDef";
import { codeStats, sortCodes, SORTS, type CodeStat, type SortBy } from "../codeStats";
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
  defSort: "name" as SortBy,
  defScope: "all" as DefScope,       // which part of the codebook the panel is working through
  defSel: [] as string[],            // specific codes picked inside that scope; empty = the whole scope
  defAnchor: null as string | null,  // where a Shift-range measures from
  defOpen: { undefined: true, defined: true } as Record<"undefined" | "defined", boolean>,
  // Ask scope. null = "everything", resolved against the project at render — a
  // stored list would silently stop covering a transcript imported afterwards,
  // which is the wrong default for a question about the whole study.
  askPids: null as string[] | null,
  askCodes: null as string[] | null,
  askEvents: true,
  askExcerpts: true,
  askQ: "",
};
type DefScope = "all" | "undefined" | "defined";
// one word each: three segments in a 264px sidebar, and "No definition" wrapped
// to two lines and shoved the control out of shape
const DEF_SCOPES = [
  { id: "all", label: "All" },
  { id: "undefined", label: "Undefined" },
  { id: "defined", label: "Defined" },
] as const;
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
  const [describeOpen, setDescribeOpen] = useState(false);
  // null = closed; "" = open with nothing picked; a pid = open on that transcript
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [sumFor, setSumFor] = useState<string | null>(null);
  const [suggestBy, setSuggestBy] = useState(remembered.suggestBy);
  const [suggestSel, setSuggestSel] = useState(remembered.suggestSel);
  const [defSort, setDefSort] = useState(remembered.defSort);
  const [defScope, setDefScope] = useState(remembered.defScope);
  const [defSel, setDefSel] = useState(remembered.defSel);
  const [defAnchor, setDefAnchor] = useState(remembered.defAnchor);
  const [defOpen, setDefOpen] = useState(remembered.defOpen);
  const [askPids, setAskPids] = useState(remembered.askPids);
  const [askCodes, setAskCodes] = useState(remembered.askCodes);
  const [askEvents, setAskEvents] = useState(remembered.askEvents);
  const [askExcerpts, setAskExcerpts] = useState(remembered.askExcerpts);
  const [askQ, setAskQ] = useState(remembered.askQ);
  const [askOpen, setAskOpen] = useState(false);
  // which code's definition is open in an editor right now (deliberately NOT
  // remembered across tab changes — the editor unmounts with the view)
  const [editingDef, setEditingDef] = useState<string | null>(null);
  useEffect(() => { Object.assign(remembered, { obsBy, obsSel, onlyUncoded, proposals, flipped, suggestBy, suggestSel, defSort, defScope, defSel, defAnchor, defOpen, askPids, askCodes, askEvents, askExcerpts, askQ }); },
    [obsBy, obsSel, onlyUncoded, proposals, flipped, suggestBy, suggestSel, defSort, defScope, defSel, defAnchor, defOpen, askPids, askCodes, askEvents, askExcerpts, askQ]);

  // Definitions panel: every code, split by whether it has a definition yet —
  // the split IS the worklist, so it's the sidebar's grouping. Both groups (and
  // the main list) take the same sort.
  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const defGroups = useMemo(() => {
    const all = Object.keys(codebook);
    const order = (cs: string[]) => sortCodes(cs, stats, defSort);
    return {
      defined: order(all.filter((c) => codebook[c].def)),
      undefined: order(all.filter((c) => !codebook[c].def)),
    };
  }, [codebook, stats, defSort]);
  // The panel answers two different questions, so it has two controls. SCOPE
  // (all / undefined / defined) is "which part of the codebook am I working
  // through" and filters both panes; SELECTION is "these specific codes" and,
  // while it holds any, narrows the list further. Undefined comes first in
  // "all": it's the work left to do.
  const defVisible = useMemo(() => (
    defScope === "undefined" ? defGroups.undefined
    : defScope === "defined" ? defGroups.defined
    : [...defGroups.undefined, ...defGroups.defined]
  ), [defScope, defGroups]);
  // What a Shift-range may span: the codes actually on screen. Measured over
  // defVisible instead, a range across a COLLAPSED group silently swept in every
  // code hidden inside it — "a range means what it looks like" stopped being
  // true the moment groups could close.
  const defReachable = useMemo(() => (
    defScope === "undefined" ? (defOpen.undefined ? defGroups.undefined : [])
    : defScope === "defined" ? (defOpen.defined ? defGroups.defined : [])
    : [...(defOpen.undefined ? defGroups.undefined : []),
       ...(defOpen.defined ? defGroups.defined : [])]
  ), [defScope, defGroups, defOpen]);
  // a selected code that has since been merged or deleted must not filter the
  // list down to nothing
  const liveSel = defSel.filter((c) => codebook[c] && defVisible.includes(c));
  // A row that is mid-edit stays on the list whatever the filters say. Its
  // editor holds unsaved text in local state, so narrowing the list — picking
  // another code in the sidebar, changing the scope — used to unmount it and
  // take everything typed with it, silently and with nothing written.
  const shownDefCodes = (() => {
    const base = liveSel.length ? defVisible.filter((c) => liveSel.includes(c)) : defVisible;
    return editingDef && codebook[editingDef] && !base.includes(editingDef)
      ? [...base, editingDef] : base;
  })();

  // Same gesture as the Codebook's code list: plain click picks one (or clears
  // it), Ctrl/Cmd toggles, Shift takes the range — over the order on screen, so
  // a range means what it looks like.
  const pickDefCode = (c: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.shiftKey && defAnchor && defReachable.includes(defAnchor)) {
      const a = defReachable.indexOf(defAnchor), b = defReachable.indexOf(c);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setDefSel(defReachable.slice(lo, hi + 1));
      return; // keep the anchor
    }
    // functional: a toggle reads the CURRENT selection, not the one this render
    // closed over — two clicks inside one tick would otherwise both see []
    if (e.ctrlKey || e.metaKey) {
      setDefSel((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
      setDefAnchor(c); return;
    }
    const clearing = defSel.length === 1 && defSel[0] === c; // clicking the only pick clears it
    setDefSel(clearing ? [] : [c]);
    setDefAnchor(clearing ? null : c);
  };
  // a new scope is a new question — the codes picked under the old one don't carry
  const pickDefScope = (s: DefScope) => { setDefScope(s); setDefSel([]); setDefAnchor(null); };
  const pickSuggestBy = (by: "transcript" | "code") => { setSuggestBy(by); setSuggestSel(null); };
  const pickObsBy = (by: "lens" | "transcript") => { setObsBy(by); setObsSel(null); };
  // open tabs first, then the rest of what's loaded — the order both panels list in
  const allPids = useMemo(() =>
    [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))].filter((p) => transcripts[p]),
    [tabs, transcripts]);

  // Ask scope, resolved. null means "all of it", so a transcript or code added
  // after the panel was last touched is in scope by default rather than silently
  // outside it. Codes are those actually USED in the transcripts in scope —
  // offering a code with no excerpts there would be offering nothing.
  const answers = useStore((s) => s.answers);
  const askPidList = allPids;
  // intersected with what EXISTS: the remembered picks outlive a project swap and
  // a rename, and a scope holding a dead pid would disagree with the sidebar that
  // is meant to be showing it
  const onPids = useMemo(
    () => new Set(askPids ? askPidList.filter((p) => askPids.includes(p)) : askPidList),
    [askPids, askPidList]);
  const askCodeList = useMemo(() => {
    const n = new Map<string, number>();
    for (const g of segments) {
      if (g.status !== "accepted" || !onPids.has(g.pid)) continue;
      n.set(g.code, (n.get(g.code) ?? 0) + 1);
    }
    return [...n.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, c]) => ({ id, n: c }));
  }, [segments, onPids]);
  const onCodes = useMemo(
    () => new Set(askCodes ? askCodeList.map((c) => c.id).filter((c) => askCodes.includes(c)) : askCodeList.map((c) => c.id)),
    [askCodes, askCodeList]);
  // filtered to what still EXISTS: a transcript or code deleted since the scope
  // was last touched would otherwise be recorded on the answer as material it
  // covered, which is exactly the claim the stored scope is there to make
  const askScope = useMemo(() => ({
    pids: [...onPids], codes: [...onCodes],
    events: askEvents, excerpts: askExcerpts,
  }), [onPids, onCodes, askEvents, askExcerpts]);
  const askWhy = !askQ.trim() ? "Type a question first"
    : !onPids.size ? "Pick at least one transcript on the left"
    : !askEvents && !askExcerpts ? "Turn on excerpts or events on the left"
    : askExcerpts && !onCodes.size && !askEvents ? "Pick at least one code on the left"
    : "";

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
  // A selection whose row is gone reads as "all", like liveSel and liveProposals
  // already do. Grouped by code the rows come only from codes that still HAVE
  // candidates, so resolving the last one of the code you were working through
  // took its row away and left the pane empty with nothing highlighted and no
  // visible cause.
  const liveSuggestSel = suggestGroups.some((g) => g.key === suggestSel) ? suggestSel : null;
  const shownCandidates = liveSuggestSel == null ? candidates
    : candidates.filter((c) => (suggestBy === "transcript" ? c.pid : c.code) === liveSuggestSel);

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
  // same liveness guard as the Suggest panel: closing a transcript takes its row
  // away, and a selection pointing at it would empty the pane with no row lit
  const obsKeys = obsBy === "lens" ? observeLenses.map((l) => l.id) : allPids;
  const liveObsSel = obsSel !== null && obsKeys.includes(obsSel) ? obsSel : null;
  const shownNotices = liveObsSel == null ? notices
    : notices.filter((n) => (obsBy === "lens" ? n.lens : n.pid) === liveObsSel);

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* the panel (Observations / Merge / Suggest) is picked from the Assist tab's
            own menu — this heading just names what's showing. It stays fixed; the
            list below scrolls inside cbList so the scrollbar clears the drag divider. */}
        <div className="bSideHead">{panel === "merge" ? "Merge codes" : panel === "ask" ? "Ask" : panel === "describe" ? "Definitions" : panel === "suggest" ? "Suggest codes" : panel === "summary" ? "Transcript summary" : "Observations"}</div>

        <div className="cbList nicescroll">
        {panel === "observations" ? (
          <>
            {/* Same two ways in as the Suggest panel: a button that works in every
                state, and a sparkle on each transcript row (grouped by transcript). */}
            <button className="btn groundBtn" onClick={() => setScanFor("")} disabled={allPids.length === 0}
              title={allPids.length
                ? "Pick a transcript and let the AI mark instances under the lenses you tick (sends those lines to OpenAI after your approval)"
                : "Import a transcript first"}>
              <Icon name="sparkle" size={15} /> AI observation scan
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
                <div className={"nLens" + (liveObsSel === null ? " sel" : "")}
                  tabIndex={0} role="button" aria-pressed={liveObsSel === null}
                  onClick={() => setObsSel(null)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setObsSel(null); } }}>
                  <span className="nName">All</span>
                  <span className="cnt">{notices.length}</span>
                </div>
                {obsBy === "lens" ? observeLenses.map((l) => {
                  const st = lensStats(l.id);
                  return (
                    <div key={l.id} className={"nLens" + (liveObsSel === l.id ? " sel" : "") + (st.n === 0 ? " none" : "")}
                      tabIndex={0} role="button" aria-pressed={liveObsSel === l.id}
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
                    <div key={p} className={"nLens" + (liveObsSel === p ? " sel" : "") + (n === 0 ? " none" : "")}
                      tabIndex={0} role="button" aria-pressed={liveObsSel === p}
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
              <Icon name="sparkle" size={15} /> Find duplicates
            </button>
            <div className="bSideNote">
              {mergeableCount < 2
                ? "Code at least two different codes first, then the AI can look for duplicates."
                : "The AI proposes pairs that look like the same concept. You accept each merge — nothing changes on its own."}
            </div>
          </>
        ) : panel === "ask" ? (
          <>
            <div className="bSideNote">
              Scope the question. Everything is in by default — narrow it to a participant
              or a theme when you mean to, not out of habit: deciding what matters before
              you ask is the job you are handing to the model.
            </div>
            <div className="aByLabel" id="askMatLabel">Material</div>
            <div className="segmented aSuggestBy" role="group" aria-labelledby="askMatLabel">
              <button className={"seg" + (askExcerpts ? " on" : "")} aria-pressed={askExcerpts}
                onClick={() => setAskExcerpts((v) => !v)}>Excerpts</button>
              <button className={"seg" + (askEvents ? " on" : "")} aria-pressed={askEvents}
                onClick={() => setAskEvents((v) => !v)}>Events</button>
            </div>
            <ScopeGroup title="Transcripts" items={askPidList.map((p) => ({ id: p, label: p }))}
              on={onPids}
              onToggle={(id) => setAskPids((prev) => {
                const cur = new Set(prev ?? askPidList);
                cur.has(id) ? cur.delete(id) : cur.add(id);
                return askPidList.filter((p) => cur.has(p));
              })}
              onAll={(all) => setAskPids(all ? null : [])} />
            <ScopeGroup title="Codes" disabled={!askExcerpts} unit="excerpts in the transcripts in scope"
              items={askCodeList.map((c) => ({ id: c.id, label: c.id, n: c.n, color: codebook[c.id]?.color }))}
              on={onCodes}
              onToggle={(id) => setAskCodes((prev) => {
                const cur = new Set(prev ?? askCodeList.map((c) => c.id));
                cur.has(id) ? cur.delete(id) : cur.add(id);
                return askCodeList.map((c) => c.id).filter((c) => cur.has(c));
              })}
              onAll={(all) => setAskCodes(all ? null : [])} />
          </>
        ) : panel === "describe" ? (
          <>
            <button className="btn groundBtn" onClick={() => setDescribeOpen(true)} disabled={mergeableCount < 1}
              title="Ask the AI to draft definitions from each code's excerpts (sends them to OpenAI after your approval)">
              <Icon name="sparkle" size={15} /> Draft definitions
            </button>
            <div className="bSideNote">
              {mergeableCount < 1
                ? "Definitions are drafted from coded excerpts — code a bit first."
                : `Drafts definitions for the ${shownDefCodes.length} code${shownDefCodes.length === 1 ? "" : "s"} showing on the right, from how you used them. They are written straight in — edit any of them here afterwards.`}
            </div>
            {Object.keys(codebook).length > 0 && (
              <>
                <div className="aByLabel" id="defScopeLabel">Show</div>
                <div className="segmented aSuggestBy defScope" role="group" aria-labelledby="defScopeLabel">
                  {DEF_SCOPES.map((s) => (
                    <button key={s.id} className={"seg" + (defScope === s.id ? " on" : "")}
                      aria-pressed={defScope === s.id} onClick={() => pickDefScope(s.id)}
                      title={s.id === "all" ? `All ${Object.keys(codebook).length} codes`
                        : s.id === "undefined" ? `${defGroups.undefined.length} codes with no definition yet`
                        : `${defGroups.defined.length} codes that have one`}>
                      {s.label}
                    </button>
                  ))}
                </div>
                {/* a group heading is dropped when the scope already excludes it */}
                {([["undefined", "No definition yet", defGroups.undefined],
                   ["defined", "Has a definition", defGroups.defined]] as const)
                  .filter(([key]) => defScope === "all" || defScope === key)
                  .map(([key, label, group]) => (
                    <div key={key}>
                      <button className="nGrp defGrp" aria-expanded={defOpen[key]}
                        onClick={() => setDefOpen((o) => ({ ...o, [key]: !o[key] }))}>
                        <Icon name={defOpen[key] ? "chevron-down" : "chevron-right"} size={13} />
                        <span className="defGrpName">{label}</span>
                        <span className="cnt">{group.length}</span>
                      </button>
                      {defOpen[key] && (group.length === 0
                        ? <div className="bSideNote defNone">none</div>
                        : group.map((c) => (
                          <div key={c} className={"nLens" + (liveSel.includes(c) ? " sel" : "")}
                            tabIndex={0} role="button" aria-pressed={liveSel.includes(c)}
                            aria-label={`${c}, ${stats[c]?.segs ?? 0} excerpts in ${stats[c]?.pids ?? 0} transcripts`}
                            onClick={(e) => pickDefCode(c, e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickDefCode(c, e); }
                            }}>
                            <span className="nDot" style={{ background: codebook[c].color }} />
                            <span className="nName">{c}</span>
                            {/* "3·2" is a glance-stat, not a name: spelled out for
                                the row's label and hidden from the reading order,
                                like every other code list in the app */}
                            <span className="cnt" aria-hidden="true">{stats[c]?.segs ?? 0}·{stats[c]?.pids ?? 0}</span>
                          </div>
                        )))}
                    </div>
                  ))}
                {/* clearing a selection lives in the list's own header, where
                    there is room for it — a full-width control in this narrow
                    scrolling column kept provoking a horizontal scrollbar */}
                <div className="bSideNote defHint">Click a code to focus it · <b>Ctrl</b> adds · <b>Shift</b> takes a range</div>
              </>
            )}
          </>
        ) : panel === "summary" ? (
          <>
            {/* Same two ways in as the other panels: the button picks in the modal,
                a row's sparkle opens it already scoped to that transcript. */}
            <button className="btn groundBtn" onClick={() => setSumFor("")} disabled={allPids.length === 0}
              title={allPids.length
                ? "Pick a transcript and let the AI draft its session summary from the events and coded excerpts (sends them to OpenAI after your approval)"
                : "Import a transcript first"}>
              <Icon name="sparkle" size={15} /> AI transcript summary
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
              <Icon name="sparkle" size={15} /> AI code suggestion
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
                <div className={"nLens" + (liveSuggestSel === null ? " sel" : "")}
                  tabIndex={0} role="button" aria-pressed={liveSuggestSel === null}
                  onClick={() => setSuggestSel(null)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSuggestSel(null); } }}>
                  <span className="nName">All</span>
                  <span className="cnt">{candidates.length}</span>
                </div>
                {suggestGroups.map((g) => (
                  <div key={g.key} className={"nLens" + (liveSuggestSel === g.key ? " sel" : "") + (g.n === 0 ? " none" : "")}
                    tabIndex={0} role="button" aria-pressed={liveSuggestSel === g.key}
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
        ) : panel === "ask" ? (
          <AskList answers={answers} question={askQ} setQuestion={setAskQ}
            onAsk={() => setAskOpen(true)} canAsk={!askWhy} why={askWhy} />
        ) : panel === "describe" ? (
          <DescribeList codebook={codebook} codes={shownDefCodes} stats={stats}
            sortBy={defSort} setSortBy={setDefSort} grouped={defScope === "all"}
            undefinedCodes={defGroups.undefined}
            onEditing={(c, on) => setEditingDef((prev) => (on ? c : prev === c ? null : prev))}
            picked={liveSel.length} total={defVisible.length}
            onClear={() => { setDefSel([]); setDefAnchor(null); }} />
        ) : (
          <SuggestList candidates={shownCandidates} groupBy={suggestBy}
            transcripts={transcripts} codebook={codebook} tabs={tabs} />
        )}
      </div>
      {mergeOpen && <MergeModal onProposals={(p) => { setProposals(p); setFlipped(new Set()); }}
        onClose={() => setMergeOpen(false)} />}
      {describeOpen && <DescribeModal initial={shownDefCodes} onClose={() => setDescribeOpen(false)} />}
      {askOpen && <AskModal question={askQ.trim()} scope={askScope} onClose={() => setAskOpen(false)} />}
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
              {/* the confident tier is the unmarked default; only the softer one is labelled */}
              {p.tier === "overlap" && <span className="mTier">worth considering</span>}
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

// The codebook's definitions as they stand — the surface the describe run
// writes into. Drafting/editing/applying happens in the modal; this list is
// where you see which codes still have no definition.
function DescribeList({ codebook, codes, stats, sortBy, setSortBy, grouped, undefinedCodes,
  onEditing, picked, total, onClear }: {
  codebook: Record<string, { color: string; def: string; status: string; defAi?: boolean }>;
  codes: string[];                       // already filtered by the sidebar and sorted
  stats: Record<string, CodeStat>;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  grouped: boolean;                      // scope "all" hoists the undefined codes — say so
  undefinedCodes: string[];              // which side of the split each code falls on
  // (code, open). Only the row that CLAIMED the flag may clear it: every DefLine
  // reports false as it unmounts, and the rows being filtered away unmount in the
  // same commit as the one we are trying to keep.
  onEditing: (code: string, on: boolean) => void;
  picked: number;                        // codes picked in the sidebar, 0 = whole scope
  total: number;                         // codes the scope holds
  onClear: () => void;
}) {
  if (!Object.keys(codebook).length) {
    return (
      <div className="empty">
        No codes yet. Once you've coded, run <b>Draft definitions</b> on the left and the AI
        drafts a definition for each code from its excerpts — you edit and apply every one.
      </div>
    );
  }
  return (
    <>
      <div className="bOptions nOpts descListBar">
        {/* descSortLabel, not aByLabel: that one carries margins for a STACKED
            label and sat off-centre from the pills beside it */}
        <span className="descSortLabel" id="defSortLabel">Sort</span>
        <div className="nPills" role="group" aria-labelledby="defSortLabel">
          {SORTS.map((s) => (
            <button key={s.id} className={"nPill" + (sortBy === s.id ? " on" : "")}
              aria-pressed={sortBy === s.id} onClick={() => setSortBy(s.id)}>{s.label}</button>
          ))}
        </div>
        {picked > 0 ? (
          <span className="nCount">
            {picked} of {total} codes
            <button className="defClear" onClick={onClear}>Clear</button>
          </span>
        ) : (
          <span className="nCount">{codes.length} code{codes.length === 1 ? "" : "s"}</span>
        )}
      </div>
      {codes.length === 0 ? (
        <div className="empty">No codes here. Widen the <b>Show</b> filter on the left.</div>
      ) : (
        <div className="mList">
          {codes.map((c, i) => {
            // Under scope "all" the list is hoisted undefined-first, which read as
            // a broken A-Z sort with nothing to explain it. Print the same two
            // headings the sidebar uses, at the point the list crosses over.
            const undef = undefinedCodes.includes(c);
            const head = grouped && (i === 0 || undefinedCodes.includes(codes[i - 1]) !== undef)
              ? (undef ? "No definition yet" : "Has a definition") : null;
            return (
              <div key={c} className="descGroupItem">
                {head && <div className="nGrp descListGrp">{head}</div>}
                <div className="descRow">
                  <div className="descHead">
                    <span className="descName">
                      <span className="mSw" style={{ background: codebook[c].color }} />
                      <b>{c}</b>
                    </span>
                    {/* the same evidence counts the draft picker shows */}
                    <span className="cnt" title={`${stats[c]?.segs ?? 0} excerpt${stats[c]?.segs === 1 ? "" : "s"} in ${stats[c]?.pids ?? 0} transcript${stats[c]?.pids === 1 ? "" : "s"}`}>
                      {stats[c]?.segs ?? 0}·{stats[c]?.pids ?? 0}
                    </span>
                  </div>
                  {/* this panel has no excerpt list of its own, so the definition line
                      carries a disclosure for a few of the code's quotes */}
                  <DefLine code={c} excerpts
                    onEditing={(on) => onEditing(c, on)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
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
  const excerptFor = (s: Segment) => {
    const t = transcripts[s.pid];
    return t ? segExcerpt(s, t.lines) : null;
  };
  const row = (s: Segment) => {
    const range = `${s.start}${s.end !== s.start ? `-${s.end}` : ""}`;
    const ex = excerptFor(s); // once per row: it walks the transcript's lines
    return (
      <div key={s.sid} className="nInst" style={{ "--lens-c": codebook[s.code]?.color ?? "#888" } as CSSProperties}>
        <div className="mPair" style={{ marginBottom: 4 }}>
          <span className="mCode"><span className="mSw" style={{ background: codebook[s.code]?.color || "#999" }} />{s.code}</span>
          <span className="nRef">{s.proposedBy}</span>
        </div>
        <div className="nLine">{ex?.excerpt || "(excerpt unavailable)"}</div>
        <div className="nFoot">
          {/* the speaker as a field, like the Codebook: without it a line the
              interviewer dominated read as the participant's words */}
          <span className="nRef"><span className="refspk">{ex?.speaker}</span>{s.pid}:{range}</span>
          <span className="nActs">
            <button className="nBtn pri" onClick={() => setStatus(s.sid, "accepted")}>Accept</button>
            <button className="nBtn" onClick={() => setStatus(s.sid, "rejected")}>Reject</button>
            <button className="nBtn" onClick={() => jumpTo(s.pid, s.start)}>Open</button>
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
                {/* it spends an API call, so it carries the app's AI mark */}
                <button className="nBtn pri" onClick={() => onGenerate(p)}>
                  <Icon name="sparkle" size={12} />{text ? "Regenerate" : "Generate"}
                </button>
                <button className="nBtn" onClick={() => openSummary(p)}>Open</button>
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
      <div className="bOptions nOpts descListBar">
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
                      {/* no sparkle: you pick the code, this spends nothing */}
                      {!n.codedAs && <button className="nBtn pri" onClick={() => setCoding(key)}>Code</button>}
                      <button className="nBtn" onClick={() => jumpTo(n.pid, n.id)}>Open</button>
                      <button className="nBtn" title="Remove this observation (it won't be re-fetched)"
                        onClick={() => useStore.getState().dismissNotice(n.pid, n.id, n.lens, n.quote)}>Dismiss</button>
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
