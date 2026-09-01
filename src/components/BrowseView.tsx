// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Codebook tab: go over your coding. Codes on the left, their excerpts on the
// right. The AI's observations moved out to the Assist tab; this view is yours.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { linesOf, useStore, liveCodes, parkedCodes, clampEventHeight, type Segment } from "../state/store";
import { stretchesAt, stretchColorOf } from "../stretches";
import { norm } from "../contract/segments";
import { segExcerpt, type DroppedSpeaker } from "../contract/excerpt";
import { speakerGroups } from "../format";
import { withSubs, SubText, subSpans } from "../markup";
import { Resizer } from "./Resizer";
import { CodeMenu } from "./CodeMenu";
import { HeightGrip } from "./EventList";
import { openColorPicker } from "../colorPicker";
import { DefLine } from "./CodeDef";
import { groundHash } from "../ai/ground";
import { GroundModal } from "./GroundModal";
import { DescribeModal } from "./DescribeModal";
import { useToggleMenu, useDismiss, useMenuArrows, useMenuFocus } from "../usePopover";
import { Icon, countIconSize } from "./Icon";
import { CodeCounts } from "./CodeCounts";
import { announce } from "../announce";
import { onProjectSwap } from "../sessionReset";
import { codeStats, sortCodes, SORTS, type SortBy } from "../codeStats";
import { CodeSortChip } from "./CodeSortChip";
import { EMPTY_CODEBOOK_FACETS, hasCodebookFacets, matchesCodebookFacets,
  matchesExcerptFacets, needsExcerptFacetData, type CodebookFacets,
  type ExcerptFacetValues } from "../codebookFacets";

// Codebook working state survives leaving the tab — the view unmounts, so plain
// useState would reset it on every visit. Facets stay here rather than in the
// persisted store: a reload must not silently hide evidence in a later session,
// and keeping them out of project data needs no file-format migration.
const remembered = {
  selected: new Set<string>(),
  anchor: null as string | null,
  filter: "",
  showRejected: false,
  facets: EMPTY_CODEBOOK_FACETS,
};

// The Code map's "Open in Codebook": arrive with exactly these codes chosen,
// no stale filter hiding them, and the excerpt pane back at the top.
export function preselectBrowse(codes: string[]) {
  remembered.selected = new Set(codes);
  remembered.anchor = null;
  remembered.filter = "";
  remembered.facets = EMPTY_CODEBOOK_FACETS;
  excerptScroll = 0;
}

