import { useState } from "react";
import { useStore } from "../state/store";

export function CodeSidebar() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const hotbarCache = useStore((s) => s.hotbarCache);
  const hasSel = useStore((s) => s.selection.lines.size > 0);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const ensureCode = useStore((s) => s.ensureCode);
  const applyCode = useStore((s) => s.applyCode);
  const setColor = useStore((s) => s.setColor);
  const pushUndo = useStore((s) => s.pushUndo);
  const togglePin = useStore((s) => s.togglePin);
  const pinned = useStore((s) => s.hotbar.pinned);
  const [draft, setDraft] = useState("");

  const counts: Record<string, { segs: number; pids: Set<string> }> = {};
  segments.filter((s) => s.status === "accepted").forEach((s) => {
    (counts[s.code] ??= { segs: 0, pids: new Set() });
    counts[s.code].segs++; counts[s.code].pids.add(s.pid);
  });

  const addNew = () => {
    if (!draft.trim()) return;
    pushUndo();
    const c = ensureCode(draft.trim());
    setDraft("");
    if (hasSel) applyCode(c);
  };

  return (
    <div id="sidebar" style={{ fontSize: sidebarFontSize }}>
      {/* + new code moved to the TOP of the list (W3 item 12) */}
      <input id="newCode" value={draft} placeholder="+ new code (Enter)"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && addNew()} />
      <h3>all codes</h3>
      {Object.keys(codebook).sort().map((code) => {
        const slot = hotbarCache.indexOf(code);
        const c = counts[code];
        return (
          <div key={code} className="codeItem"
            onClick={() => { if (hasSel) { pushUndo(); applyCode(code); } }}
            onContextMenu={(e) => { e.preventDefault(); togglePin(code); }}
            title={`${code}  (right-click: pin/unpin for hotbar)`}>
            <span className="swatch" style={{ background: codebook[code].color }}
              onClick={(e) => {
                e.stopPropagation();
                const inp = document.createElement("input");
                inp.type = "color"; inp.value = codebook[code].color;
                inp.oninput = () => setColor(code, inp.value);
                inp.click();
              }} />
            <span>{code}</span>
            {pinned.includes(code) && <span className="pindot" title="pinned">●</span>}
            {slot >= 0 && slot < 9 && <span className="key">{slot + 1}</span>}
            <span className="cnt">{c ? `${c.segs}·${c.pids.size}` : "0"}</span>
          </div>
        );
      })}
    </div>
  );
}
