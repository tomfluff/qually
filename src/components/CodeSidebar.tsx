import { useState } from "react";
import { useStore, patternOf } from "../state/store";
import { CodeMenu } from "./CodeMenu";
import { CodeCombobox } from "./CodeCombobox";
import { openColorPicker } from "../colorPicker";

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
      {/* + new code (top of list); fuzzy autocomplete. 0 opens the command palette. */}
      <CodeCombobox placeholder="+ new code" />
      <div className="codeList nicescroll">
      <h3>all codes</h3>
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
            <span className={"codebar" + (lanePattern ? ` lp${patternOf(code)}` : "")}
              role="button" aria-label={`Recolor ${code}`}
              style={{ background: codebook[code].color }} title="recolor"
              onClick={(e) => {
                e.stopPropagation();
                openColorPicker(codebook[code].color, (v) => setColor(code, v));
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
    </div>
  );
}
