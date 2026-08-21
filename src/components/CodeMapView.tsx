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
  ViewportPortal, useReactFlow, useStore as useFlowStore, useStoreApi as useFlowStoreApi,
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

// positions (drags survive), viewport and selection outlive the unmounting view
const remembered = {
  positions: {} as Record<string, { x: number; y: number }>,
  islandOffsets: {} as Record<string, { dx: number; dy: number }>,
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
const nodeTypes = { chip: ChipNode };

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
  s.nodes.filter((n) => n.selected).map((n) => n.id).join("\n");
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

// an island's caption: sits above the frame like a map label. Semantic zoom —
// the world font counter-scales so the caption holds a readable on-screen size
// while zoomed out (the abstraction level: far away you read GROUPS), clamped
// at its base so zooming in grows it naturally. Base rides ABOVE the code text
// size on purpose: titles outrank chips. Drag the caption to move the island;
// double-click renames (a real group only); x dissolves.
const zoomSel = (s: { transform: [number, number, number] }) => s.transform[2];
function IslandLabel({ name, gi, onRename, onDissolve, onDragStart }: {
  name: string; gi: number;
  onRename: (gi: number, name: string) => void; onDissolve: (gi: number) => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const zoom = useFlowStore(zoomSel);
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const base = fs * 1.3;
  const fontSize = Math.min(base * 7, Math.max(base, base / zoom));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (gi === -1) {
    return (
      <div className="mapIslandLabel" style={{ fontSize }} onPointerDown={onDragStart}>
        <span className="mapIslandName loose">{name}</span>
      </div>
    );
  }
  return (
    <div className="mapIslandLabel" style={{ fontSize }} onPointerDown={onDragStart}>
      {editing ? (
        <input className="mapIslandEdit" value={draft} autoFocus
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(gi, draft); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(gi, draft); setEditing(false); }
            if (e.key === "Escape") { e.stopPropagation(); setDraft(name); setEditing(false); }
          }} />
      ) : (
        <span className="mapIslandName" title="Double-click to rename"
          onDoubleClick={() => { setDraft(name); setEditing(true); }}>{name}</span>
      )}
      <button className="mapIslandX" title="Dissolve this group (codes stay)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onDissolve(gi)}>×</button>
    </div>
  );
}

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
  const { setNodes: rfSetNodes, getNodes } = useReactFlow();
  // menu state carries the selection it acts on, captured at open — the menu
  // needs no live subscription
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string[] } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [islandRev, setIslandRev] = useState(0);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // biggest first: the codes doing the most work anchor the top of the map
  const codes = useMemo(() =>
    Object.keys(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  // Islands: each group packs its chips into a compact block; the blocks (plus
  // an Ungrouped block) shelf-pack across the canvas. No groups -> one flat map.
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

    const positions: Record<string, { x: number; y: number }> = {};
    const regions: { name: string; gi: number; x: number; y: number; w: number; h: number }[] = [];
    if (groups.length === 0) {
      const flat = pack(codes, near(codes));
      Object.assign(positions, flat.pos);
    } else {
      // island blocks (Ungrouped last, gi -1), shelf-packed with margins
      const blocks = [...groups.map((g) => ({ name: g.name, gi: g.gi, list: g.codes })),
        ...(loose.length ? [{ name: "Ungrouped", gi: -1, list: loose }] : [])]
        .map((b) => ({ ...b, ...pack(b.list, near(b.list)) }));
      const totalW = blocks.reduce((a, b) => a + b.w + 2 * PAD + ISLAND_GAP, 0);
      const rowW = Math.max(900, Math.sqrt(totalW * (blocks[0] ? blocks[0].h + 160 : 1)) * 1.6, ...blocks.map((b) => b.w + 2 * PAD));
      let ix = 0, iy = 0, rowH = 0;
      for (const b of blocks) {
        const off = remembered.islandOffsets[b.gi === -1 ? "\u0000loose" : b.name] ?? { dx: 0, dy: 0 };
        const bw = b.w + 2 * PAD, bh = b.h + 2 * PAD;
        if (ix > 0 && ix + bw > rowW) { ix = 0; iy += rowH + ISLAND_GAP; rowH = 0; }
        regions.push({ name: b.name, gi: b.gi, x: ix + off.dx, y: iy + off.dy, w: bw, h: bh });
        for (const c of b.list) positions[c] = { x: ix + off.dx + PAD + b.pos[c].x, y: iy + off.dy + PAD + b.pos[c].y };
        ix += bw + ISLAND_GAP;
        rowH = Math.max(rowH, bh);
      }
    }
    const nodes: ChipNodeT[] = codes.map((c) => ({
      id: c,
      type: "chip" as const,
      position: remembered.positions[c] ?? positions[c],
      width: widths.get(c)!, height: ch,
      selected: remembered.selected.has(c),
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0 },
    }));
    return { nodes, regions };
  // islandRev bumps when an island is dragged (offsets live outside React)
  }, [codes, codebook, stats, sidebarFontSize, codeGroups, islandRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const build = useCallback(() => layout.nodes, [layout]);

  // built once per mount; RF owns the array from here (uncontrolled). When the
  // codebook changes under the map (a merge, a rename, new codes), rebuild —
  // dragged chips keep their place via remembered.positions.
  const [initialNodes] = useState(build);
  useEffect(() => { rfSetNodes(build()); }, [build, rfSetNodes]);

  // group editing: every mutation goes through the store so it lands in the file
  const moveToGroup = useCallback((code: string, gi: number) => {
    const cur = codeGroups.findIndex((g) => g.codes.includes(code));
    if (cur === gi) return;
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
  // drag an island by its caption: the frame outline follows the pointer
  // imperatively (no React work per move); release commits the offset, shifts
  // any hand-placed member chips with it, and relayouts
  const dragIsland = useCallback((e: React.PointerEvent, r: { name: string; gi: number }) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest(".mapIsland") as HTMLElement;
    const zoom = remembered.viewport?.zoom ?? 1;
    const sx = e.clientX, sy = e.clientY;
    let ddx = 0, ddy = 0;
    const base = el.style.transform;
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      ddx = (ev.clientX - sx) / zoom; ddy = (ev.clientY - sy) / zoom;
      el.style.transform = `${base} translate(${ddx}px, ${ddy}px)`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.classList.remove("dragging");
      if (!ddx && !ddy) return;
      const key = r.gi === -1 ? "\u0000loose" : r.name;
      const off = remembered.islandOffsets[key] ?? { dx: 0, dy: 0 };
      remembered.islandOffsets[key] = { dx: off.dx + ddx, dy: off.dy + ddy };
      const members = r.gi === -1
        ? codes.filter((c) => !codeGroups.some((g) => g.codes.includes(c)))
        : codeGroups[r.gi]?.codes ?? [];
      for (const c of members) {
        const p = remembered.positions[c];
        if (p) remembered.positions[c] = { x: p.x + ddx, y: p.y + ddy };
      }
      setIslandRev((v) => v + 1);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [codes, codeGroups]);

  const renameGroup = useCallback((gi: number, name: string) => {
    if (!name.trim()) return;
    setCodeGroups(codeGroups.map((g, i) => (i === gi ? { ...g, name: name.trim() } : g)));
  }, [codeGroups, setCodeGroups]);
  const dissolveGroup = useCallback((gi: number) => {
    codeGroups[gi]?.codes.forEach((c) => delete remembered.positions[c]);
    setCodeGroups(codeGroups.filter((_, i) => i !== gi));
  }, [codeGroups, setCodeGroups]);

  // stable handlers (skill rule: memoize callback props)
  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => { remembered.viewport = vp; }, []);
  const onMove = useCallback((_: unknown, vp: Viewport) => { remembered.viewport = vp; }, []);
  // a drag is a filing action once islands exist: the chip joins whichever
  // island its center lands in (or leaves its group on open canvas)
  const onNodeDragStop = useCallback((_: unknown, n: Node) => {
    remembered.positions[n.id] = n.position;
    if (!layout.regions.length) return;
    const cx = n.position.x + (n.width ?? 0) / 2, cy = n.position.y + (n.height ?? 0) / 2;
    const hit = layout.regions.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
    moveToGroup(n.id, hit ? hit.gi : -1);
  }, [layout, moveToGroup]);
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
  const nodeColor = useCallback((n: Node) => (n as ChipNodeT).data.color, []);

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
          <ReactFlow<ChipNodeT>
            defaultNodes={initialNodes} nodeTypes={nodeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView={!remembered.viewport}
            defaultViewport={remembered.viewport ?? undefined}
            onMoveEnd={onMoveEnd} onMove={onMove}
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
            {/* island regions live in WORLD coordinates behind the chips */}
            <ViewportPortal>
              {layout.regions.map((r) => (
                <div key={`${r.gi}:${r.name}`}
                  className={"mapIsland" + (r.gi === -1 ? " loose" : "")}
                  style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, height: r.h }}>
                  <IslandLabel name={r.name} gi={r.gi}
                    onRename={renameGroup} onDissolve={dissolveGroup}
                    onDragStart={(e) => dragIsland(e, r)} />
                </div>
              ))}
            </ViewportPortal>
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
