// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Code map: the whole codebook as a spatial surface — pan, zoom, select,
// then act (open the selection in the Codebook, or merge it down). Built on
// React Flow, uncontrolled, following its performance playbook for hundreds
// of nodes (see .agents/skills/react-flow):
//   - RF owns the node array (defaultNodes); the codebook effect rebuilds it
//     through the instance API only when codes actually change.
//   - NOTHING at this level subscribes to selection. The floating action panel
//     is its own component with a narrow RF-store subscription, so a box-drag
//     re-renders that one strip — never the 180 chips, the MiniMap, or the
//     selection rectangle's ancestors. (A controlled version re-rendered the
//     world per membership change and the rectangle lagged the pointer.)
//   - Custom node is memo'd; nodeTypes/handlers are stable references.
// AI grouping lands on this surface next.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, MiniMap, Controls, Panel, SelectionMode,
  useReactFlow, useStore as useFlowStore, useStoreApi as useFlowStoreApi,
  type Node, type NodeProps, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "../state/store";
import { codeStats } from "../codeStats";
import { preselectBrowse } from "./BrowseView";
import { CodeCounts } from "./CodeCounts";
import { Icon, countIconSize } from "./Icon";
import { GroupModal } from "./GroupModal";

// chip geometry in WORLD units — the viewport transform scales the world.
// Chips fit their content: width is the measured name plus the count block
// (uniform padding would leave a field of dead air around short names), and
// everything scales with the sidebar text ramp so large accessible settings
// never clip. Rows are shelf-packed toward a near-square map.
const GX = 14, GY = 12, PAD = 18, ISLAND_GAP = 64;
const chipH = (fs: number) => Math.round(fs * 2.4);
const measurer = document.createElement("canvas").getContext("2d")!;
const chipW = (fs: number, name: string, segs: number, pids: number) => {
  const family = getComputedStyle(document.body).fontFamily;
  measurer.font = `600 ${fs}px ${family}`;
  const nameW = measurer.measureText(name).width;
  measurer.font = `700 ${fs}px ${family}`; // the counts render bold
  const counts = measurer.measureText(`${segs}${pids}`).width + fs * 2.6; // icons + inner gaps
  // borders + padding + name/counts gap, with slack — a measured width that
  // comes up 2px short reads as a bug on every single chip
  return Math.round(nameW + counts + 64);
};

type ChipData = { code: string; color: string; segs: number; pids: number };
type ChipNodeT = Node<ChipData, "chip">;
type IslandData = { name: string; gi: number };
type IslandNodeT = Node<IslandData, "island">;
type MapNode = ChipNodeT | IslandNodeT;

// positions (drags survive), viewport and selection outlive the unmounting view
const remembered = {
  // chip positions are RELATIVE to their island (absolute when ungrouped/flat)
  positions: {} as Record<string, { x: number; y: number }>,
  islandPos: {} as Record<string, { x: number; y: number }>,
  viewport: null as Viewport | null,
  selected: new Set<string>(),
};

const ChipNode = memo(function ChipNode({ data, selected }: NodeProps<ChipNodeT>) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  return (
    <div className={"mapChip" + (selected ? " sel" : "")}
      style={{ "--chip-c": data.color } as React.CSSProperties}
      title={`${data.code} — ${data.segs} excerpt${data.segs === 1 ? "" : "s"} in ${data.pids} transcript${data.pids === 1 ? "" : "s"}`}>
      <span className="mapName">{data.code}</span>
      <CodeCounts stat={{ segs: data.segs, pids: data.pids }} size={countIconSize(fs)} />
    </div>
  );
});
const LOOSE = "\u0000loose";

const NEXT_CORNER = {
  "bottom-right": "bottom-left", "bottom-left": "top-left",
  "top-left": "top-right", "top-right": "bottom-right",
} as const;

const openInCodebook = (list: string[]) => {
  preselectBrowse(list);
  useStore.getState().setActive("browse");
};

// The one selection subscriber. A newline-joined id string is its own
// equality check, so this re-renders exactly when membership changes —
// and nothing else in the tree does.
const selectedIdsSel = (s: { nodes: Node[] }) =>
  s.nodes.filter((n) => n.selected && n.type === "chip").map((n) => n.id).join("\n");
function SelectionHud() {
  const joined = useFlowStore(selectedIdsSel);
  const sel = useMemo(() => (joined ? joined.split("\n") : []), [joined]);
  useEffect(() => { remembered.selected = new Set(sel); }, [sel]);
  return (
    <Panel position="top-right" className="mapSelPanel"
      style={{ visibility: sel.length > 0 ? "visible" : "hidden" }}>
      <span className="mapSelCount">{sel.length} selected</span>
      <button className="btn" onClick={() => openInCodebook(sel)}>Open in Codebook</button>
    </Panel>
  );
}

