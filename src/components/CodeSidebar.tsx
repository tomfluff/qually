// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useMemo, useState } from "react";
import { useStore, patternOf, liveCodes } from "../state/store";
import { codeStats, sortCodes } from "../codeStats";
import { CodeMenu } from "./CodeMenu";
import { CodeCounts } from "./CodeCounts";
import { CodeCombobox } from "./CodeCombobox";
import { AiCheckModal } from "./AiCheckModal";
import { SuggestModal } from "./SuggestModal";
import { SectionsModal } from "./SectionsModal";
import { ContextualizeModal } from "./ContextualizeModal";
import { EventList } from "./EventList";
import { openColorPicker } from "../colorPicker";
import { useToggleMenu } from "../usePopover";
import { Icon, countIconSize } from "./Icon";
import { CodeSortChip } from "./CodeSortChip";

export function CodeSidebar() {
  const active = useStore((s) => s.active); // the sidebar only renders for a transcript view
  const lanePattern = useStore((s) => s.ui.lanePattern);
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codeSort = useStore((s) => s.ui.codeSort);
  const setUi = useStore((s) => s.setUi);
  const hotbarCache = useStore((s) => s.hotbarCache);
  const hasSel = useStore((s) => s.selection.lines.size > 0);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const sidebarWidth = useStore((s) => s.ui.sidebarWidth);
  const applyCode = useStore((s) => s.applyCode);
  const setColor = useStore((s) => s.setColor);
  const pinned = useStore((s) => s.hotbar.pinned);
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const hasCodes = liveCodes(codebook).length > 0;
  const { open: aiMenu, setOpen: setAiMenu, btnRef: aiBtnRef, menuRef: aiMenuRef, arrows: aiArrows } = useToggleMenu();

  // keyboard/visible route to the same menu right-click opens, anchored to the row or ⋯ button
  const openMenuAt = (code: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ code, x: r.left, y: r.bottom + 2 });
  };

  const counts = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const codes = useMemo(
    // codes you set aside are not offered here; the Codebook keeps them
    () => sortCodes(liveCodes(codebook), counts, codeSort), [codebook, counts, codeSort]);
  // one chip, cycling — three orders is one more than a toggle but still far less
  // room than three pills cost in a 250px panel, and the chip names the order it
  // is IN, so the list is always labelled even when nobody touches it
  // the counts read as icons, not as "12·3": a glyph pair survives the panel getting
  // narrow, and the separator dot never did say which number was which
  const cntIcon = countIconSize(sidebarFontSize);

  return (
    <div id="sidebar" style={{ fontSize: sidebarFontSize, width: sidebarWidth }}>
      {/* + new code, with the transcript's AI actions in a menu beside it. The AI
          acts on THIS transcript (the sidebar only renders for a transcript view),
          so its home is here, not the global toolbar. */}
      <div className="sidebarNewRow">
        <CodeCombobox placeholder="+ New code" />
        <button className="btn aibtn aiMenuBtn" ref={aiBtnRef}
          aria-haspopup="menu" aria-expanded={aiMenu}
          title="AI for this transcript" aria-label="AI for this transcript"
          onClick={() => setAiMenu((v) => !v)}>
          <Icon name="sparkle" size={15} /> <Icon name={aiMenu ? "chevron-up" : "chevron-down"} size={12} />
        </button>
        {aiMenu && (
          <div className="ctxmenu aiMenu" ref={aiMenuRef} role="menu" aria-label="AI for this transcript"
            onKeyDown={aiArrows} style={{ fontSize: sidebarFontSize }}>
            <button role="menuitem" onClick={() => { setAiOpen(true); setAiMenu(false); }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI observation scan
            </button>
            <button role="menuitem" disabled={!hasCodes}
              title={hasCodes ? undefined : "Add a code first — suggestions apply your existing codes"}
              onClick={() => { if (hasCodes) { setSuggestOpen(true); setAiMenu(false); } }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI code suggestion
            </button>
            {/* not gated on the codebook: sections are the shape of the SESSION,
                which a researcher may well want marked up before they code a
                line. What it IS gated on is the brief, and that lives in the
                gate — where the labels can be written on the spot. */}
            <button role="menuitem" onClick={() => { setSectionsOpen(true); setAiMenu(false); }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI section marking
            </button>
            <button role="menuitem" onClick={() => { setContextOpen(true); setAiMenu(false); }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI contextualize
            </button>
          </div>
        )}
      </div>
      {/* the events list below has the same header shape (name, count, order chip):
          two lists in one panel, one vocabulary */}
      <div className="codeHead">
        <span className="codeTitle">Codes</span>
        <span className="cnt">{codes.length}</span>
        <CodeSortChip value={codeSort} onChange={(value) => setUi({ codeSort: value })} />
      </div>
      <div className="codeList nicescroll">
      {codes.map((code) => {
        const slot = hotbarCache.indexOf(code);
        const c = counts[code];
        return (
          <div key={code} className="codeItem" tabIndex={0} role="button"
            aria-label={`Apply code ${code}`
              + (slot >= 0 && slot < 9 ? `, hotkey ${slot + 1}` : "")
              + `, ${c?.segs ?? 0} excerpt${c?.segs === 1 ? "" : "s"}`
              + ` in ${c?.pids ?? 0} transcript${c?.pids === 1 ? "" : "s"}`
              + (pinned.includes(code) ? ", pinned" : "")}
            onClick={() => { if (hasSel) applyCode(code); }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return; // let the ⋯ button's keys be its own
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (hasSel) applyCode(code); }
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault(); openMenuAt(code, e.currentTarget);
              }
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ code, x: e.clientX, y: e.clientY }); }}
            data-tip={code}>
            {/* the keycap leads the row so the number reads before the colour;
                hotkey + count are already in the row's aria-label, so the badge
                is decorative. Codes without a hotkey keep the slot (hidden) —
                otherwise every swatch below one would shift left. */}
            <span className={"key" + (slot >= 0 && slot < 9 ? "" : " ghost")} aria-hidden="true">
              {slot >= 0 && slot < 9 ? slot + 1 : "0"}
            </span>
            {/* right-click only: a left-click on the swatch is almost always a missed
                click on the row (apply code) — let it fall through. Keyboard and
                screen-reader users recolor via the ⋯ menu's "Change color". */}
            {/* native title (owner's call — the custom bubble clipped here); the empty
                data-tip stops the closest() walk so the row's code-name tip doesn't
                show on top of it */}
            <span className={"codebar" + (lanePattern ? ` lp${patternOf(code)}` : "")}
              style={{ background: codebook[code].color }} title="Right-click to recolor" data-tip=""
              onContextMenu={(e) => {
                e.preventDefault(); e.stopPropagation();
                openColorPicker(codebook[code].color, (v) => setColor(code, v), e.currentTarget);
              }} />
            <span className="cname">{code}</span>
            {pinned.includes(code) && (
              <span className="pindot" title="Pinned"><Icon name="pin" size={cntIcon} /></span>
            )}
            <CodeCounts stat={c} size={cntIcon} />
            <button className="rowMenu" aria-label={`Options for ${code}`}
              onClick={(e) => { e.stopPropagation(); openMenuAt(code, e.currentTarget); }}>
              <Icon name="dots" size={sidebarFontSize} />
            </button>
          </div>
        );
      })}
      </div>
      {/* below the codes: this transcript's session events, if it has any (see
          EventList — it renders nothing at all when there are none) */}
      <EventList pid={active} />
      {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {aiOpen && <AiCheckModal pid={active} onClose={() => setAiOpen(false)} />}
      {suggestOpen && <SuggestModal pid={active} onClose={() => setSuggestOpen(false)} />}
      {sectionsOpen && <SectionsModal pid={active} onClose={() => setSectionsOpen(false)} />}
      {contextOpen && <ContextualizeModal pid={active} onClose={() => setContextOpen(false)} />}
    </div>
  );
}
