// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useState } from "react";
import { useStore, patternOf } from "../state/store";
import { CodeMenu } from "./CodeMenu";
import { CodeCombobox } from "./CodeCombobox";
import { AiCheckModal } from "./AiCheckModal";
import { SuggestModal } from "./SuggestModal";
import { openColorPicker } from "../colorPicker";
import { useToggleMenu } from "../usePopover";
import { Icon } from "./Icon";

export function CodeSidebar() {
  const lanePattern = useStore((s) => s.ui.lanePattern);
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
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
  const hasCodes = Object.keys(codebook).length > 0;
  const { open: aiMenu, setOpen: setAiMenu, btnRef: aiBtnRef, menuRef: aiMenuRef } = useToggleMenu();

  // keyboard/visible route to the same menu right-click opens, anchored to the row or ⋯ button
  const openMenuAt = (code: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ code, x: r.left, y: r.bottom + 2 });
  };

  const counts: Record<string, { segs: number; pids: Set<string> }> = {};
  segments.filter((s) => s.status === "accepted").forEach((s) => {
    (counts[s.code] ??= { segs: 0, pids: new Set() });
    counts[s.code].segs++; counts[s.code].pids.add(s.pid);
  });

  return (
    <div id="sidebar" style={{ fontSize: sidebarFontSize, width: sidebarWidth }}>
      {/* + new code, with the transcript's AI actions in a menu beside it. The AI
          acts on THIS transcript (the sidebar only renders for a transcript view),
          so its home is here, not the global toolbar. */}
      <div className="sidebarNewRow">
        <CodeCombobox placeholder="+ new code" />
        <button className="btn aibtn aiMenuBtn" ref={aiBtnRef}
          aria-haspopup="menu" aria-expanded={aiMenu}
          title="AI for this transcript" aria-label="AI for this transcript"
          onClick={() => setAiMenu((v) => !v)}>
          <Icon name="sparkle" size={15} /> <Icon name={aiMenu ? "chevron-up" : "chevron-down"} size={12} />
        </button>
        {aiMenu && (
          <div className="ctxmenu aiMenu" ref={aiMenuRef} role="menu" aria-label="AI for this transcript"
            style={{ fontSize: sidebarFontSize }}>
            <button role="menuitem" onClick={() => { setAiOpen(true); setAiMenu(false); }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI observation scan
            </button>
            <button role="menuitem" disabled={!hasCodes}
              title={hasCodes ? undefined : "Add a code first — suggestions apply your existing codes"}
              onClick={() => { if (hasCodes) { setSuggestOpen(true); setAiMenu(false); } }}>
              <Icon name="sparkle" size={sidebarFontSize} /> AI code suggestion
            </button>
          </div>
        )}
      </div>
      <div className="codeList nicescroll">
      {Object.keys(codebook).sort().map((code) => {
        const slot = hotbarCache.indexOf(code);
        const c = counts[code];
        return (
          <div key={code} className="codeItem" tabIndex={0} role="button"
            aria-label={`Apply code ${code}`
              + (slot >= 0 && slot < 9 ? `, hotkey ${slot + 1}` : "")
              + `, ${c?.segs ?? 0} segment${c?.segs === 1 ? "" : "s"}`}
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
            {/* right-click only: a left-click on the swatch is almost always a missed
                click on the row (apply code) — let it fall through. Keyboard and
                screen-reader users recolor via the ⋯ menu's "Change color…". */}
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
            {pinned.includes(code) && <span className="pindot" title="pinned">●</span>}
            {/* hotkey + count are already in the row's aria-label — hide the visual
                badges so they don't double-speak */}
            {slot >= 0 && slot < 9 && <span className="key" aria-hidden="true">{slot + 1}</span>}
            <span className="cnt" aria-hidden="true">{c ? `${c.segs}·${c.pids.size}` : "0"}</span>
            <button className="rowMenu" aria-label={`Options for ${code}`}
              onClick={(e) => { e.stopPropagation(); openMenuAt(code, e.currentTarget); }}>⋯</button>
          </div>
        );
      })}
      </div>
      {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {aiOpen && <AiCheckModal onClose={() => setAiOpen(false)} />}
      {suggestOpen && <SuggestModal onClose={() => setSuggestOpen(false)} />}
    </div>
  );
}
