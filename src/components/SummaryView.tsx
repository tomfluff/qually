// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Summary tab: one transcript's session, twice. The DETAILED pane is the
// merged record — event log and accepted codings in transcript order, each row a
// way back into the transcript. The SUMMARY pane is the researcher's prose
// account of the session: typed by hand, or AI-drafted and then edited. Three
// layouts (side by side / stacked / one at a time) because the writing posture
// differs: side for writing against the record, stacked for wide excerpts, one
// for small screens.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { clampSummarySplit, useStore } from "../state/store";
import { useSummaryData, type SumItem } from "../useSummaryData";
import { fmtLike, markerColor, markerKey } from "../markers";
import { Resizer } from "./Resizer";
import { SummarizeModal } from "./SummarizeModal";
import { Icon } from "./Icon";

// survives leaving the tab (the view unmounts on tab change), like Browse/Assist
const remembered = {
  pid: null as string | null,
  pane: "detail" as "detail" | "text", // which pane shows in "one" layout
};
// the Assist tab's "open" lands here: select the transcript, then switch tabs
export function openSummary(pid: string) {
  remembered.pid = pid;
  useStore.getState().setActive("summary");
}

export function SummaryView() {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const markers = useStore((s) => s.markers);
  const segments = useStore((s) => s.segments);
  const summaries = useStore((s) => s.summaries);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const layout = useStore((s) => s.ui.summaryLayout);
  const setUi = useStore((s) => s.setUi);

  const allPids = useMemo(() =>
    [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))].filter((p) => transcripts[p]),
    [tabs, transcripts]);
  const [picked, setPicked] = useState(remembered.pid);
  const [pane, setPane] = useState(remembered.pane);
  const [genOpen, setGenOpen] = useState(false);
  useEffect(() => { Object.assign(remembered, { pid: picked, pane }); }, [picked, pane]);
  // a remembered pid may be gone (renamed, new project) — fall back to the first
  const pid = picked && transcripts[picked] ? picked : allPids[0] ?? "";

  const hasSummary = (p: string) => !!summaries[p]?.trim();

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* which panes and how they share the space — a property of the tab,
            so it sits with the picker, not floating over the content */}
        <div className="segmented sumSideLayout" role="group" aria-label="Layout">
          {(["side", "stack", "one"] as const).map((l) => (
            <button key={l} className={"seg" + (layout === l ? " on" : "")}
              aria-pressed={layout === l} onClick={() => setUi({ summaryLayout: l })}
              title={l === "side" ? "Detailed and summary side by side"
                : l === "stack" ? "Detailed above, summary below" : "One pane at a time"}>
              {l === "side" ? "Side" : l === "stack" ? "Stacked" : "One"}
            </button>
          ))}
        </div>
        {layout === "one" && (
          <div className="segmented sumSideLayout" role="group" aria-label="Pane">
            <button className={"seg" + (pane === "detail" ? " on" : "")}
              aria-pressed={pane === "detail"} onClick={() => setPane("detail")}>Detailed</button>
            <button className={"seg" + (pane === "text" ? " on" : "")}
              aria-pressed={pane === "text"} onClick={() => setPane("text")}>Summary</button>
          </div>
        )}
        <div className="bSideHead">Summary</div>
        <div className="cbList nicescroll">
          {allPids.length === 0 ? (
            <div className="bSideNote">No transcripts yet. Import one to summarise its session.</div>
          ) : allPids.map((p) => {
            const ev = markers.filter((m) => m.pid === p).length;
            const seg = segments.filter((s) => s.pid === p && s.status === "accepted").length;
            return (
              <div key={p} className={"nLens" + (pid === p ? " sel" : "")}
                tabIndex={0} role="button" aria-pressed={pid === p}
                onClick={() => setPicked(p)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(p); } }}>
                <span className="nName">{p}</span>
                {/* the pencil marks a written summary — the tab's own artifact */}
                {hasSummary(p) && <Icon name="pencil" size={sidebarFontSize} />}
                <span className="cnt">{ev + seg || "—"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(sidebarFontSize * 14, Math.min(520, w)) })} />

      {pid ? (
        <div className="sumRight">
          {/* the one action, hovering the corner — always there, over the pane
              it writes into. Bottom-right, so it never sits on the first line
              a reader lands on; the pane scrolls past its own end anyway. */}
          <button className="btn sumFab" onClick={() => setGenOpen(true)}
            style={{ fontSize: sidebarFontSize }}
            title={`Draft ${pid}'s summary with AI from its events and coded excerpts (sends them to OpenAI after your approval)`}>
            <Icon name="sparkle" size={14} /> Generate
          </button>
          <div className={"sumSplit " + layout}>
            {(layout !== "one" || pane === "detail") && <DetailPane pid={pid} />}
            {layout !== "one" && <SplitGrip vertical={layout === "side"} />}
            {(layout !== "one" || pane === "text") && <TextPane pid={pid} />}
          </div>
        </div>
      ) : (
        <div className="browse-right nicescroll">
          <div className="empty">Import a transcript first — its events and coded segments show up here as one session record.</div>
        </div>
      )}
      {genOpen && <SummarizeModal pid={pid} onClose={() => setGenOpen(false)} />}
    </div>
  );
}

