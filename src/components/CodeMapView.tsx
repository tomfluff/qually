// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Code map: the whole codebook as a spatial surface — pan, zoom, select,
// then act (open the selection in the Codebook, or merge it down). This is the
// canvas for code revision: seeing 150 codes at once is the point, and the
// map's job is to make "these five are one idea" a visual observation before
// it becomes a merge. AI grouping lands on this surface next.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { codeStats } from "../codeStats";
import { preselectBrowse } from "./BrowseView";
import { Icon } from "./Icon";

// chip geometry in WORLD units — the transform scales the world, not the chips
const CW = 190, CH = 54, GX = 18, GY = 16;

// pan/zoom/selection survive leaving the tab (the view unmounts)
const remembered = {
  pan: { x: 0, y: 0 },
  zoom: 0,            // 0 = never positioned: fit on first show
  selected: new Set<string>(),
};

export function CodeMapView() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const setActive = useStore((s) => s.setActive);
  const mergeCode = useStore((s) => s.mergeCode);
  const outRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState(remembered.pan);
  const [zoom, setZoom] = useState(remembered.zoom || 1);
  const [selected, setSelected] = useState<Set<string>>(remembered.selected);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => { Object.assign(remembered, { pan, zoom, selected }); }, [pan, zoom, selected]);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // biggest first: the codes doing the most work anchor the top of the map
  const codes = useMemo(() =>
    Object.keys(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  // world layout: a near-square grid
  const cols = Math.max(1, Math.ceil(Math.sqrt(codes.length * 1.6)));
  const posOf = (i: number) => ({ x: (i % cols) * (CW + GX), y: Math.floor(i / cols) * (CH + GY) });
  const worldW = Math.min(codes.length, cols) * (CW + GX) - GX;
  const worldH = Math.ceil(codes.length / cols) * (CH + GY) - GY;

  const fit = () => {
    const el = outRef.current;
    if (!el || !codes.length) return;
    const z = Math.min(2, Math.max(0.12,
      Math.min((el.clientWidth - 48) / worldW, (el.clientHeight - 48) / worldH)));
    setZoom(z);
    setPan({ x: (el.clientWidth - worldW * z) / 2, y: (el.clientHeight - worldH * z) / 2 });
  };
  // first showing ever: frame the whole codebook. Decided at render time —
  // the remembered-state sync effect above runs first and would overwrite the
  // "never positioned" marker before this effect could read it.
  const needFit = useRef(remembered.zoom === 0);
  useEffect(() => { if (needFit.current) { needFit.current = false; fit(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // wheel zoom, anchored on the cursor. A native non-passive listener — React's
  // synthetic wheel can't preventDefault the page scroll.
  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      setZoom((z) => {
        const nz = Math.min(3, Math.max(0.12, z * Math.exp(-e.deltaY * 0.0012)));
        setPan((p) => ({ x: cx - (cx - p.x) * (nz / z), y: cy - (cy - p.y) * (nz / z) }));
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // drag on empty space: pan — or, with Shift, sweep a selection box
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".mapChip")) return;
    const el = outRef.current!;
    const r = el.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const p0 = pan;
    const sweep = e.shiftKey;
    if (!sweep && !e.ctrlKey && !e.metaKey) setSelected(new Set()); // click-away clears
    const move = (ev: PointerEvent) => {
      if (sweep) {
        setBox({ x0: sx - r.left, y0: sy - r.top, x1: ev.clientX - r.left, y1: ev.clientY - r.top });
      } else {
        setPan({ x: p0.x + ev.clientX - sx, y: p0.y + ev.clientY - sy });
      }
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (sweep) {
        // screen box -> world box -> every chip it touches joins the selection
        const [bx0, bx1] = [Math.min(sx, ev.clientX) - r.left, Math.max(sx, ev.clientX) - r.left];
        const [by0, by1] = [Math.min(sy, ev.clientY) - r.top, Math.max(sy, ev.clientY) - r.top];
        const wx0 = (bx0 - pan.x) / zoom, wx1 = (bx1 - pan.x) / zoom;
        const wy0 = (by0 - pan.y) / zoom, wy1 = (by1 - pan.y) / zoom;
        setSelected((old) => {
          const n = new Set(old);
          codes.forEach((c, i) => {
            const p = posOf(i);
            if (p.x < wx1 && p.x + CW > wx0 && p.y < wy1 && p.y + CH > wy0) n.add(c);
          });
          return n;
        });
        setBox(null);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const clickChip = (e: React.MouseEvent, c: string) => {
    e.stopPropagation();
    setSelected((old) => {
      if (e.ctrlKey || e.metaKey) { const n = new Set(old); n.has(c) ? n.delete(c) : n.add(c); return n; }
      return new Set([c]);
    });
  };
  const openInCodebook = (list: string[]) => {
    preselectBrowse(list);
    setActive("browse");
  };
  const onChipMenu = (e: React.MouseEvent, c: string) => {
    e.preventDefault();
    if (!selected.has(c)) setSelected(new Set([c]));
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // menu dismissal: any outside press or Escape
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest(".mapMenu")) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(null); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [menu]);

  const sel = [...selected].filter((c) => c in codebook);
  const doMerge = (into: string) => {
    sel.filter((c) => c !== into).forEach((c) => mergeCode(c, into));
    setSelected(new Set([into]));
    setMenu(null);
  };

  return (
    <div id="codemap" style={{ fontSize: sidebarFontSize }}>
      <div className="mapBar">
        <span className="mapTitle">Code map</span>
        <span className="mapHint">The whole codebook at once. Drag to pan, wheel to zoom, <b>Shift+drag</b> to select a region, right-click a selection to act on it. Double-click a code for its excerpts.</span>
        <span className="mapCount">{codes.length} code{codes.length === 1 ? "" : "s"}</span>
        {sel.length > 0 && (
          <button className="btn" onClick={() => openInCodebook(sel)}>
            Open {sel.length} in Codebook
          </button>
        )}
        <button className="btn iconlabel" onClick={fit} title="Frame the whole map">
          <Icon name="target" size={15} /> <span className="blabel">Fit</span>
        </button>
      </div>
      <div className="mapCanvas" ref={outRef} onPointerDown={onDown}
        role="application" aria-label={`Code map, ${codes.length} codes`}>
        {codes.length === 0 && (
          <div className="empty">No codes yet — the map draws itself as you code.</div>
        )}
        <div className="mapWorld" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {codes.map((c, i) => {
            const p = posOf(i);
            const st = stats[c];
            return (
              <button key={c} className={"mapChip" + (selected.has(c) ? " sel" : "")}
                style={{ left: p.x, top: p.y, width: CW, height: CH }}
                onClick={(e) => clickChip(e, c)}
                onDoubleClick={() => openInCodebook([c])}
                onContextMenu={(e) => onChipMenu(e, c)}
                title={`${c} — ${st?.segs ?? 0} excerpt${(st?.segs ?? 0) === 1 ? "" : "s"} in ${st?.pids ?? 0} transcript${(st?.pids ?? 0) === 1 ? "" : "s"}`}>
                <span className="mapDot" style={{ background: codebook[c]?.color || "#999" }} />
                <span className="mapName">{c}</span>
                <span className="mapMeta">{st?.segs ?? 0} · {st?.pids ?? 0}</span>
              </button>
            );
          })}
        </div>
        {box && (
          <div className="mapBox" style={{
            left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1),
            width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />
        )}
      </div>
      {menu && sel.length > 0 && (
        <div className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => { openInCodebook(sel); setMenu(null); }}>
            Open {sel.length === 1 ? sel[0] : `${sel.length} codes`} in Codebook
          </button>
          {sel.length > 1 && <>
            <div className="mapMenuHead">Merge {sel.length} into…</div>
            {sel.map((c) => (
              <button key={c} role="menuitem" onClick={() => doMerge(c)}>
                <span className="mapDot" style={{ background: codebook[c]?.color || "#999" }} /> {c}
              </button>
            ))}
          </>}
        </div>
      )}
    </div>
  );
}
