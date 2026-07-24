// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Codebook tab: go over your coding. Codes on the left, their excerpts on the
// right. The AI's observations moved out to the Assist tab; this view is yours.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type Segment } from "../state/store";
import { norm } from "../contract/segments";
import { excerptOf } from "../contract/excerpt";
import { Resizer } from "./Resizer";
import { CodeMenu } from "./CodeMenu";
import { openColorPicker } from "../colorPicker";
import { groundHash } from "../ai/ground";
import { GroundModal } from "./GroundModal";
import { useDismiss } from "../usePopover";
import { Icon } from "./Icon";

// Codebook working state (chosen codes, filter, show-rejected) survives leaving the
// tab — the view unmounts, so plain useState would reset it on every visit.
const remembered = {
  selected: new Set<string>(),
  anchor: null as string | null,
  filter: "",
  showRejected: false,
};

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const aiGrounds = useStore((s) => s.aiGrounds);
  const ui = useStore((s) => s.ui);
  const [groundOpen, setGroundOpen] = useState(false);
  const hasGrounds = Object.keys(aiGrounds).length > 0;
  const setColor = useStore((s) => s.setColor);
  const jumpTo = useStore((s) => s.jumpTo);
  const [selected, setSelected] = useState<Set<string>>(remembered.selected);
  const [anchor, setAnchor] = useState<string | null>(remembered.anchor);
  const [filter, setFilter] = useState(remembered.filter);
  const [showRejected, setShowRejected] = useState(remembered.showRejected);
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  useEffect(() => { Object.assign(remembered, { selected, anchor, filter, showRejected }); },
    [selected, anchor, filter, showRejected]);

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

  // a segment's grounding quotes, but only while the hash still matches what the
  // model saw (recode/resize/edit invalidates — same trick as the scan marks)
  const groundsFor = (seg: Segment, excerpt: string): string[] => {
    const g = aiGrounds[seg.sid];
    return g && g.hash === groundHash(seg.code, excerpt) ? g.quotes : [];
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

  return (
    <div id="browse" style={{ fontSize }}>
      <div className="browse-left nicescroll" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        <button className="btn groundBtn" onClick={() => setGroundOpen(true)}
          title="Mark which words carry each assigned code (sends coded excerpts to OpenAI after your approval)">
          <Icon name="sparkle" size={15} /> Ground codes…
        </button>
        <div className="bSideRow">
          <button className="switchRow" role="switch" aria-checked={showRejected}
            onClick={() => setShowRejected((v) => !v)}>
            <span className={"switch" + (showRejected ? " on" : "")}><span className="knob" /></span>
            <span className="switchLabel">Show rejected</span>
          </button>
          {hasGrounds && <GroundingStyleMenu ui={ui} setUi={setUi} fontSize={sidebarFontSize} />}
        </div>
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
              <span className="cnt" aria-hidden="true">{counts[c]?.segs || 0}·{counts[c]?.pids.size || 0}</span>
              <button className="rowMenu" aria-label={`Options for ${c}`}
                onClick={(e) => { e.stopPropagation(); openMenuAt(c, e.currentTarget); }}>⋯</button>
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
          chosen.map((code) => {
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
                      <div>{rej && <span className="rejtag">rejected</span>}{
                        ex?.text
                          ? groundedText(ex.text, groundsFor(s, ex.text), codebook[code].color, ui)
                          : "(excerpt in coded-segments.csv)"
                      }</div>
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
          })
        )}
      </div>
      {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {groundOpen && <GroundModal onClose={() => setGroundOpen(false)} />}
    </div>
  );
}

// How AI grounding quotes are emphasised inside the excerpts — bold / code-colour
// wash / underline, combinable. A small menu off the sidebar so the toggles don't
// crowd the excerpt list (they used to sit in a bar above it).
function GroundingStyleMenu({ ui, setUi, fontSize }: {
  ui: { groundBold: boolean; groundWash: boolean; groundUnderline: boolean };
  setUi: (u: Partial<{ groundBold: boolean; groundWash: boolean; groundUnderline: boolean }>) => void;
  fontSize: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeIt = () => setOpen(false);
  useDismiss(ref, closeIt, { enabled: open });
  return (
    <div className="groundStyleWrap" ref={ref}>
      <button className="btn groundStyleBtn" onClick={() => setOpen((v) => !v)}
        aria-expanded={open} aria-haspopup="menu"
        title="How AI grounding is emphasised in the excerpts">
        Grounding <Icon name={open ? "chevron-up" : "chevron-down"} size={13} />
      </button>
      {open && (
        <div className="groundStyleMenu" role="group" aria-label="Grounding emphasis"
          style={{ fontSize }}>
          <label><input type="checkbox" checked={ui.groundBold}
            onChange={() => setUi({ groundBold: !ui.groundBold })} /> Bold</label>
          <label><input type="checkbox" checked={ui.groundWash}
            onChange={() => setUi({ groundWash: !ui.groundWash })} /> Wash</label>
          <label><input type="checkbox" checked={ui.groundUnderline}
            onChange={() => setUi({ groundUnderline: !ui.groundUnderline })} /> Underline</label>
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
  if (!quotes.length || (!ui.groundBold && !ui.groundWash && !ui.groundUnderline)) return text;
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
    out.push(text.slice(at, s0));
    out.push(<mark key={k} className={cls} style={st}>{text.slice(s0, e0)}</mark>);
    at = e0;
  });
  out.push(text.slice(at));
  return out;
}
