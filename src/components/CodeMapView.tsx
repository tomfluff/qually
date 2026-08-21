// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Code map: the whole codebook as a spatial surface — pan, zoom, select,
// then act (open the selection in the Codebook, or merge it down). Built on
// React Flow: with 150+ codes the canvas must pan outside React's render loop,
// and its d3-zoom viewport does exactly that (a hand-rolled transform-on-state
// version re-rendered every chip per pointermove and stuttered).
// AI grouping lands on this surface next.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, MiniMap, Controls, Panel, SelectionMode,
  useNodesState, useReactFlow, type Node, type NodeProps, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../state/store";
import { codeStats } from "../codeStats";
import { preselectBrowse } from "./BrowseView";
import { CodeCounts } from "./CodeCounts";
import { Icon, countIconSize } from "./Icon";

// chip geometry in WORLD units — the viewport transform scales the world.
// Chips fit their content: width is the measured name plus the count block
// (uniform padding would leave a field of dead air around short names), and
// everything scales with the sidebar text ramp so large accessible settings
// never clip. Rows are shelf-packed toward a near-square map.
const GX = 14, GY = 12;
const chipH = (fs: number) => Math.round(fs * 2.4);
const measurer = document.createElement("canvas").getContext("2d")!;
const chipW = (fs: number, name: string, segs: number, pids: number) => {
  measurer.font = `600 ${fs}px ${getComputedStyle(document.body).fontFamily}`;
  const counts = measurer.measureText(`${segs}${pids}`).width + fs * 2.4; // two icons + gaps
  return Math.round(10 + 10 + measurer.measureText(name).width + 14 + counts + 12);
};

type ChipData = { code: string; color: string; segs: number; pids: number };
type ChipNodeT = Node<ChipData, "chip">;

// positions (drags survive), viewport and selection outlive the unmounting view
const remembered = {
  positions: {} as Record<string, { x: number; y: number }>,
  viewport: null as Viewport | null,
  selected: new Set<string>(),
};

function ChipNode({ data, selected }: NodeProps<ChipNodeT>) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  return (
    <div className={"mapChip" + (selected ? " sel" : "")}
      style={{ height: chipH(fs), "--chip-c": data.color } as React.CSSProperties}
      title={`${data.code} — ${data.segs} excerpt${data.segs === 1 ? "" : "s"} in ${data.pids} transcript${data.pids === 1 ? "" : "s"}`}>
      <span className="mapName">{data.code}</span>
      <CodeCounts stat={{ segs: data.segs, pids: data.pids }} size={countIconSize(fs)} />
    </div>
  );
}
const nodeTypes = { chip: ChipNode };

const NEXT_CORNER = {
  "bottom-right": "bottom-left", "bottom-left": "top-left",
  "top-left": "top-right", "top-right": "bottom-right",
} as const;

function MapInner() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const dark = useStore((s) => s.ui.dark);
  const setActive = useStore((s) => s.setActive);
  const mergeCode = useStore((s) => s.mergeCode);
  const mapMinimap = useStore((s) => s.ui.mapMinimap);
  const setUi = useStore((s) => s.setUi);
  const { setNodes: rfSetNodes } = useReactFlow();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // biggest first: the codes doing the most work anchor the top of the map
  const codes = useMemo(() =>
    Object.keys(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  const build = useCallback((): ChipNodeT[] => {
    const fs = useStore.getState().ui.sidebarFontSize;
    const ch = chipH(fs);
    const widths = codes.map((c) => chipW(fs, c, stats[c]?.segs ?? 0, stats[c]?.pids ?? 0));
    // shelf-pack toward a near-square map: row width from the total chip area
    const area = widths.reduce((a, w) => a + (w + GX) * (ch + GY), 0);
    const rowW = Math.max(680, Math.sqrt(area) * 1.45);
    let x = 0, y = 0;
    return codes.map((c, i) => {
      const w = widths[i];
      if (x > 0 && x + w > rowW) { x = 0; y += ch + GY; }
      const pos = remembered.positions[c] ?? { x, y };
      x += w + GX;
      return {
        id: c,
        type: "chip" as const,
        position: pos,
        width: w, height: ch,
        selected: remembered.selected.has(c),
        data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0 },
      };
    });
  }, [codes, codebook, stats]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ChipNodeT>(build());
  // the codebook changed under the map (a merge, a rename, new codes): rebuild,
  // keeping every surviving chip where it was
  useEffect(() => { setNodes(build()); }, [build, setNodes]);
  // selection outlives the view; positions are recorded per drag (below), so
  // the packer stays in charge of everything the user hasn't placed by hand
  useEffect(() => {
    remembered.selected = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
  }, [nodes]);

  const sel = nodes.filter((n) => n.selected).map((n) => n.id);
  const openInCodebook = (list: string[]) => { preselectBrowse(list); setActive("browse"); };

  const soloUnlessSelected = (id: string) => {
    if (!remembered.selected.has(id))
      rfSetNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  };
  const doMerge = (into: string) => {
    sel.filter((c) => c !== into).forEach((c) => mergeCode(c, into));
    setMenu(null);
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

  return (
    <div id="codemap" style={{ fontSize: sidebarFontSize }}>
      <div className="mapBar">
        <span className="mapTitle">Code map</span>
        <span className="mapHint">The whole codebook at once. Drag to select, <b>Space+drag</b> (or middle/right-drag) to pan, wheel to zoom. Right-click a selection to act on it; double-click a code for its excerpts.</span>
        <span className="mapCount">{codes.length} code{codes.length === 1 ? "" : "s"}</span>
        <button className="btn iconbtn" onClick={() => setUi({ mapMinimap: NEXT_CORNER[mapMinimap] })}
          title="Move the minimap to the next corner">
          <Icon name="pip" size={15} />
        </button>
      </div>
      <div className="mapCanvas">
        {codes.length === 0
          ? <div className="empty">No codes yet — the map draws itself as you code.</div>
          : (
          <ReactFlow<ChipNodeT>
            nodes={nodes} onNodesChange={onNodesChange} nodeTypes={nodeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView={!remembered.viewport}
            defaultViewport={remembered.viewport ?? undefined}
            onMoveEnd={(_, vp) => { remembered.viewport = vp; }}
            minZoom={0.1} maxZoom={3}
            selectionOnDrag panOnDrag={[1, 2]} selectionMode={SelectionMode.Partial}
            multiSelectionKeyCode={["Control", "Meta"]}
            onNodeDragStop={(_, n) => { remembered.positions[n.id] = n.position; }}
            zoomOnDoubleClick={false} deleteKeyCode={null} nodesConnectable={false}
            onNodeDoubleClick={(_, n) => openInCodebook([n.id])}
            onNodeContextMenu={(e, n) => { e.preventDefault(); soloUnlessSelected(n.id); setMenu({ x: e.clientX, y: e.clientY }); }}
            onSelectionContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
            onPaneContextMenu={(e) => e.preventDefault()}>
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable position={mapMinimap}
              nodeColor={(n) => (n as ChipNodeT).data.color} />
            {/* selection actions float OVER the canvas — appearing must not
                resize the bar or reflow the viewport mid-drag */}
            {sel.length > 0 && (
              <Panel position="top-right" className="mapSelPanel">
                <span className="mapSelCount">{sel.length} selected</span>
                <button className="btn" onClick={() => openInCodebook(sel)}>Open in Codebook</button>
              </Panel>
            )}
          </ReactFlow>
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

export function CodeMapView() {
  return <ReactFlowProvider><MapInner /></ReactFlowProvider>;
}