// Islands are real React Flow nodes and chips are their CHILDREN (RF
// sub-flows): dragging an island by its caption is native RF node dragging,
// so the whole family moves live and smoothly — no custom drag code. The node
// body is click-through (box-select sweeps across it); only the caption is
// live, and it is the drag handle. Semantic zoom: the caption counter-scales
// against the viewport so it holds a readable on-screen size zoomed out (far
// away the map reads as GROUP NAMES), clamping at a base deliberately above
// the code text size — titles outrank chips.
const zoomSel = (s: { transform: [number, number, number] }) => s.transform[2];
const IslandNode = memo(function IslandNode({ data }: NodeProps<IslandNodeT>) {
  const zoom = useFlowStore(zoomSel);
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const base = fs * 1.3;
  const fontSize = Math.min(base * 7, Math.max(base, base / zoom));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const rename = () => {
    const st = useStore.getState();
    if (draft.trim()) st.setCodeGroups(st.codeGroups.map((g, i) => (i === data.gi ? { ...g, name: draft.trim() } : g)));
    setEditing(false);
  };
  const dissolve = () => {
    const st = useStore.getState();
    st.codeGroups[data.gi]?.codes.forEach((c) => delete remembered.positions[c]);
    st.setCodeGroups(st.codeGroups.filter((_, i) => i !== data.gi));
  };
  return (
    <div className={"mapIsland" + (data.gi === -1 ? " loose" : "")}>
      <div className="mapIslandLabel" style={{ fontSize }}>
        {data.gi === -1 ? (
          <span className="mapIslandName loose">{data.name}</span>
        ) : editing ? (
          <input className="mapIslandEdit nodrag" value={draft} autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
              if (e.key === "Escape") { e.stopPropagation(); setDraft(data.name); setEditing(false); }
            }} />
        ) : (
          <>
            <span className="mapIslandName" title="Drag to move the group; double-click to rename"
              onDoubleClick={() => { setDraft(data.name); setEditing(true); }}>{data.name}</span>
            <button className="mapIslandX nodrag" title="Dissolve this group (codes stay)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={dissolve}>×</button>
          </>
        )}
      </div>
    </div>
  );
});
const nodeTypes = { chip: ChipNode, island: IslandNode };

