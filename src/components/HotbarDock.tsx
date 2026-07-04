import { useState } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

// Game-style hotbar: bottom-center row of numbered colored tiles (1-9) + a
// refresh tile. Clicking a tile applies that code to the selection (mirrors the
// number-key shortcuts). Mode (auto/pinned) selection moves to Settings (W4);
// pinning stays right-click-from-sidebar.
export function HotbarDock() {
  const codes = useStore((s) => s.hotbarCache);
  const mode = useStore((s) => s.hotbar.mode);
  const codebook = useStore((s) => s.codebook);
  const fontSize = useStore((s) => s.ui.fontSize);
  const hasSel = useStore((s) => s.selection.lines.size > 0);
  const applyCode = useStore((s) => s.applyCode);
  const pushUndo = useStore((s) => s.pushUndo);
  const refreshHotbar = useStore((s) => s.refreshHotbar);
  const [collapsed, setCollapsed] = useState(false);

  const tiles = codes.filter((c) => codebook[c]).slice(0, 9);
  if (!Object.keys(codebook).length) return null;

  const apply = (code: string) => { if (hasSel) { pushUndo(); applyCode(code); } };

  return (
    <div className={"hotbar" + (collapsed ? " collapsed" : "")}>
      {/* collapse arrow extrudes from the top edge, always visible */}
      <button className="hbhandle" onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "show hotbar" : "hide hotbar"}>
        <svg className="harrow" width="40" height="11" viewBox="0 0 46 12" aria-hidden>
          <polygon points={collapsed ? "8,9 38,9 23,3" : "8,3 38,3 23,9"} fill="currentColor" />
        </svg>
      </button>
      <div className="tiles">
        {tiles.map((code, i) => (
          <button key={code} className="tile" style={{ background: codebook[code].color }}
            onClick={() => apply(code)}>
            <span className="tnum">{i + 1}</span>
            <span className="tname" style={{ fontSize }}>{code}</span>
          </button>
        ))}
        <button className="tile newcode" onClick={() => useStore.getState().setPalette(true)}
          title="open the code palette (fuzzy search)">
          <span className="tnum">0</span>
          <span className="tname" style={{ fontSize }}>new / find code…</span>
        </button>
        {mode === "auto"
          ? (
            <button className="tile refresh" onClick={refreshHotbar} title="recompute by usage">
              <Icon name="refresh" size={20} />
            </button>
          )
          : tiles.length === 0 && (
            <span className="hbhint">Right-click a code to pin</span>
          )}
      </div>
    </div>
  );
}