// where the excerpt list was parked, for the same reason and in the same place
// as the rest of this cache
let excerptScroll = 0;
let codeListScroll = 0;

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const stretches = useStore((s) => s.stretches);
  const stretchColors = useStore((s) => s.ui.stretchColors);
  const dark = useStore((s) => s.ui.dark);
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const paneRef = useCallback((el: HTMLDivElement | null) => { if (el) el.scrollTop = excerptScroll; }, []);
  const listRef = useCallback((el: HTMLDivElement | null) => { if (el) el.scrollTop = codeListScroll; }, []);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const aiGrounds = useStore((s) => s.aiGrounds);
  // narrow subscriptions, not the whole ui object — setUi replaces `ui` on every
  // patch, and this view re-rendered its whole excerpt list on every one
  const groundBold = useStore((s) => s.ui.groundBold);
  const groundWash = useStore((s) => s.ui.groundWash);
  const groundUnderline = useStore((s) => s.ui.groundUnderline);
  const codeSort = useStore((s) => s.ui.codeSort);
  const uiGround = useMemo(() => ({ groundBold, groundWash, groundUnderline, codeSort }),
    [groundBold, groundWash, groundUnderline, codeSort]);
  const [groundOpen, setGroundOpen] = useState(false);
  const [describeOpen, setDescribeOpen] = useState(false);
  const hasGrounds = Object.keys(aiGrounds).length > 0;
  const setColor = useStore((s) => s.setColor);
  const setParked = useStore((s) => s.setParked);
  // open by default, like the events list it now mirrors: as a pinned shelf it
  // no longer pushes the live codes around, so showing it costs nothing
  const [parkOpen, setParkOpen] = useState(true);
  const parkHeight = useStore((s) => s.ui.parkListHeight);
  const jumpTo = useStore((s) => s.jumpTo);
  const [selected, setSelected] = useState<Set<string>>(remembered.selected);
  const [anchor, setAnchor] = useState<string | null>(remembered.anchor);
  const [filter, setFilter] = useState(remembered.filter);
  const [showRejected, setShowRejected] = useState(remembered.showRejected);
  const [facets, setFacets] = useState(remembered.facets);
  const announceFacetChange = useRef(false);
  // NOT in `remembered`, unlike the filter and the selection above: reading past
  // the dominant speaker is a momentary look at ONE excerpt, not working state
  // worth carrying out of the tab.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // which excerpts are showing their source text — same lifetime and the same
  // reasoning as `expanded` above: view state, reset when a project is swapped
  const [sourceOpen, setSourceOpen] = useState<Set<number>>(new Set());
  // whose definition is being written right now. A rename changes the group's
  // KEY, which unmounts it — and an unsaved definition lives in that component's
  // own state, so renaming would throw the draft away with no way back. The
  // Definitions panel already tracks this for the same reason.
  const [defEditing, setDefEditing] = useState<string | null>(null);
  // A rename changes the group's key, so the title that was focused unmounts and
  // its own restore cannot run — the caret lands on <body>. This names the title
  // that should take focus when it mounts: the SURVIVOR, which after a merge is
  // a different code entirely.
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  const [recolor, setRecolor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { Object.assign(remembered, { selected, anchor, filter, showRejected, facets }); },
    [selected, anchor, filter, showRejected, facets]);
  // Opening a project replaces the store in place. If the Codebook was the
  // active view in both files it never unmounts, so neither this component's
  // state nor `remembered` resets on its own — and both are keyed by
  // identifiers the next study reuses with different meanings: code NAMES for
  // the selection, and sids, which a new project hands out from 1 again. The
  // Code map registers the same forget-me for the same reason.
  useEffect(() => onProjectSwap(() => {
    setSelected(new Set()); setAnchor(null); setExpanded(new Set()); setSourceOpen(new Set());
    setFocusTitle(null);   // a name from the old project must not claim focus in the new one
  }), []);

  const counts = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const cntIcon = countIconSize(sidebarFontSize);

  // one pass over the segments, reused by every excerpt below: the per-excerpt
  // filters were O(all segments) EACH — a few hundred rendered excerpts
  // re-scanned the whole array on every render of this view
  const segIndex = useMemo(() => {
    const byCode = new Map<string, Segment[]>();
    const byPid = new Map<string, Segment[]>();
    for (const s of segments) {
      const ck = norm(s.code);
      const c = byCode.get(ck); c ? c.push(s) : byCode.set(ck, [s]);
      const p = byPid.get(s.pid); p ? p.push(s) : byPid.set(s.pid, [s]);
    }
    return { byCode, byPid };
  }, [segments]);

  // The excerpt's dominant speaker is shown as its own field in the ref row (below),
  // so the display text drops the "[R:] " prefix the export keeps baked in.
  const excerptFor = (s: Segment): {
    text: string;
    speaker: string;
    dropped: DroppedSpeaker[];
    closeCall: boolean;
    lines: { speaker: string; text: string }[];
    source: string;
  } | null => {
    const t = transcripts[s.pid];
    if (!t) return null;
    // binary-search the range start (ids are kept ascending — rehydrate sorts)
    // instead of filtering all of a 1000-line transcript per excerpt
    const lines = linesOf(transcripts, lang, s.pid);
    let lo = 0, hi = lines.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid].id < s.start) lo = mid + 1; else hi = mid; }
    const slice = [];
    for (let i = lo; i < lines.length && lines[i].id <= s.end; i++) slice.push(lines[i]);
    const r = segExcerpt(s, slice);
    // The same lines with the spoken text put back — not a second slice of the
    // stored array, which only lined up by an index coincidence. Dominance is
    // weighed on `src` in both runs, so the original quotes the same speaker
    // the excerpt above it does; without that the "original" of a
    // participant's quote could be the interviewer's line.
    const source = lang === "source" ? ""
      : segExcerpt(s, slice.map((l) => ({ ...l, text: l.src ?? l.text }))).excerpt;
    return { text: r.excerpt, speaker: r.speaker, dropped: r.dropped, closeCall: r.closeCall,
      lines: slice, source };
  };

  const excerptFacetsOn = needsExcerptFacetData(facets);
  // The filters are normally off. Paying for every excerpt only while one can
  // use the result keeps an ordinary trip through the Codebook at its old cost.
  const excerptFacetValues = useMemo(() => {
    if (!excerptFacetsOn) return null;
    const bySid = new Map<number, ExcerptFacetValues>();
    for (const s of segments) {
      const ex = excerptFor(s);
      // An absent transcript is unknown, not evidence that any claim about the
      // excerpt is true. Leaving it out makes every excerpt facet reject it.
      if (!ex) continue;
      bySid.set(s.sid, {
        mixedSpeakers: ex.dropped.length > 0,
        nearBalanced: ex.closeCall,
        note: s.notes,
      });
    }
    return bySid;
    // excerptFor is re-made every render, so listing it would run this on every
    // render and the memo would do nothing. `lang` is what it actually reads and
    // what was actually stale — the facets kept the previous reading's excerpts
    // after a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, transcripts, lang, excerptFacetsOn]);

  // a segment's grounding quotes, but only while the hash still matches what the
  // model saw (recode/resize/edit invalidates — same trick as the scan marks)
  const groundsFor = (seg: Segment, excerpt: string): string[] => {
    const g = aiGrounds[seg.sid];
    return g && g.hash === groundHash(seg.code, excerpt) ? g.quotes : [];
  };

  // the order the View menu asks for — the same three the transcript sidebar and
  // the Assist definitions panel offer, off the same setting
  const allCodes = useMemo(
    () => sortCodes(liveCodes(codebook), counts, codeSort), [codebook, counts, codeSort]);
  // the Codebook is where a set-aside code stays visible — everywhere else has
  // stopped offering it, so this list is the only way back
  const parked = useMemo(
    () => sortCodes(parkedCodes(codebook), counts, codeSort), [codebook, counts, codeSort]);
  const hit = (c: string) => c.toLowerCase().includes(filter.toLowerCase());
  // memoised so the lists below can be: a fresh array every render would defeat
  // their dependency arrays and re-run the whole predicate on every keystroke,
  // which is the cost those memos exist to avoid
  const namedCodes = useMemo(() => allCodes.filter(hit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCodes, filter]);
  const namedParked = useMemo(() => parked.filter(hit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parked, filter]);
  // Show rejected is a question about STATUS, not a facet: it decides what a code
  // is even being judged on, and the facets then narrow within that.
  const eligibleSegmentsFor = (code: string) => (segIndex.byCode.get(norm(code)) ?? []).filter((s) =>
    s.status === "accepted" || (showRejected && s.status === "rejected"));
  // memoised for the same reason segIndex above is: this runs the predicate over
  // the whole codebook, and it was re-running on every render of the view —
  // including every keystroke in the name filter and every excerpt expanded.
  const keep = (list: string[]) => list.filter((c) => matchesCodebookFacets(codebook[c].def,
    () => eligibleSegmentsFor(c), facets, excerptFacetValues));
  const listed = useMemo(() => keep(namedCodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namedCodes, codebook, facets, excerptFacetValues, segIndex, showRejected]);
  const listedParked = useMemo(() => keep(namedParked),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namedParked, codebook, facets, excerptFacetValues, segIndex, showRejected]);
  const facetsOn = hasCodebookFacets(facets);
  // a parked code still reads: its excerpts are untouched, and deciding to
  // bring it back means looking at them
  const chosen = [...allCodes, ...parked].filter((c) => selected.has(c));

  // The survivor's title may never mount — a merge into a SET-ASIDE code (whose
  // row is not a CodeTitle), or one the name filter is hiding. Left armed, the
  // flag would sit there and grab focus whenever that group did finally appear,
  // including in a different project that happened to reuse the name. So it is
  // dropped as soon as it names nothing on screen, and the pane takes the caret
  // rather than leaving it on <body>.
  useEffect(() => {
    if (!focusTitle || chosen.includes(focusTitle)) return;
    setFocusTitle(null);
    if (document.activeElement !== document.body) return;
    const pane = document.querySelector<HTMLElement>(".browse-right");
    if (!pane) return;
    pane.tabIndex = -1;
    pane.focus();
    announce(`Renamed — “${focusTitle}” is not shown here`);
  }, [focusTitle, chosen]);

  const changeFacets = (next: CodebookFacets) => {
    announceFacetChange.current = true;
    setFacets(next);
  };
  useEffect(() => {
    if (!announceFacetChange.current) return;
    announceFacetChange.current = false;
    const live = `${listed.length} code${listed.length === 1 ? "" : "s"} showing out of ${namedCodes.length}`;
    const setAside = namedParked.length
      ? ` ${listedParked.length} set-aside code${listedParked.length === 1 ? "" : "s"} showing out of ${namedParked.length}.`
      : "";
    announce(`${live}.${setAside}`);
  }, [facets, listed.length, listedParked.length, namedCodes.length, namedParked.length]);

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

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* filter + the codebook's AI action (sparkle menu, mirroring the transcript
            sidebar) + an Options menu for filters and display settings.
            The row stays fixed; only the code list scrolls (like the transcript sidebar),
            so the scrollbar sits inset from the drag divider instead of against it. */}
        <div className="cbFilterRow">
          <input type="search" placeholder="Filter codes…" value={filter}
            onChange={(e) => setFilter(e.target.value)} />
          <CbAiMenu onGround={() => setGroundOpen(true)} onDescribe={() => setDescribeOpen(true)}
            fontSize={sidebarFontSize} />
          <CbViewMenu showRejected={showRejected} setShowRejected={setShowRejected}
            facets={facets} setFacets={changeFacets} ui={uiGround} setUi={setUi}
            hasGrounds={hasGrounds} fontSize={sidebarFontSize}
            onRecolor={(r) => setRecolor({ x: r.left, y: r.bottom + 4 })} />
        </div>
        {/* the transcript sidebar's header, twinned: name, count, the same cycling
            sort chip off the same ui.codeSort — the View menu keeps its radios as
            the redundant path */}
        <div className="codeHead">
          <span className="codeTitle">Codes</span>
          <span className="cnt">
            {facetsOn ? <>
              <span aria-hidden="true">{listed.length} of {namedCodes.length}</span>
              <span className="sr-only">{listed.length} code{listed.length === 1 ? "" : "s"}
                showing out of {namedCodes.length}</span>
            </> : listed.length}
          </span>
          <CodeSortChip value={codeSort} onChange={(value) => setUi({ codeSort: value })} />
        </div>
        <div className="cbList nicescroll" ref={listRef}
          onScroll={(e) => { codeListScroll = e.currentTarget.scrollTop; }}>
        {listed.map((c) => (
          <div key={c} className={"bCode" + (selected.has(c) ? " sel" : "")} tabIndex={0} role="button"
            aria-label={`Show excerpts for ${c}, ${counts[c]?.segs || 0} excerpt${counts[c]?.segs === 1 ? "" : "s"}`
              + ` in ${counts[c]?.pids || 0} transcript${counts[c]?.pids === 1 ? "" : "s"}`}
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
              {/* right-click only, matching the main sidebar's swatch: native title,
                  empty data-tip blocks the row's tip from doubling over it */}
              <span className="codebar"
                style={{ background: codebook[c].color }} title="Right-click to recolor" data-tip=""
                onContextMenu={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  openColorPicker(codebook[c].color, (v) => setColor(c, v), e.currentTarget);
                }} />
              <span className="bCodeName">{c}</span>
              {/* the count is already in the row's aria-label — don't double-speak */}
              <CodeCounts stat={counts[c]} size={cntIcon} />
              <button className="rowMenu" aria-label={`Options for ${c}`}
                onClick={(e) => { e.stopPropagation(); openMenuAt(c, e.currentTarget); }}>
                <Icon name="dots" size={sidebarFontSize} />
              </button>
            </div>
            {/* the definition is NOT repeated here: it runs to a paragraph, and
                a list of them buries the names you're scanning for. It lives
                under the code's title on the right, where there is room. */}
          </div>
        ))}
        </div>
        {namedParked.length > 0 && (
          /* The set-aside shelf, in the events list's clothes (see EventList):
             pinned under the code list rather than buried at its scrolling tail,
             the same drag-to-resize grip, and a fold that keeps its count on
             screen — a shut shelf must never be mistaken for an empty one. */
          <div className="parkList" style={parkOpen ? { height: clampEventHeight(parkHeight) } : undefined}>
            {parkOpen && <HeightGrip height={parkHeight} label="Resize the set-aside list" clamp={clampEventHeight}
              onHeight={(h) => setUi({ parkListHeight: clampEventHeight(h) })} />}
            <button className="codeHead cbParkHead" aria-expanded={parkOpen}
              onClick={() => setParkOpen((v) => !v)}
              title={parkOpen ? "Hide the codes you set aside" : "Show the codes you set aside"}>
              <Icon name={parkOpen ? "chevron-down" : "chevron-up"} size={sidebarFontSize} />
              <span className="codeTitle">Set aside</span>
              <span className="cnt">
                {facetsOn ? <>
                  <span aria-hidden="true">{listedParked.length} of {namedParked.length}</span>
                  <span className="sr-only">{listedParked.length} set-aside
                    code{listedParked.length === 1 ? "" : "s"} showing out of {namedParked.length}</span>
                </> : listedParked.length}
              </span>
            </button>
            {parkOpen && <div className="parkRows nicescroll">
              {listedParked.map((c) => (
              <div key={c} className={"bCode parked" + (selected.has(c) ? " sel" : "")} tabIndex={0} role="button"
                aria-label={`Show excerpts for ${c}, set aside, ${counts[c]?.segs || 0} excerpt${counts[c]?.segs === 1 ? "" : "s"}`}
                aria-pressed={selected.has(c)} onClick={(e) => select(c, e)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c, e); }
                  // the same menu the live rows have: a set-aside code still needs
                  // rename, recolour, definition and delete, and having none of
                  // them made the one list that shows these codes a dead end
                  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                    e.preventDefault(); openMenuAt(c, e.currentTarget);
                  }
                }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ code: c, x: e.clientX, y: e.clientY }); }}
                data-tip={`${c} — set aside; its excerpts are untouched`}>
                <div className="bCodeMain">
                  <span className="codebar" style={{ background: codebook[c].color }} data-tip="" />
                  <span className="bCodeName">{c}</span>
                  <CodeCounts stat={counts[c]} size={cntIcon} />
                  <button className="rowMenu" aria-label={`Bring ${c} back into the codebook`}
                    title="Bring back into the codebook"
                    onClick={(e) => { e.stopPropagation(); setParked(c, false); }}>
                    <Icon name="undo" size={sidebarFontSize} />
                  </button>
                </div>
              </div>
              ))}
            </div>}
          </div>
        )}
      </div>

      <Resizer clamp={(w) => Math.max(sidebarFontSize * 14, Math.min(520, w))} onWidth={(w) => setUi({ browseLeftWidth: w })} />

      {/* the excerpt list keeps its place across a trip into a transcript: its
          refs are links out, and the view unmounts on a tab change (see
          AssistView, and scrollMemory for the transcript itself) */}
      <div className="browse-right nicescroll" ref={paneRef}
        onScroll={(e) => { excerptScroll = e.currentTarget.scrollTop; }}>
        {chosen.length === 0 ? (
          <div className="empty">Select a code on the left to see its excerpts.</div>
        ) : (
          chosen.map((code) => {
            const eligibleSegs = eligibleSegmentsFor(code);
            const segs = eligibleSegs.filter((s) => matchesExcerptFacets(s.sid, facets, excerptFacetValues));
            return (
              <div key={code} className="bGroup">
                {/* the same menu the sidebar row and a transcript's lane bar
                    open, on the heading that names the same code — right-click
                    is how you reach a code's actions everywhere else, and the
                    one place you are actually reading it was the exception */}
                <h2 className="bTitle"
                  onContextMenu={(e) => {
                    // the rename field keeps its native menu (paste)
                    if ((e.target as HTMLElement).closest("input")) return;
                    // and so does a SELECTION over the heading: the name is real
                    // prose someone may be quoting, and taking Copy away from a
                    // highlighted phrase to offer Rename is the wrong answer to
                    // a right-click that plainly meant "copy this"
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.toString().trim()
                      && e.currentTarget.contains(sel.anchorNode)) return;
                    e.preventDefault(); setMenu({ code, x: e.clientX, y: e.clientY });
                  }}>
                  <CodeTitle code={code} defOpen={defEditing === code}
                    takeFocus={focusTitle === code} onFocused={() => setFocusTitle(null)}
                    onRenamed={(to) => {
                    // the selection holds NAMES, and the old one has just stopped
                    // existing — without this the group the researcher was reading
                    // vanishes the moment they rename it
                    setSelected((prev) => {
                      const n = new Set(prev); n.delete(code); n.add(to); return n;
                    });
                    setAnchor(to);
                    setFocusTitle(to);
                  }} />
                </h2>
                {/* the definition (or its absence) is always visible under the
                    title, and edits in place — the excerpts are right below, so
                    there's nothing a dialog could add */}
                <DefLine code={code} className="bDef"
                  onEditing={(on) => setDefEditing((prev) => (on ? code : prev === code ? null : prev))} />
                {segs.length === 0 && <div className="bDef">
                  {excerptFacetsOn && eligibleSegs.length > 0
                    ? "All excerpts were filtered out."
                    : "No excerpts yet."}
                </div>}
                {segs.map((s) => {
                  const ex = excerptFor(s);
                  const loaded = !!transcripts[s.pid];
                  const rej = s.status === "rejected";
                  const range = `${s.start}${s.end !== s.start ? `-${s.end}` : ""}`;
                  // gated on there being something to hide: a resize can leave the
                  // range single-speaker, and the toggle below then disappears —
                  // an expanded excerpt with no way back would be a dead end.
                  const isOpen = expanded.has(s.sid) && !!ex?.dropped.length;
                  return (
                    <div key={s.sid} className={"bExcerpt" + (rej ? " rejected" : "")}
                      style={{ borderLeftColor: codebook[code].color || "var(--line)" }}>
                      <div>{rej && <span className="rejtag">rejected</span>}{
                        isOpen && ex
                          ? <div className="bFull">
                              {/* aiGrounds is hashed against the dominant-speaker excerpt, so highlighting the full text would claim the model saw words it did not. */}
                              {speakerGroups(ex.lines).map((g, i) => (
                                <div key={i} className="bFullRow">
                                  {/* the colon is text, not a ::before: it is part of
                                      what this says, so it has to survive a copy and
                                      be there for a reader that ignores CSS content */}
                                  <b className="bFullSpk">{g.speaker.trim() || "unlabelled"}:</b>
                                  <div>{withSubs(g.text)}</div>
                                </div>
                              ))}
                            </div>
                          : ex?.text
                          ? groundedText(ex.text, groundsFor(s, ex.text), codebook[code].color, uiGround)
                          : "(excerpt in coded-segments.csv)"
                      }</div>
                      {/* The source behind a translated excerpt. Its own control,
                          not folded into the speaker expand above: they answer
                          different questions ("who else spoke here" vs "what was
                          actually said"), and a reader checking a quote before it
                          goes in a paper should not have to open the other one to
                          get at it. Only rendered when the two actually differ. */}
                      {ex && ex.source && ex.source !== ex.text && (() => {
                        const open = sourceOpen.has(s.sid);
                        return (
                          <>
                            <button className="bDrop bSrcBtn" aria-expanded={open}
                              title={open ? "Hide the source text" : "Show what was said, in the source language"}
                              onClick={() => {
                                const next = new Set(sourceOpen);
                                open ? next.delete(s.sid) : next.add(s.sid);
                                setSourceOpen(next);
                              }}>
                              {open ? "Hide the original" : "Show the original"}
                            </button>
                            {/* lang is deliberately absent: the source language is
                                not recorded anywhere, and guessing one would tell a
                                screen reader to pronounce the text wrongly */}
                            {open && <div className="bSrc">{withSubs(ex.source)}</div>}
                          </>
                        );
                      })()}
                      {ex && ex.dropped.length > 0 && (() => {
                        const hidden = ex.dropped.reduce((n, d) => n + d.lines, 0);
                        const names = ex.dropped.map((d) => d.speaker || "unlabelled");
                        const action = isOpen
                          ? `Show only ${ex.speaker || "unlabelled"}`
                          : "Show every speaker in this excerpt";
                        return (
                          <button className={"bDrop" + (ex.closeCall ? " warn" : "")}
                            aria-expanded={isOpen} title={action} aria-label={action}
                            onClick={() => {
                              const next = new Set(expanded);
                              isOpen ? next.delete(s.sid) : next.add(s.sid);
                              setExpanded(next);
                            }}>
                            {isOpen
                              ? "Showing every speaker — hide again"
                              : `${hidden} line${hidden === 1 ? "" : "s"} hidden — ${names.join(", ")}`}
                          </button>
                        );
                      })()}
                      {s.notes && <div className="bNote">{s.notes}</div>}
                      {(() => {
                        // what ELSE is true of these lines: every other code
                        // whose accepted coding overlaps this excerpt, and the
                        // section marks (condition/task spans) covering it —
                        // an excerpt read without them is read out of context
                        const others = [...new Set((segIndex.byPid.get(s.pid) ?? [])
                          .filter((o) => o.status === "accepted"
                            && o.start <= s.end && o.end >= s.start && norm(o.code) !== norm(code))
                          .map((o) => o.code))].sort((a, b) => a.localeCompare(b));
                        const marks = stretchesAt(stretches, s.pid, s.start, s.end);
                        if (!others.length && !marks.length) return null;
                        return (
                          <div className="bCtx">
                            {marks.map((st, i) => (
                              <span key={`st${i}`} className="bCtxChip bCtxStretch"
                                title={`${st.dim}: ${st.value} · lines ${st.start}–${st.end}`}>
                                <span className="stDot" style={{ background: stretchColorOf(st.value, stretchColors, dark) }} />
                                {st.dim}: {st.value}
                              </span>
                            ))}
                            {others.map((c) => (
                              <button key={c} className="bCtxChip"
                                title={`Also coded here — show “${c}”`}
                                onClick={() => { setSelected(new Set([c])); setAnchor(c); }}>
                                <span className="swatch" style={{ background: codebook[c]?.color ?? "var(--line)" }} />
                                {c}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
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
          })
        )}
      </div>
      {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {recolor && <RecolorConfirm x={recolor.x} y={recolor.y} onClose={() => setRecolor(null)} />}
      {groundOpen && <GroundModal onClose={() => setGroundOpen(false)} />}
      {describeOpen && <DescribeModal initial={chosen.length ? chosen : undefined} onClose={() => setDescribeOpen(false)} />}
    </div>
  );
}

// The selected code's own name and colour, editable where they are read. The
// codebook's right-click menu can do both, but a researcher looking at a code's
// excerpts and deciding its name is wrong is already pointing at the name — and
// on the Codebook that menu is a right-click away on the OTHER pane's list.
//
// The name follows DefLine's contract exactly, one line below it: a real
// control with a keyboard route in, not a div with a double-click. F2 as well
// as Enter, because that is the rename key everywhere else a list is edited.
function CodeTitle({ code, defOpen, takeFocus, onFocused, onRenamed }: {
  code: string;
  /** a definition is being written below: renaming would unmount the group and
      take the unsaved draft with it, so the name waits */
  defOpen?: boolean;
  /** this title is where the caret belongs — it was just renamed into being */
  takeFocus?: boolean;
  onFocused?: () => void;
  onRenamed: (to: string) => void;
}) {
  const color = useStore((s) => s.codebook[code]?.color) ?? "#888888";
  const codebook = useStore((s) => s.codebook);
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(code);
  // Leaving the editor — cancelled, unchanged, or renamed — used to drop the
  // caret on <body>: the input unmounts and nothing claims focus. In an app
  // built for a reader who navigates by keyboard that is losing their place.
  const nameRef = useRef<HTMLSpanElement>(null);
  const backToName = useRef(false);
  useEffect(() => {
    if (editing || !backToName.current) return;
    backToName.current = false;
    // only when nothing else has taken it — a click elsewhere is the user saying
    // where they want to be (the same rule useMenuFocus follows)
    if (document.activeElement === document.body) nameRef.current?.focus();
  }, [editing]);
  const warnId = useId();
  // the rename that created this title left the caret nowhere; claim it, once
  useEffect(() => {
    if (!takeFocus) return;
    if (document.activeElement === document.body) nameRef.current?.focus();
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeFocus]);
  const start = () => {
    if (defOpen) { announce("Save or cancel the definition first — renaming would discard it"); return; }
    setV(code); setEditing(true);
  };
  const stop = () => { backToName.current = true; setEditing(false); };
  // renameCode MERGES into a name that already exists, which is right — two
  // names for one concept is what a merge is — but it moves every excerpt and
  // it is not what a typo means to do. So the collision is said BEFORE the key
  // that commits it, not discovered afterwards in the ledger.
  // norm(), not a lowercase compare: the store decides a collision by the SAME
  // rule it uses to merge, and norm also collapses runs of whitespace. Asking a
  // narrower question missed "visual   strain" landing on "visual strain" — no
  // warning, a merge anyway, and then a selection pointing at a name that had
  // never existed, so the group being read simply vanished.
  const collides = useMemo(() => {
    const t = norm(v);
    return t && t !== norm(code)
      ? Object.keys(codebook).find((c) => norm(c) === t && c !== code) ?? ""
      : "";
  }, [v, code, codebook]);
  const save = () => {
    const t = v.trim();
    // a no-op still has to hand focus back; only a real rename moves the group
    if (!t || t === code) { stop(); return; }
    setEditing(false);
    useStore.getState().renameCode(code, t);
    announce(collides ? `Merged ${code} into ${collides}` : `Renamed to ${t}`);
    // the SURVIVOR, which is the existing spelling when this turned out to be a
    // merge — the typed one may differ from it by case or spacing and not exist
    onRenamed(collides || t);
  };

  if (editing) {
    return (
      <span className="bTitleEdit">
        <input autoFocus value={v} aria-label={`Rename ${code}`}
          aria-describedby={collides ? warnId : undefined}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); save(); }
            else if (e.key === "Escape") { e.stopPropagation(); stop(); }
          }} />
        {/* tied to the field it warns about, and spoken when it appears: this is
            the one thing standing between a typo and every excerpt of another
            code moving, so it cannot be a colour a reader has to notice */}
        {collides && (
          <span className="bTitleWarn" id={warnId} role="alert">
            “{collides}”{codebook[collides]?.parked ? " (a set-aside code)" : ""} already
            exists — saving MERGES this code into it.
            {codebook[collides]?.parked && " Its excerpts leave the working codebook."}
          </span>
        )}
      </span>
    );
  }
  return (
    <>
      {/* the swatch is a real button: picking a colour is an ordinary action, so
          one click is right — unlike the name, where one click would fire while
          you were only pointing at it */}
      <button className="swatch swatchBtn" style={{ background: color }}
        aria-label={`Colour for ${code}`} title="Pick this code's colour"
        onClick={(e) => openColorPicker(color, (c) => useStore.getState().setColor(code, c),
          e.currentTarget)} />
      <span className="bTitleName" ref={nameRef} role="button" tabIndex={0} onDoubleClick={start}
        aria-label={`Rename ${code}`}
        title={defOpen
          ? "Save or cancel the definition below before renaming"
          : "Double-click or press Enter to rename this code"}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); start(); }
        }}>{code}</span>
    </>
  );
}

// The codebook's AI actions, in a sparkle menu that mirrors the transcript
// sidebar's AI menu (same icon + chevron) — grounding and drafted definitions.
function CbAiMenu({ onGround, onDescribe, fontSize }: {
  onGround: () => void; onDescribe: () => void; fontSize: number;
}) {
  const { open, setOpen, btnRef, menuRef, arrows } = useToggleMenu();
  return (
    <div className="cbMenuWrap">
      <button className="btn aibtn cbMenuBtn" ref={btnRef} aria-haspopup="menu" aria-expanded={open}
        title="AI for the codebook" aria-label="AI for the codebook" onClick={() => setOpen((v) => !v)}>
        <Icon name="sparkle" size={15} /> <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
      </button>
      {open && (
        <div className="ctxmenu cbMenu" ref={menuRef} role="menu" aria-label="Codebook AI"
          onKeyDown={arrows} style={{ fontSize }}>
          <button role="menuitem" onClick={() => { onGround(); setOpen(false); }}>
            <Icon name="sparkle" size={fontSize} /> Ground codes
          </button>
          <button role="menuitem" onClick={() => { onDescribe(); setOpen(false); }}>
            <Icon name="sparkle" size={fontSize} /> Draft definitions
          </button>
        </div>
      )}
    </div>
  );
}

// Recolour the whole codebook. The point is the CONFLICT rule — two codes on one
// line can't share a colour — so the note says that rather than "assign colours".
// Hand-picked colours are a real decision, so when any exist the choice to keep
// them is offered rather than assumed; with none there's nothing to ask about.
function RecolorConfirm({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const codebook = useStore((s) => s.codebook);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  useMenuFocus(ref);
  const arrows = useMenuArrows(ref);
  const codes = Object.keys(codebook);
  const locked = codes.filter((c) => codebook[c].colorLock).length;
  const run = (keepManual: boolean) => {
    const n = useStore.getState().recolorCodes(keepManual);
    announce(n ? `${n} code colour${n === 1 ? "" : "s"} changed.` : "Colours already distinct — nothing changed.");
    onClose();
  };
  return (
    <div className="ctxmenu" ref={ref} role="dialog" aria-label="Recolour codes" onKeyDown={arrows}
      style={{ left: Math.min(x, window.innerWidth - 280), top: y, fontSize: fs }}>
      <div className="ctxhead">Recolour {codes.length} code{codes.length === 1 ? "" : "s"}</div>
      <div className="ctxnote">
        Codes that appear on the same line get clearly different colours. Undo (Ctrl+Z) puts the old ones back.
      </div>
      <div className="ctxform">
        <div className="ctxrow">
          {locked > 0 ? (
            <>
              <button className="btn" autoFocus onClick={() => run(true)}
                title={`${locked} colour${locked === 1 ? "" : "s"} you picked by hand stay as they are`}>
                Keep my {locked} colour{locked === 1 ? "" : "s"}
              </button>
              <button className="btn" onClick={() => run(false)}>Recolour all</button>
            </>
          ) : (
            <button className="btn" autoFocus onClick={() => run(false)}>Recolour</button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// View settings and filters stay out of the AI menu because they are the
// researcher's controls, not AI actions. A dot flags any non-default setting.
function CbViewMenu({ showRejected, setShowRejected, facets, setFacets, ui, setUi,
  hasGrounds, fontSize, onRecolor }: {
  showRejected: boolean;
  setShowRejected: (f: (v: boolean) => boolean) => void;
  facets: CodebookFacets;
  setFacets: (facets: CodebookFacets) => void;
  ui: { groundBold: boolean; groundWash: boolean; groundUnderline: boolean; codeSort: SortBy };
  setUi: (u: Partial<{ groundBold: boolean; groundWash: boolean; groundUnderline: boolean; codeSort: SortBy }>) => void;
  hasGrounds: boolean;
  fontSize: number;
  onRecolor: (rect: DOMRect) => void;
}) {
  const { open, setOpen, btnRef, menuRef, arrows } = useToggleMenu();
  // defaults: rejected off, bold on, wash on, underline off, codes A–Z
  const nonDefault = showRejected || !ui.groundBold || !ui.groundWash || ui.groundUnderline
    || ui.codeSort !== "name" || hasCodebookFacets(facets);
  return (
    <div className="cbMenuWrap">
      <button className="btn cbMenuBtn cbViewBtn" ref={btnRef} aria-haspopup="menu" aria-expanded={open}
        title="Codebook options" onClick={() => setOpen((v) => !v)}>
        Options <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
        {nonDefault && <span className="cbDot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="ctxmenu cbMenu cbViewMenu" ref={menuRef} role="group" aria-label="Codebook options"
          onKeyDown={arrows} style={{ fontSize }}>
          {/* labelled groups like the Assist menu: the button says Options
              because the list is settings AND sweeps, not just display */}
          <div className="cbMenuGrp">Display</div>
          {/* a checkbox, like every other boolean in this menu — a switch beside
              checkboxes read as two kinds of on/off in one list */}
          <label className="cbChk"><input type="checkbox" checked={showRejected}
            onChange={() => setShowRejected((v) => !v)} /> Show rejected</label>
          <div className="cbMenuGrp">Filter excerpts</div>
          <label className="cbChk"><input type="checkbox" checked={facets.mixedSpeakers}
            onChange={(e) => setFacets({ ...facets, mixedSpeakers: e.target.checked })} /> Mixed speakers</label>
          <label className="cbChk"><input type="checkbox" checked={facets.nearBalanced}
            onChange={(e) => setFacets({ ...facets, nearBalanced: e.target.checked })} /> Near-balanced</label>
          <label className="cbChk"><input type="checkbox" checked={facets.withNote}
            onChange={(e) => setFacets({ ...facets, withNote: e.target.checked })} /> With a note</label>
          <div className="cbMenuGrp">Filter codes</div>
          <label className="cbChk"><input type="checkbox" checked={facets.withoutDefinition}
            onChange={(e) => setFacets({ ...facets, withoutDefinition: e.target.checked })} /> Without a definition</label>
          {/* a chip rather than another full-width row: it only exists while
              something is being hidden, and it is the way back, so it carries the
              accent — but it is the exit from this menu's subject, not the
              subject, and at row width the fill said otherwise. */}
          {hasCodebookFacets(facets) && (
            <button className="cbAct cbClear" onClick={() => setFacets(EMPTY_CODEBOOK_FACETS)}>
              <Icon name="x" size={fontSize} /> Clear filters
            </button>
          )}
          {hasGrounds && (
            <>
              <div className="cbMenuGrp">Grounding emphasis</div>
              <label className="cbChk"><input type="checkbox" checked={ui.groundBold}
                onChange={() => setUi({ groundBold: !ui.groundBold })} /> Bold</label>
              <label className="cbChk"><input type="checkbox" checked={ui.groundWash}
                onChange={() => setUi({ groundWash: !ui.groundWash })} /> Wash</label>
              <label className="cbChk"><input type="checkbox" checked={ui.groundUnderline}
                onChange={() => setUi({ groundUnderline: !ui.groundUnderline })} /> Underline</label>
            </>
          )}
          {/* radios, not the sidebar's cycling chip: a menu has room to show all
              three orders at once, and the setting is shared with that chip */}
          <div className="cbMenuGrp">Sort codes</div>
          {SORTS.map((s) => (
            <label key={s.id} className="cbChk">
              <input type="radio" name="cbSort" checked={ui.codeSort === s.id}
                onChange={() => setUi({ codeSort: s.id })} /> {s.label}
            </label>
          ))}
          <div className="cbMenuGrp">Colours</div>
          <button className="cbAct" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setOpen(false);
            onRecolor(r);
          }}>
            <Icon name="droplet" size={fontSize + 1} /> Recolour codes…
          </button>
          {/* one-shot sweeps like Recolour, and they live beside it — these
              were a fake "setting" in the Settings modal, where a control
              that is never "on" read as broken. announce() carries the
              outcome; one undo step reverses either. */}
          <div className="cbMenuGrp">Names</div>
          <button className="cbAct" title="Make every code name start lowercase — one undo step"
            onClick={() => { setOpen(false); useStore.getState().normalizeCodeCase("lower"); }}>
            start all lowercase
          </button>
          <button className="cbAct" title="Make every code name start with a capital — one undo step"
            onClick={() => { setOpen(false); useStore.getState().normalizeCodeCase("capital"); }}>
            Start all with a capital
          </button>
        </div>
      )}
    </div>
  );
}

// Excerpt text with its grounding quotes emphasised. Emphasis channels are the
// user's combinable choices (bold / code-colour wash / underline); with all
// three off, or no quotes, the text renders plain.
function groundedText(
  text: string, quotes: string[], color: string,
  ui: { groundBold: boolean; groundWash: boolean; groundUnderline: boolean },
): ReactNode {
  const subs = subSpans(text);
  if (!quotes.length || (!ui.groundBold && !ui.groundWash && !ui.groundUnderline)) return withSubs(text, 0, subs);
  const ranges: [number, number][] = [];
  for (const q of quotes) {
    const i = text.indexOf(q); // first occurrence — the model saw this exact text
    if (i >= 0) ranges.push([i, i + q.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const st: CSSProperties = {};
  if (ui.groundWash) st.background = `color-mix(in srgb, ${color} 22%, transparent)`;
  if (ui.groundUnderline) st.textDecorationColor = color;
  const cls = "ground" + (ui.groundBold ? " gbold" : "") + (ui.groundUnderline ? " gunder" : "");
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s0, e0], k) => {
    if (s0 < at) return; // overlapping quote — first one wins
    out.push(<SubText key={"p" + k} text={text.slice(at, s0)} from={at} spans={subs} />);
    out.push(<mark key={k} className={cls} style={st}>
      <SubText text={text.slice(s0, e0)} from={s0} spans={subs} /></mark>);
    at = e0;
  });
  out.push(<SubText key="tail" text={text.slice(at)} from={at} spans={subs} />);
  return out;
}