// The merged session record. Every row jumps: an event to the line it sits above,
// a coding to its first line — the pane is an index into the transcript, not a
// second place to read it.
// Where each transcript's session record is parked. Module scope for the same
// reason scrollMemory is: the whole view unmounts on a tab change, so clicking an
// event to jump into the transcript and coming back used to land at the top of a
// long log — losing the place you had read up to, which is the one thing the
// round trip can't reconstruct. A raw scrollTop is enough here: unlike the
// transcript this list isn't virtualised, so the pixels mean the same thing every
// time. Not persisted — it is view state for the session, not project data.
const sumScroll: Record<string, number> = {};
const sumTextScroll: Record<string, number> = {};

function DetailPane({ pid }: { pid: string }) {
  const { items, lineOf, offset, tsSample } = useSummaryData(pid);
  const colors = useStore((s) => s.ui.markerColors);
  const codebook = useStore((s) => s.codebook);
  const split = useStore((s) => s.ui.summarySplit);
  const layout = useStore((s) => s.ui.summaryLayout);
  const jumpTo = useStore((s) => s.jumpTo);
  // in a split the first pane takes its fraction; alone it takes everything.
  // Ratio GROW from a zero basis, not a % basis: percentage flex-basis needs a
  // definite container height and silently fell back to content size in the
  // stacked column, ignoring the stored split (the text pane's CSS flex:1
  // makes the pair split split:(1-split) exactly).
  const style = layout === "one" ? undefined
    : { flex: `${(split / (1 - split)).toFixed(4)} 1 0px` }; // 0px, NOT 0%: a % basis against an indefinite height degrades to content size
  // restore before paint, so the list never flashes at the top on the way back
  const paneRef = useCallback((el: HTMLDivElement | null) => {
    if (el) el.scrollTop = sumScroll[pid] ?? 0;
  }, [pid]);

  const row = (it: SumItem) => {
    if (it.kind === "e") {
      const key = markerKey(it.m);
      const c = markerColor(key, colors);
      return (
        <button key={`e${it.m.mid}`} className="sumEv" style={{ "--mk-c": c } as CSSProperties}
          onClick={() => { const l = lineOf.get(it.m.mid); if (l !== undefined) jumpTo(pid, l); }}>
          <span className="evtime">{fmtLike(it.m.t - offset, tsSample)}</span>
          <span className="evdot" style={{ background: c }} />
          <span className="sumEvText">{it.m.label || <em className="mkempty">({key})</em>}</span>
        </button>
      );
    }
    const { seg, excerpt, time } = it;
    const c = codebook[seg.code]?.color ?? "#888";
    return (
      <button key={`s${seg.sid}`} className="sumSeg" style={{ "--mk-c": c } as CSSProperties}
        onClick={() => jumpTo(pid, seg.start)}>
        <span className="sumSegHead">
          <span className="evdot" style={{ background: c }} />
          <span className="sumCode">{seg.code}</span>
          <span className="sumRef">{time || `${seg.start}${seg.end !== seg.start ? `–${seg.end}` : ""}`}</span>
        </span>
        <span className="sumExcerpt">{excerpt || "(excerpt unavailable)"}</span>
      </button>
    );
  };

  return (
    <div className="sumPane nicescroll" style={style} ref={paneRef}
      onScroll={(e) => { sumScroll[pid] = e.currentTarget.scrollTop; }}>
      {items.length === 0
        ? <div className="empty">Nothing here yet — load an events CSV onto this transcript (right-click its tab) or accept some codings, and the session record builds itself.</div>
        : items.map(row)}
    </div>
  );
}

function TextPane({ pid }: { pid: string }) {
  const text = useStore((s) => s.summaries[pid] ?? "");
  const setSummary = useStore((s) => s.setSummary);
  const taRef = useCallback((el: HTMLTextAreaElement | null) => {
    if (el) el.scrollTop = sumTextScroll[pid] ?? 0;
  }, [pid]);
  return (
    <div className="sumPane sumTextPane">
      <textarea className="sumText" value={text} spellCheck ref={taRef}
        onScroll={(e) => { sumTextScroll[pid] = e.currentTarget.scrollTop; }}
        aria-label={`Session summary for ${pid}`}
        placeholder="Write the session summary here — what happened, what was expressed and why, what was observed, highlights. Or let the AI draft one (Generate…) and edit it."
        onChange={(e) => setSummary(pid, e.target.value)} />
    </div>
  );
}

// The divider between the two panes: drag (or arrow) to shift the split. Stores a
// FRACTION of the container, so the split survives orientation flips and resizes.
function SplitGrip({ vertical }: { vertical: boolean }) {
  const split = useStore((s) => s.ui.summarySplit);
  const setUi = useStore((s) => s.setUi);
  const apply = (f: number) => setUi({ summarySplit: clampSummarySplit(f) });
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: MouseEvent) => apply(vertical
      ? (ev.clientX - box.left) / box.width
      : (ev.clientY - box.top) / box.height);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    <div className={"sumGrip" + (vertical ? " v" : " h")} role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"} tabIndex={0}
      aria-label="Resize the panes" onMouseDown={down}
      onKeyDown={(e) => {
        const delta = vertical
          ? (e.key === "ArrowRight" ? 0.04 : e.key === "ArrowLeft" ? -0.04 : 0)
          : (e.key === "ArrowDown" ? 0.04 : e.key === "ArrowUp" ? -0.04 : 0);
        if (!delta) return;
        e.preventDefault();
        apply(split + delta);
      }} />
  );
}
