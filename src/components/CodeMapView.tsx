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
  ReactFlow, ReactFlowProvider, MiniMap, Controls, Panel, useNodesState, useReactFlow,
  type Node, type NodeProps, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../state/store";
import { codeStats } from "../codeStats";
import { preselectBrowse } from "./BrowseView";
import { CodeCounts } from "./CodeCounts";
import { Icon, countIconSize } from "./Icon";

// chip geometry in WORLD units — the viewport transform scales the world.
// Sized from the panel text ramp: the name needs two full lines and the count
// row at ANY sidebar font size, so a fixed pixel height would clip the large
// accessible settings this app exists for.
const GX = 18, GY = 16;
const dims = (fs: number) => ({ cw: Math.round(fs * 15), ch: Math.round(fs * 4.2 + 16) });

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
  const { cw, ch } = dims(fs);
  return (
    <div className={"mapChip" + (selected ? " sel" : "")}
      style={{ width: cw, height: ch, "--chip-c": data.color } as React.CSSProperties}
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
    const { cw, ch } = dims(useStore.getState().ui.sidebarFontSize);
    const cols = Math.max(1, Math.ceil(Math.sqrt(codes.length * 1.6)));
    return codes.map((c, i) => ({
      id: c,
      type: "chip" as const,
      position: remembered.positions[c]
        ?? { x: (i % cols) * (cw + GX), y: Math.floor(i / cols) * (ch + GY) },
      width: cw, height: ch,
      selected: remembered.selected.has(c),
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0 },
    }));
  }, [codes, codebook, stats]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ChipNodeT>(build());
  // the codebook changed under the map (a merge, a rename, new codes): rebuild,
  // keeping every surviving chip where it was
  useEffect(() => { setNodes(build()); }, [build, setNodes]);
  // drags and selection outlive the view
  useEffect(() => {
    for (const n of nodes) remembered.positions[n.id] = n.position;
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
        <span className="mapHint">The whole codebook at once. Drag to pan, wheel to zoom, <b>Shift+drag</b> to select a region, right-click a selection to act on it. Double-click a code for its excerpts.</span>
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
            panOnDrag selectionOnDrag={false} selectionKeyCode="Shift"
            multiSelectionKeyCode={["Control", "Meta"]}
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
