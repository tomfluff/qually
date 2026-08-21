// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Codebook tab: go over your coding. Codes on the left, their excerpts on the
// right. The AI's observations moved out to the Assist tab; this view is yours.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type Segment } from "../state/store";
import { norm } from "../contract/segments";
import { segExcerpt } from "../contract/excerpt";
import { Resizer } from "./Resizer";
import { CodeMenu } from "./CodeMenu";
import { openColorPicker } from "../colorPicker";
import { DefLine } from "./CodeDef";
import { groundHash } from "../ai/ground";
import { GroundModal } from "./GroundModal";
import { DescribeModal } from "./DescribeModal";
import { useToggleMenu, useDismiss } from "../usePopover";
import { Icon, countIconSize } from "./Icon";
import { CodeCounts } from "./CodeCounts";
import { announce } from "../announce";
import { codeStats, sortCodes, SORTS, type SortBy } from "../codeStats";

// Codebook working state (chosen codes, filter, show-rejected) survives leaving the
// tab — the view unmounts, so plain useState would reset it on every visit.
const remembered = {
  selected: new Set<string>(),
  anchor: null as string | null,
  filter: "",
  showRejected: false,
};

// where the excerpt list was parked, for the same reason and in the same place
// as the rest of this cache
let excerptScroll = 0;
let codeListScroll = 0;

export function BrowseView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const paneRef = useCallback((el: HTMLDivElement | null) => { if (el) el.scrollTop = excerptScroll; }, []);
  const listRef = useCallback((el: HTMLDivElement | null) => { if (el) el.scrollTop = codeListScroll; }, []);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const leftWidth = useStore((s) => s.ui.browseLeftWidth);
  const setUi = useStore((s) => s.setUi);
  const aiGrounds = useStore((s) => s.aiGrounds);
  const ui = useStore((s) => s.ui);
  const [groundOpen, setGroundOpen] = useState(false);
  const [describeOpen, setDescribeOpen] = useState(false);
  const hasGrounds = Object.keys(aiGrounds).length > 0;
  const setColor = useStore((s) => s.setColor);
  const jumpTo = useStore((s) => s.jumpTo);
  const [selected, setSelected] = useState<Set<string>>(remembered.selected);
  const [anchor, setAnchor] = useState<string | null>(remembered.anchor);
  const [filter, setFilter] = useState(remembered.filter);
  const [showRejected, setShowRejected] = useState(remembered.showRejected);
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  const [recolor, setRecolor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { Object.assign(remembered, { selected, anchor, filter, showRejected }); },
    [selected, anchor, filter, showRejected]);

  const counts = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const cntIcon = countIconSize(sidebarFontSize);

  // The excerpt's dominant speaker is shown as its own field in the ref row (below),
  // so the display text drops the "[R:] " prefix the export keeps baked in.
  const excerptFor = (s: Segment): { text: string; speaker: string } | null => {
    const t = transcripts[s.pid];
    if (!t) return null;
    const r = segExcerpt(s, t.lines);
    return { text: r.excerpt, speaker: r.speaker };
  };

  // a segment's grounding quotes, but only while the hash still matches what the
  // model saw (recode/resize/edit invalidates — same trick as the scan marks)
  const groundsFor = (seg: Segment, excerpt: string): string[] => {
    const g = aiGrounds[seg.sid];
    return g && g.hash === groundHash(seg.code, excerpt) ? g.quotes : [];
  };

  // the order the View menu asks for — the same three the transcript sidebar and
  // the Assist definitions panel offer, off the same setting
  const sortIdx = Math.max(0, SORTS.findIndex((x) => x.id === ui.codeSort));
  const nextSort = SORTS[(sortIdx + 1) % SORTS.length];
  const allCodes = useMemo(
    () => sortCodes(Object.keys(codebook), counts, ui.codeSort), [codebook, counts, ui.codeSort]);
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
      <div className="browse-left cbSide" style={{ width: leftWidth, fontSize: sidebarFontSize }}>
        {/* filter + the codebook's AI action (sparkle menu, mirroring the transcript
            sidebar) + a View menu for the display settings (kept out of the AI menu).
            The row stays fixed; only the code list scrolls (like the transcript sidebar),
            so the scrollbar sits inset from the drag divider instead of against it. */}
        <div className="cbFilterRow">
          <input type="search" placeholder="Filter codes…" value={filter}
            onChange={(e) => setFilter(e.target.value)} />
          <CbAiMenu onGround={() => setGroundOpen(true)} onDescribe={() => setDescribeOpen(true)}
            fontSize={sidebarFontSize} />
          <CbViewMenu showRejected={showRejected} setShowRejected={setShowRejected}
            ui={ui} setUi={setUi} hasGrounds={hasGrounds} fontSize={sidebarFontSize}
            onRecolor={(r) => setRecolor({ x: r.left, y: r.bottom + 4 })} />
        </div>
        {/* the transcript sidebar's header, twinned: name, count, the same cycling
            sort chip off the same ui.codeSort — the View menu keeps its radios as
            the redundant path */}
        <div className="codeHead">
          <span className="codeTitle">Codes</span>
          <span className="cnt">{listed.length}</span>
          <button className="sortchip"
            onClick={() => { setUi({ codeSort: nextSort.id }); announce(`Sorted by ${nextSort.label}`); }}
            title={`Sorted by ${SORTS[sortIdx].label} — switch to ${nextSort.label}`}
            aria-label={`Sorted by ${SORTS[sortIdx].label}. Switch to ${nextSort.label}.`}>
            {SORTS[sortIdx].label}
          </button>
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
      </div>

      <Resizer onWidth={(w) => setUi({ browseLeftWidth: Math.max(160, Math.min(520, w)) })} />

      {/* the excerpt list keeps its place across a trip into a transcript: its
          refs are links out, and the view unmounts on a tab change (see
          AssistView, and scrollMemory for the transcript itself) */}
      <div className="browse-right nicescroll" ref={paneRef}
        onScroll={(e) => { excerptScroll = e.currentTarget.scrollTop; }}>
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
                {/* the definition (or its absence) is always visible under the
                    title, and edits in place — the excerpts are right below, so
                    there's nothing a dialog could add */}
                <DefLine code={code} className="bDef" />
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
      {recolor && <RecolorConfirm x={recolor.x} y={recolor.y} onClose={() => setRecolor(null)} />}
      {groundOpen && <GroundModal onClose={() => setGroundOpen(false)} />}
      {describeOpen && <DescribeModal onClose={() => setDescribeOpen(false)} />}
    </div>
  );
}