// React Flow commits its marquee through React on EVERY pointer event with no
// rAF gate (verified in the installed v12.11.3 source with codex): a high-rate
// mouse lands several unsynchronized commits per display frame, and the
// rectangle judders while fps reads steady. RF keeps doing all the selection
// logic; its own marquee is display:none, and this paints the latest rectangle
// imperatively, at most once per animation frame.
function RafSelectionMarquee() {
  const flowStore = useFlowStoreApi();
  const elementRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const initial = flowStore.getState();
    let latest = initial.userSelectionActive ? initial.userSelectionRect : null;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const element = elementRef.current;
      if (!element) return;
      const rect = latest;
      if (!rect) { element.style.display = "none"; return; }
      // all four edges through ONE pipeline (layout): a composited transform
      // for position updates ahead of the layouted width/height, and on an
      // upward drag — where position changes every frame — the box tears
      element.style.left = `${rect.x}px`;
      element.style.top = `${rect.y}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.display = "block";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.userSelectionActive === previous.userSelectionActive &&
          state.userSelectionRect === previous.userSelectionRect) return;
      latest = state.userSelectionActive ? state.userSelectionRect : null;
      schedule();
    });
    schedule();
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [flowStore]);
  return <div ref={elementRef} className="mapRafMarquee" aria-hidden="true" />;
}

function MapInner() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const dark = useStore((s) => s.ui.dark);
  const mapMinimap = useStore((s) => s.ui.mapMinimap);
  const codeGroups = useStore((s) => s.codeGroups);
  const setCodeGroups = useStore((s) => s.setCodeGroups);
  const setUi = useStore((s) => s.setUi);
  const { setNodes: rfSetNodes, getNodes, getInternalNode } = useReactFlow();
  // menu state carries the selection it acts on, captured at open — the menu
  // needs no live subscription
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string[] } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // biggest first: the codes doing the most work anchor the top of the map
  const codes = useMemo(() =>
    Object.keys(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  // Islands: each group packs its chips into a compact block; the blocks (plus
  // an Ungrouped block) shelf-pack across the canvas. No groups -> one flat map.
  // Islands are parent nodes (before their children in the array, as RF
  // requires); chips inside carry parentId and RELATIVE positions.
  const layout = useMemo(() => {
    const fs = sidebarFontSize;
    const ch = chipH(fs);
    const widths = new Map(codes.map((c) => [c, chipW(fs, c, stats[c]?.segs ?? 0, stats[c]?.pids ?? 0)]));
    const pack = (list: string[], targetW: number) => {
      let x = 0, y = 0, maxW = 0;
      const pos: Record<string, { x: number; y: number }> = {};
      for (const c of list) {
        const w = widths.get(c)!;
        if (x > 0 && x + w > targetW) { x = 0; y += ch + GY; }
        pos[c] = { x, y };
        x += w + GX;
        maxW = Math.max(maxW, x - GX);
      }
      return { pos, w: maxW, h: list.length ? y + ch : 0 };
    };
    const near = (list: string[]) => {
      const area = list.reduce((a, c) => a + (widths.get(c)! + GX) * (ch + GY), 0);
      return Math.max(460, Math.sqrt(area) * 1.5);
    };
    const inBook = (c: string) => c in codebook;
    const groups = codeGroups
      .map((g, gi) => ({ ...g, gi, codes: g.codes.filter(inBook) }))
      .filter((g) => g.codes.length > 0);
    const grouped = new Set(groups.flatMap((g) => g.codes));
    const loose = codes.filter((c) => !grouped.has(c));

    const chipNode = (c: string, position: { x: number; y: number }, parentId?: string): ChipNodeT => ({
      id: c,
      type: "chip" as const,
      position: remembered.positions[c] ?? position,
      ...(parentId ? { parentId } : {}),
      width: widths.get(c)!, height: ch,
      selected: remembered.selected.has(c),
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0 },
    });

    if (groups.length === 0) {
      const flat = pack(codes, near(codes));
      return { nodes: codes.map((c) => chipNode(c, flat.pos[c])) as MapNode[] };
    }
    const blocks = [...groups.map((g) => ({ name: g.name, gi: g.gi, list: g.codes })),
      ...(loose.length ? [{ name: "Ungrouped", gi: -1, list: loose }] : [])]
      .map((b) => ({ ...b, ...pack(b.list, near(b.list)) }));
    const totalW = blocks.reduce((a, b) => a + b.w + 2 * PAD + ISLAND_GAP, 0);
    const rowW = Math.max(900, Math.sqrt(totalW * (blocks[0] ? blocks[0].h + 160 : 1)) * 1.6, ...blocks.map((b) => b.w + 2 * PAD));
    const islands: IslandNodeT[] = [];
    const children: ChipNodeT[] = [];
    let ix = 0, iy = 0, rowH = 0;
    for (const b of blocks) {
      const key = b.gi === -1 ? LOOSE : `island:${b.gi}`;
      const bw = b.w + 2 * PAD, bh = b.h + 2 * PAD;
      if (ix > 0 && ix + bw > rowW) { ix = 0; iy += rowH + ISLAND_GAP; rowH = 0; }
      islands.push({
        id: key,
        type: "island" as const,
        position: remembered.islandPos[key] ?? { x: ix, y: iy },
        width: bw, height: bh,
        draggable: true, selectable: false, focusable: false,
        dragHandle: ".mapIslandLabel",
        data: { name: b.name, gi: b.gi },
      });
      for (const c of b.list) children.push(chipNode(c, { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y }, key));
      ix += bw + ISLAND_GAP;
      rowH = Math.max(rowH, bh);
    }
    // parents strictly before children (RF sub-flow requirement)
    return { nodes: [...islands, ...children] as MapNode[] };
  }, [codes, codebook, stats, sidebarFontSize, codeGroups]);
  const build = useCallback(() => layout.nodes, [layout]);

  // built once per mount; RF owns the array from here (uncontrolled). When the
  // codebook changes under the map (a merge, a rename, new codes), rebuild —
  // dragged chips keep their place via remembered.positions.
  const [initialNodes] = useState(build);
  useEffect(() => { rfSetNodes(build()); }, [build, rfSetNodes]);

  // group editing: every mutation goes through the store so it lands in the file
  const moveToGroup = useCallback((code: string, gi: number) => {
    const cur = codeGroups.findIndex((g) => g.codes.includes(code));
    if (cur === gi) return; // includes the flat-map case: -1 === -1
    const next = codeGroups.map((g, i) => ({
      ...g,
      codes: i === gi ? [...g.codes, code] : g.codes.filter((c) => c !== code),
    }));
    delete remembered.positions[code]; // the packer files it into its new island
    setCodeGroups(next);
  }, [codeGroups, setCodeGroups]);
  const groupSelection = (sel: string[]) => {
    const cleaned = codeGroups.map((g) => ({ ...g, codes: g.codes.filter((c) => !sel.includes(c)) }));
    sel.forEach((c) => delete remembered.positions[c]);
    setCodeGroups([...cleaned, { name: `Group ${codeGroups.length + 1}`, codes: sel }]);
    setMenu(null);
  };
  // stable handlers (skill rule: memoize callback props)
  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => { remembered.viewport = vp; }, []);
  // a drag is a filing action once islands exist: a chip joins whichever
  // island its ABSOLUTE center lands in (or leaves its group on open canvas);
  // an island just remembers where it was put (session aesthetics)
  const onNodeDragStop = useCallback((_: unknown, n: Node) => {
    if (n.type === "island") { remembered.islandPos[n.id] = n.position; return; }
    remembered.positions[n.id] = n.position;
    const islands = getNodes().filter((x) => x.type === "island");
    if (!islands.length) return;
    const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
    const cx = abs.x + (n.width ?? 0) / 2, cy = abs.y + (n.height ?? 0) / 2;
    const hit = islands.find((r) => cx >= r.position.x && cx <= r.position.x + (r.width ?? 0)
      && cy >= r.position.y && cy <= r.position.y + (r.height ?? 0));
    const gi = hit ? (hit.data as IslandData).gi : -1;
    moveToGroup(n.id, gi);
  }, [getNodes, getInternalNode, moveToGroup]);
  const onNodeDoubleClick = useCallback((_: unknown, n: Node) => openInCodebook([n.id]), []);
  const selectionAt = useCallback((): string[] =>
    getNodes().filter((n) => n.selected).map((n) => n.id), [getNodes]);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: Node) => {
    e.preventDefault();
    let sel = selectionAt();
    if (!sel.includes(n.id)) {
      sel = [n.id];
      rfSetNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
    }
    setMenu({ x: e.clientX, y: e.clientY, sel });
  }, [selectionAt, rfSetNodes]);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => e.preventDefault(), []);
  const [selecting, setSelecting] = useState(false);
  const onSelectionStart = useCallback(() => setSelecting(true), []);
  const onSelectionEnd = useCallback(() => setSelecting(false), []);
  const nodeColor = useCallback((n: Node) => n.type === "chip" ? (n as ChipNodeT).data.color : "transparent", []);

  const mergeSel = (menuSel: string[], into: string) => {
    const mergeCode = useStore.getState().mergeCode;
    menuSel.filter((c) => c !== into).forEach((c) => mergeCode(c, into));
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
        <button className="btn iconlabel" onClick={() => setAiOpen(true)}
          title="AI proposes similarity groups; they land as islands you can reshape">
          <Icon name="sparkle" size={15} /> <span className="blabel">Group by similarity</span>
        </button>
        <button className="btn iconbtn" onClick={() => setUi({ mapMinimap: NEXT_CORNER[mapMinimap] })}
          title="Move the minimap to the next corner">
          <Icon name="pip" size={15} />
        </button>
      </div>
      <div className="mapCanvas">
        {codes.length === 0
          ? <div className="empty">No codes yet — the map draws itself as you code.</div>
          : (
          <ReactFlow<MapNode>
            defaultNodes={initialNodes} nodeTypes={nodeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView={!remembered.viewport}
            defaultViewport={remembered.viewport ?? undefined}
            onMoveEnd={onMoveEnd}
            minZoom={0.1} maxZoom={3}
            selectionOnDrag panOnDrag={[1, 2]} selectionMode={SelectionMode.Partial}
            autoPanOnSelection={false}
            onSelectionStart={onSelectionStart} onSelectionEnd={onSelectionEnd}
            elevateNodesOnSelect={false}
            multiSelectionKeyCode={["Control", "Meta"]}
            onNodeDragStop={onNodeDragStop}
            zoomOnDoubleClick={false} deleteKeyCode={null} nodesConnectable={false}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}>
            <Controls showInteractive={false} />
            {/* the MiniMap re-scans the store on every write; unmounting it for
                the duration of a box-drag costs one render at gesture start/end
                instead of aggregate scans per membership change (codex consult) */}
            {!selecting && <MiniMap pannable zoomable position={mapMinimap} nodeColor={nodeColor} />}
            <RafSelectionMarquee />
            <SelectionHud />

          </ReactFlow>
        )}
      </div>
      {aiOpen && (
        <GroupModal onClose={() => setAiOpen(false)}
          onGroups={(groups) => {
            // a fresh grouping owns the whole layout again
            remembered.positions = {};
            setCodeGroups(groups);
          }} />
      )}
      {menu && menu.sel.length > 0 && (
        <div className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => { openInCodebook(menu.sel); setMenu(null); }}>
            Open {menu.sel.length === 1 ? menu.sel[0] : `${menu.sel.length} codes`} in Codebook
          </button>
          {menu.sel.length > 1 && (
            <button role="menuitem" onClick={() => groupSelection(menu.sel)}>
              Group {menu.sel.length} codes together
            </button>
          )}
          {menu.sel.length > 1 && <>
            <div className="mapMenuHead">Merge {menu.sel.length} into…</div>
            {menu.sel.map((c) => (
              <button key={c} role="menuitem" onClick={() => mergeSel(menu.sel, c)}>
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
