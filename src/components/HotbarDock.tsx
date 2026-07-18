// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useState } from "react";
import { useStore, inkOn } from "../state/store";
import { CodeMenu } from "./CodeMenu";
import { Icon } from "./Icon";

// up to 2 initials from the code's first two significant words (skip stopwords)
const STOP = new Set(["the", "a", "an", "of", "on", "in", "to", "for", "and", "or", "at", "by", "with", "is"]);
function initials(code: string): string {
  const words = code.split(/[\s\-_/]+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return code.slice(0, 2).toUpperCase();
}

// Game-style hotbar: bottom-center row of numbered colored tiles (1-9) + a
// refresh tile. Clicking a tile applies that code to the selection (mirrors the
// number-key shortcuts). Mode (auto/pinned) selection moves to Settings (W4);
// pinning stays right-click-from-sidebar.
export function HotbarDock() {
  const codes = useStore((s) => s.hotbarCache);
  const mode = useStore((s) => s.hotbar.mode);
  const codebook = useStore((s) => s.codebook);
  const hasSel = useStore((s) => s.selection.lines.size > 0);
  const applyCode = useStore((s) => s.applyCode);
  const refreshHotbar = useStore((s) => s.refreshHotbar);
  const [collapsed, setCollapsed] = useState(false);
  // right-click (or the menu key) on a tile: the same code menu the sidebar rows open
  const [menu, setMenu] = useState<{ code: string; x: number; y: number } | null>(null);

  // no early return on an empty codebook: before the first code exists the dock
  // still shows the "0" palette tile (the way to CREATE that first code) + refresh
  const tiles = codes.filter((c) => codebook[c]).slice(0, 9);

  const apply = (code: string) => { if (hasSel) applyCode(code); };

  return (
    <>
    <div className={"hotbar" + (collapsed ? " collapsed" : "")}>
      {/* collapse arrow extrudes from the top edge, always visible */}
      <button className="hbhandle" onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "show hotbar" : "hide hotbar"}>
        <svg className="harrow" width="40" height="11" viewBox="0 0 46 12" aria-hidden>
          <polygon points={collapsed ? "8,9 38,9 23,3" : "8,3 38,3 23,9"} fill="currentColor" />
        </svg>
      </button>
      <div className="tiles" role="toolbar" aria-label="Code hotbar">
        {tiles.map((code, i) => (
          <div key={code} className="hbslot">
            {/* ink from the tile's own luminance (inkOn), not hardcoded white —
                code colours are user-picked, same fix as the speaker chip */}
            {/* the initials are visual shorthand — the full code name is one hover/focus
                away (shared Tooltip); the accessible name carries it plus the number key */}
            <button className="tile" aria-label={`Apply code ${code} (key ${i + 1})`}
              data-tip={code}
              style={{ background: codebook[code].color, color: inkOn(codebook[code].color) }}
              onClick={() => apply(code)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ code, x: e.clientX, y: e.clientY }); }}
              onKeyDown={(e) => {
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ code, x: r.left, y: r.top }); // the menu clamps itself on-screen
                }
              }}>
              <span className="tinit">{initials(code)}</span>
            </button>
            <span className="tnum" aria-hidden="true">{i + 1}</span>
          </div>
        ))}
        <div className="hbslot">
          <button className="tile newcode" onClick={() => useStore.getState().setPalette(true)}
            data-tip="new / find code… (fuzzy search)">
            <Icon name="library-plus" size={20} />
          </button>
          <span className="tnum" aria-hidden="true">0</span>
        </div>
        {mode === "auto"
          ? (
            <button className="tile refresh" onClick={refreshHotbar} data-tip="recompute by usage"
              aria-label="Refresh hotbar (recompute by usage)">
              <Icon name="refresh" size={20} />
            </button>
          )
          : tiles.length === 0 && (
            <span className="hbhint">Right-click a code to pin</span>
          )}
      </div>
    </div>
    {/* sibling of the dock, not a child: .hotbar's z-index:45 is its own stacking
        context, and a menu inside it could paint under the video dock (z 50) */}
    {menu && <CodeMenu code={menu.code} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  );
}