// The codebook's AI actions, in a sparkle menu that mirrors the transcript
// sidebar's AI menu (same icon + chevron) — grounding and drafted definitions.
function CbAiMenu({ onGround, onDescribe, fontSize }: {
  onGround: () => void; onDescribe: () => void; fontSize: number;
}) {
  const { open, setOpen, btnRef, menuRef } = useToggleMenu();
  return (
    <div className="cbMenuWrap">
      <button className="btn aibtn cbMenuBtn" ref={btnRef} aria-haspopup="menu" aria-expanded={open}
        title="AI for the codebook" aria-label="AI for the codebook" onClick={() => setOpen((v) => !v)}>
        <Icon name="sparkle" size={15} /> <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
      </button>
      {open && (
        <div className="ctxmenu cbMenu" ref={menuRef} role="menu" aria-label="Codebook AI"
          style={{ fontSize }}>
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
  const codes = Object.keys(codebook);
  const locked = codes.filter((c) => codebook[c].colorLock).length;
  const run = (keepManual: boolean) => {
    const n = useStore.getState().recolorCodes(keepManual);
    announce(n ? `${n} code colour${n === 1 ? "" : "s"} changed.` : "Colours already distinct — nothing changed.");
    onClose();
  };
  return (
    <div className="ctxmenu" ref={ref} role="dialog" aria-label="Recolour codes"
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

// View settings for the excerpt list — a rejected filter and grounding emphasis,
// kept out of the AI menu because they're display prefs, not an action. A dot on
// the button flags any non-default setting.
function CbViewMenu({ showRejected, setShowRejected, ui, setUi, hasGrounds, fontSize, onRecolor }: {
  showRejected: boolean;
  setShowRejected: (f: (v: boolean) => boolean) => void;
  ui: { groundBold: boolean; groundWash: boolean; groundUnderline: boolean; codeSort: SortBy };
  setUi: (u: Partial<{ groundBold: boolean; groundWash: boolean; groundUnderline: boolean; codeSort: SortBy }>) => void;
  hasGrounds: boolean;
  fontSize: number;
  onRecolor: (rect: DOMRect) => void;
}) {
  const { open, setOpen, btnRef, menuRef } = useToggleMenu();
  // defaults: rejected off, bold on, wash on, underline off, codes A–Z
  const nonDefault = showRejected || !ui.groundBold || !ui.groundWash || ui.groundUnderline
    || ui.codeSort !== "name";
  return (
    <div className="cbMenuWrap">
      <button className="btn cbMenuBtn cbViewBtn" ref={btnRef} aria-haspopup="menu" aria-expanded={open}
        title="View settings" onClick={() => setOpen((v) => !v)}>
        View <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
        {nonDefault && <span className="cbDot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="ctxmenu cbMenu cbViewMenu" ref={menuRef} role="group" aria-label="View settings"
          style={{ fontSize }}>
          {/* a checkbox, like every other boolean in this menu — a switch beside
              checkboxes read as two kinds of on/off in one list */}
          <label className="cbChk"><input type="checkbox" checked={showRejected}
            onChange={() => setShowRejected((v) => !v)} /> Show rejected</label>
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
