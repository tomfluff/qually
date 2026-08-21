// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Code map: the whole codebook as a spatial surface, in two explicit
// stages on one canvas. RECONCILE lays every pending merge-cluster out as a
// HALO — a capsule field hugging its packed member chips, captioned above
// with the proposed name of the merged code. Membership is containment:
// inside the halo is in the merge, outside is out, and a dropped chip KEEPS
// the spot you gave it (park a code beside a group until you decide). While
// you hold a chip, the halo it would join outlines in the accent. THEMES
// shows the islands (groups) and never any merge structure.
// Performance shape per the react-flow skill: uncontrolled flow, narrow
// per-component subscriptions, memo'd nodes, imperative marquee.
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
import { ReconcileModal } from "./ReconcileModal";
import { GroupModal } from "./GroupModal";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { type MergeCodeInput } from "../ai/dedupe";
import { announce } from "../announce";
import { mergeScopedClusters, estimateGlimpseTokens, glimpseCluster, type CodeAction, type ReconcilePlan } from "../ai/reconcile";

// chip geometry in WORLD units — the viewport transform scales the world.
// Chips fit their content: width is the measured name plus the count block
// (uniform padding would leave a field of dead air around short names), and
// everything scales with the sidebar text ramp so large accessible settings
// never clip. Rows are shelf-packed toward a near-square map.
const GX = 14, GY = 12, PAD = 18, ISLAND_GAP = 64, HALO_PAD = 26, HALO_GAP = 72;
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

type ChipData = { code: string; color: string; segs: number; pids: number; act?: CodeAction };
type ChipNodeT = Node<ChipData, "chip">;
type IslandData = { name: string; gi: number };
type IslandNodeT = Node<IslandData, "island">;
type HaloData = { name: string; renamed: boolean; ci: number; count: number; open: boolean };
type HaloNodeT = Node<HaloData, "halo">;
type CardData = { ci: number };
type CardNodeT = Node<CardData, "card">;
type NoteData = { ci: number; text: string | null }; // null = generating
type NoteNodeT = Node<NoteData, "note">;
type MapNode = ChipNodeT | IslandNodeT | HaloNodeT | CardNodeT | NoteNodeT;

// session view state that outlives the unmounting view; positions ride the
// store's undo history and the camera persists in ui (across reloads)
const remembered = {
  // the stage override: null = derived (Reconcile while anything is pending)
  stage: null as null | "reconcile" | "themes",
  selected: new Set<string>(),
  // which halos have their card unfolded / their note dismissed (session)
  openCards: new Set<number>(),
  hiddenNotes: new Set<number>(),
};

const ChipNode = memo(function ChipNode({ data, selected }: NodeProps<ChipNodeT>) {
  const fs = useStore((s) => s.ui.sidebarFontSize);
  return (
    <div className={"mapChip" + (selected ? " sel" : "")}
      style={{ "--chip-c": data.color } as React.CSSProperties}
      title={`${data.code} — ${data.segs} excerpt${data.segs === 1 ? "" : "s"} in ${data.pids} transcript${data.pids === 1 ? "" : "s"}`}>
      <span className="mapName">{data.code}</span>
      {data.act && data.act.action !== "merge" && (
        <span className={"mapActBadge " + data.act.action}
          title={`${data.act.action}: ${data.act.rationale}`}>
          {data.act.action === "rename" ? "✎" : "⊘"}
        </span>
      )}
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
// A halo: the capsule field that IS the merge proposal. Containment is
// membership; the caption above names the merged code and is the halo's drag
// handle and right-click target.
const toggleCard = (ci: number) => window.dispatchEvent(new CustomEvent("qually:togglecard", { detail: ci }));
const HaloNode = memo(function HaloNode({ data }: NodeProps<HaloNodeT>) {
  const zoom = useFlowStore(zoomSel);
  const fs = useStore((s) => s.ui.sidebarFontSize);
  const base = fs * 1.3;
  // the caption tracks the zoom (constant on-screen size while zooming out)
  // up to a generous ceiling — far out, the map must read as group names
  const fontSize = Math.min(base * 4.5, Math.max(base, base / zoom));
  // the title IS the merged code's name: double-click to rename (clearing it
  // falls back to the auto-picked survivor's name)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const rename = () => {
    const st = useStore.getState();
    const name = draft.trim();
    st.setCodeClusters(st.codeClusters.map((x, i) => i !== data.ci ? x
      : name && name !== x.survivor ? { ...x, newName: name } : (({ newName: _drop, ...rest }) => rest)(x)));
    setEditing(false);
  };
  return (
    <div className="mapHalo">
      <div className="mapIslandLabel mapHaloLabel" style={{ fontSize }}>
        {editing ? (
          <input className="mapIslandEdit nodrag" value={draft} autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
              if (e.key === "Escape") { e.stopPropagation(); setDraft(data.name); setEditing(false); }
            }} />
        ) : (
          <span className="mapIslandName" title="The merged code's name — double-click to rename"
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(data.name); setEditing(true); }}>{data.name}</span>
        )}
        {data.renamed && !editing && <span className="mapOrbitTag">new name</span>}
        <span className="mapHaloCount">{data.count}</span>
        <button className="mapHaloArrow nodrag" title={data.open ? "Fold the details" : "Reasoning and the verdict"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleCard(data.ci)}>{data.open ? "▾" : "▸"}</button>
      </div>
    </div>
  );
});

// The stem card: reasoning and the verdict, nothing else — the halo's chips
// already show membership and counts, so the card stays anticipatable. The
// name lives on the caption (double-click it to rename the merged concept).
const CardNode = memo(function CardNode({ data }: NodeProps<CardNodeT>) {
  const cluster = useStore((st) => st.codeClusters[data.ci]);
  if (!cluster) return null;
  const c = cluster;
  const st = () => useStore.getState();
  const skip = () => st().setCodeClusters(st().codeClusters.filter((_, i) => i !== data.ci));
  const canAccept = c.codes.length >= 2;
  return (
    <div className="mapCardNode nodrag nowheel">
      <div className="mapCardRat">{c.rationale}</div>
      <div className="mapCardActions">
        <button className="btn primary" disabled={!canAccept}
          onClick={() => st().applyCluster(data.ci)}
          title={canAccept ? `Merge ${c.codes.length} codes into ${c.newName ?? c.survivor} — one undo step` : "A merge needs at least 2 members"}>
          Accept merge
        </button>
        <button className="btn" onClick={skip} title="Discard this proposal (codes stay as they are)">Skip</button>
      </div>
    </div>
  );
});

// The note: the group's AI glimpse, tethered to its halo — readable at map
// level without opening anything. While generating, the note itself is the
// progress indicator.
const NoteNode = memo(function NoteNode({ data }: NodeProps<NoteNodeT>) {
  return (
    <div className="mapNote nodrag">
      <div className="mapNoteWho">AI glimpse
        {data.text !== null && (
          <button className="mapNoteX" title="Hide this note (the text stays on the group)"
            onClick={() => window.dispatchEvent(new CustomEvent("qually:hidenote", { detail: data.ci }))}>×</button>
        )}
      </div>
      {data.text === null
        ? <div className="mapNoteGen">Reading the codes and their excerpts…</div>
        : <div className="mapNoteText">{data.text}</div>}
    </div>
  );
});
const nodeTypes = { chip: ChipNode, island: IslandNode, halo: HaloNode, card: CardNode, note: NoteNode };

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
  const mapPositions = useStore((s) => s.mapPositions);
  const mapIslandPos = useStore((s) => s.mapIslandPos);
  const { setNodes: rfSetNodes, getNodes, getInternalNode } = useReactFlow();
  // menu state carries the selection it acts on, captured at open — the menu
  // needs no live subscription
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string[];
    island?: { gi: number; name: string }; halo?: { ci: number; name: string } } | null>(null);
  // the modal, optionally pre-scoped to one island (island context menu)
  const [aiOpen, setAiOpen] = useState<false | { scope: number | "all" }>(false);
  const [themeAiOpen, setThemeAiOpen] = useState(false);
  const [openCards, setOpenCards] = useState<Set<number>>(remembered.openCards);
  const [hiddenNotes, setHiddenNotes] = useState<Set<number>>(remembered.hiddenNotes);
  useEffect(() => { remembered.openCards = openCards; remembered.hiddenNotes = hiddenNotes; }, [openCards, hiddenNotes]);
  const [genCi, setGenCi] = useState<number | null>(null);
  const [confirmAi, setConfirmAi] = useState<{ ci: number; x: number; y: number } | null>(null);
  // card fold/unfold + note hide arrive from the node components as events
  useEffect(() => {
    const onToggle = (e: Event) => setOpenCards((old) => {
      const ci = (e as CustomEvent<number>).detail;
      const n = new Set(old); n.has(ci) ? n.delete(ci) : n.add(ci); return n;
    });
    const onHide = (e: Event) => setHiddenNotes((old) => new Set(old).add((e as CustomEvent<number>).detail));
    window.addEventListener("qually:togglecard", onToggle);
    window.addEventListener("qually:hidenote", onHide);
    return () => { window.removeEventListener("qually:togglecard", onToggle); window.removeEventListener("qually:hidenote", onHide); };
  }, []);
  // the pending revision plan is PROJECT data — it survives reloads and travels
  // in the file, so the review can continue in a later session
  const plan = useStore((st) => st.codePlan);
  const clusters = useStore((st) => st.codeClusters);
  // stage: Reconcile while ANYTHING is pending, Themes on an empty plan —
  // unless the researcher flipped the toggle this session
  const [stageOverride, setStageOverride] = useState(remembered.stage);
  useEffect(() => { remembered.stage = stageOverride; }, [stageOverride]);
  const stage: "reconcile" | "themes" =
    stageOverride ?? (clusters.length + plan.length > 0 ? "reconcile" : "themes");
  const setPlan = useCallback((updater: CodeAction[] | ((p: CodeAction[]) => CodeAction[])) => {
    const st = useStore.getState();
    st.setCodePlan(typeof updater === "function" ? updater(st.codePlan) : updater);
  }, []);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // biggest first: the codes doing the most work anchor the top of the map
  const codes = useMemo(() =>
    Object.keys(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  // Two stages, one canvas. Themes: islands (groups) as before. Reconcile:
  // constellations — each pending cluster is a circular parent node with the
  // survivor at the center and members on the orbit; codes in no cluster pack
  // as a flat field below. Parents precede children (RF sub-flow rule).
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
    const actOf = new Map(plan.map((a) => [a.code, a]));
    const chipNode = (c: string, position: { x: number; y: number }, parentId?: string): ChipNodeT => ({
      id: c,
      type: "chip" as const,
      position: mapPositions[c] ?? position,
      ...(parentId ? { parentId } : {}),
      width: widths.get(c)!, height: ch,
      selected: remembered.selected.has(c),
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0, act: actOf.get(c) },
    });

    if (stage === "reconcile") {
      const live = clusters
        .map((c, ci) => ({ ...c, ci, codes: c.codes.filter(inBook) }))
        .filter((c) => c.codes.length >= 2);
      const clustered = new Set(live.flatMap((c) => c.codes));
      const singles = codes.filter((c) => !clustered.has(c));

      const haloNodes: HaloNodeT[] = [];
      const chipNodes: ChipNodeT[] = [];
      const extraNodes: (CardNodeT | NoteNodeT)[] = [];
      // capsule blocks: square-ish packed members + halo padding
      const blocks = live.map((c) => {
        const totalW = c.codes.reduce((a, x) => a + widths.get(x)! + GX, 0);
        const packed = pack(c.codes, Math.max(widths.get(c.codes[0])! + GX, Math.sqrt(totalW * (ch + GY)) * 1.15));
        // reserve room for the unfolded card below and the note beside, so
        // neighbors never sit under them
        const cardH = openCards.has(c.ci) ? fs * 9 + 22 : 0;
        const noteW = (genCi === c.ci || c.desc) && !hiddenNotes.has(c.ci) ? Math.max(240, fs * 15) + 26 : 0;
        return { c, packed, w: packed.w + 2 * HALO_PAD, h: packed.h + 2 * HALO_PAD, cardH, noteW };
      });
      const rowW = Math.max(1000, Math.sqrt(blocks.reduce((a, b) => a + (b.w + b.noteW + HALO_GAP) * (b.h + b.cardH + HALO_GAP), 0)) * 1.5);
      let x = 0, y = 40, rowH = 0;
      for (const b of blocks) {
        if (x > 0 && x + b.w + b.noteW > rowW) { x = 0; y += rowH + HALO_GAP; rowH = 0; }
        const key = `halo:${b.c.ci}`;
        haloNodes.push({
          id: key, type: "halo" as const,
          position: mapIslandPos[key] ?? { x, y },
          width: b.w, height: b.h,
          draggable: true, selectable: false, focusable: false,
          dragHandle: ".mapHaloLabel",
          data: { name: b.c.newName ?? b.c.survivor, renamed: !!b.c.newName, ci: b.c.ci, count: b.c.codes.length, open: openCards.has(b.c.ci) },
        });
        for (const m of b.c.codes)
          chipNodes.push(chipNode(m, { x: HALO_PAD + b.packed.pos[m].x, y: HALO_PAD + b.packed.pos[m].y }, key));
        // the unfolded verdict card hangs below its halo on a stem
        if (openCards.has(b.c.ci)) {
          extraNodes.push({
            id: `card:${b.c.ci}`, type: "card" as const,
            position: { x: 12, y: b.h + 22 }, parentId: key,
            draggable: false, selectable: false, focusable: false,
            width: Math.max(280, Math.min(420, b.w - 24)),
            data: { ci: b.c.ci },
          });
        }
        // the AI glimpse rides beside the halo as a note (or its loading state)
        if ((genCi === b.c.ci || b.c.desc) && !hiddenNotes.has(b.c.ci)) {
          extraNodes.push({
            id: `note:${b.c.ci}`, type: "note" as const,
            position: { x: b.w + 26, y: 0 }, parentId: key,
            draggable: false, selectable: false, focusable: false,
            width: Math.max(240, fs * 15),
            data: { ci: b.c.ci, text: genCi === b.c.ci ? null : b.c.desc ?? "" },
          });
        }
        x += b.w + b.noteW + HALO_GAP;
        rowH = Math.max(rowH, b.h + b.cardH);
      }
      // the untouched field below the halos
      const flat = pack(singles, near(singles));
      const offY = blocks.length ? y + rowH + HALO_GAP : 0;
      for (const c of singles)
        chipNodes.push(chipNode(c, { x: flat.pos[c].x, y: offY + flat.pos[c].y }));
      return { nodes: [...haloNodes, ...chipNodes, ...extraNodes] as MapNode[] };
    }

    const groups = codeGroups
      .map((g, gi) => ({ ...g, gi, codes: g.codes.filter(inBook) }))
      .filter((g) => g.codes.length > 0);
    const grouped = new Set(groups.flatMap((g) => g.codes));
    const loose = codes.filter((c) => !grouped.has(c));

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
        position: mapIslandPos[key] ?? { x: ix, y: iy },
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
  }, [codes, codebook, stats, sidebarFontSize, codeGroups, plan, clusters, stage, mapPositions, mapIslandPos, openCards, hiddenNotes, genCi]);
  const build = useCallback(() => layout.nodes, [layout]);

  // built once per mount; RF owns the array from here (uncontrolled). When the
  // codebook changes under the map (a merge, a rename, new codes), rebuild —
  // dragged chips keep their place via remembered.positions.
  const [initialNodes] = useState(build);
  useEffect(() => { rfSetNodes(build()); }, [build, rfSetNodes]);

  // plan strip verdicts (renames and rejects only — merges are halos)
  const applyAction = (a: CodeAction) => {
    const st = useStore.getState();
    if (a.action === "rename") st.renameCode(a.code, a.newName!);
    else if (a.action === "remove") st.rejectCode(a.code);
    setPlan((ps) => ps.filter((x) => x !== a));
  };
  const skipAction = (a: CodeAction) => setPlan((ps) => ps.filter((x) => x !== a));

  // "describe this group": one-line confirm, default model, result lands on
  // the note node; the note's pulse IS the progress indicator
  const glimpseInputs = useCallback((ci: number): MergeCodeInput[] => {
    const st = useStore.getState();
    const member = new Set(st.codeClusters[ci]?.codes ?? []);
    const byCode = new Map<string, string[]>();
    for (const seg of st.segments) {
      if (seg.status !== "accepted" || !member.has(seg.code) || !st.transcripts[seg.pid]) continue;
      const arr = byCode.get(seg.code) ?? [];
      if (arr.length >= 4) continue;
      const ex = segExcerpt(seg, st.transcripts[seg.pid].lines).excerpt;
      if (ex) { arr.push(ex); byCode.set(seg.code, arr); }
    }
    return [...member].map((name) => ({
      name, def: st.codebook[name]?.def ?? "", excerpts: byCode.get(name) ?? [],
    }));
  }, []);
  const runGlimpse = useCallback(async (ci: number) => {
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const red = redactor(st.ai.redactTerms);
    const inputs = glimpseInputs(ci);
    setHiddenNotes((old) => { const n = new Set(old); n.delete(ci); return n; });
    setGenCi(ci);
    try {
      const { glimpse, usage } = await glimpseCluster({
        key, model: st.ai.model, codes: inputs, redaction: red,
      });
      const s2 = useStore.getState();
      s2.setCodeClusters(s2.codeClusters.map((c, i) => (i === ci ? { ...c, desc: glimpse } : c)));
      s2.logAiCall({
        at: new Date().toISOString(), model: st.ai.model, task: "glimpse", pid: "(codebook)",
        lines: inputs.length, redactions: 0,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      announce("Group description ready.");
    } catch (e) {
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      announce(`Describe failed: ${msg}`, { assertive: true });
    } finally {
      setGenCi(null);
    }
  }, [glimpseInputs]);

  const groupSelection = (sel: string[]) => {
    const cleaned = codeGroups.map((g) => ({ ...g, codes: g.codes.filter((c) => !sel.includes(c)) }));
    setCodeGroups([...cleaned, { name: `Group ${codeGroups.length + 1}`, codes: sel }]);
    setMenu(null);
  };
  // by-hand merge proposal: a new halo from the selection
  const clusterSelection = (sel: string[]) => {
    const st = useStore.getState();
    st.setCodeClusters([...st.codeClusters, { survivor: sel[0], codes: sel, rationale: "Grouped by hand on the map." }]);
    setMenu(null);
  };
  // the camera persists across tab switches AND reloads
  const [initialViewport] = useState(() => useStore.getState().ui.mapViewport);
  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => { setUi({ mapViewport: vp }); }, [setUi]);
  // While you hold a chip (Reconcile), the halo it would join outlines in the
  // accent — rAF-coalesced imperative class toggle, no React work per move.
  const dragFrame = useRef(0);
  const clearWill = () => document.querySelectorAll(".mapHalo.will").forEach((el) => el.classList.remove("will"));
  const haloAt = useCallback((cx: number, cy: number) =>
    getNodes().find((h) => h.type === "halo"
      && cx >= h.position.x && cx <= h.position.x + (h.width ?? 0)
      && cy >= h.position.y && cy <= h.position.y + (h.height ?? 0)) ?? null, [getNodes]);
  const onNodeDrag = useCallback((_: unknown, n: Node) => {
    if (stage !== "reconcile" || n.type !== "chip" || dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
      const hit = haloAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2);
      clearWill();
      if (hit) document.querySelector(`.react-flow__node[data-id="${hit.id}"] .mapHalo`)?.classList.add("will");
    });
  }, [stage, getInternalNode, haloAt]);

  // A drop is a filing action, and the chip KEEPS the spot you gave it.
  // Reconcile: inside a halo = in that merge (relative position), outside =
  // out (absolute position) — one undoable entry either way. Themes: same
  // shape against islands.
  const onNodeDragStop = useCallback((_: unknown, n: Node) => {
    const st = useStore.getState();
    if (n.type === "island" || n.type === "halo") { st.recordMapPosition(n.id, n.position, true); return; }
    const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
    if (stage === "reconcile") {
      clearWill();
      const hit = haloAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2);
      const targetCi = hit ? (hit.data as HaloData).ci : null;
      const pos = hit ? { x: abs.x - hit.position.x, y: abs.y - hit.position.y } : abs;
      st.reconcileDrop(n.id, pos, targetCi);
      return;
    }
    const islands = getNodes().filter((x) => x.type === "island");
    if (!islands.length) { st.recordMapPosition(n.id, n.position); return; }
    const cx = abs.x + (n.width ?? 0) / 2, cy = abs.y + (n.height ?? 0) / 2;
    const hitIsl = islands.find((r) => cx >= r.position.x && cx <= r.position.x + (r.width ?? 0)
      && cy >= r.position.y && cy <= r.position.y + (r.height ?? 0));
    const gi = hitIsl ? (hitIsl.data as IslandData).gi : -1;
    st.themesDrop(n.id, n.position, gi);
  }, [getNodes, getInternalNode, stage, haloAt]);
  const onNodeDoubleClick = useCallback((_: unknown, n: Node) => {
    if (n.type === "chip") openInCodebook([n.id]);
    if (n.type === "halo") toggleCard((n.data as HaloData).ci);
  }, []);
  const selectionAt = useCallback((): string[] =>
    getNodes().filter((n) => n.selected && n.type === "chip").map((n) => n.id), [getNodes]);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: Node) => {
    e.preventDefault();
    if (n.type === "island") {
      const d = n.data as IslandData;
      setMenu({ x: e.clientX, y: e.clientY, sel: [], island: { gi: d.gi, name: d.name } });
      return;
    }
    if (n.type === "halo") {
      const d = n.data as HaloData;
      setMenu({ x: e.clientX, y: e.clientY, sel: [], halo: { ci: d.ci, name: d.name } });
      return;
    }
    let sel = selectionAt();
    if (!sel.includes(n.id)) {
      sel = [n.id];
      rfSetNodes((ns) => ns.map((x) => ({ ...x, selected: x.type === "chip" && x.id === n.id })));
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
    if (!menu && !confirmAi) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest(".mapMenu")) { setMenu(null); setConfirmAi(null); } };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(null); setConfirmAi(null); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [menu, confirmAi]);

  return (
    <div id="codemap" className={"stage-" + stage} style={{ fontSize: sidebarFontSize }}>
      <div className="mapBar">
        <span className="mapTitle">Code map</span>
        <span className="mapHint">The whole codebook at once. Drag to select, <b>Space+drag</b> (or middle/right-drag) to pan, wheel to zoom. Right-click a selection to act on it; double-click a code for its excerpts.</span>
        <span className="mapCount">{codes.length} code{codes.length === 1 ? "" : "s"}</span>
        <div className="segmented mapStage" role="radiogroup" aria-label="Map stage">
          <button className={"seg" + (stage === "reconcile" ? " on" : "")} role="radio"
            aria-checked={stage === "reconcile"} onClick={() => setStageOverride("reconcile")}
            title="Clean the codebook: merge constellations, renames, rejects">Reconcile</button>
          <button className={"seg" + (stage === "themes" ? " on" : "")} role="radio"
            aria-checked={stage === "themes"} onClick={() => setStageOverride("themes")}
            title="Group the cleaned codebook into theme islands">Themes</button>
        </div>
        {stage === "reconcile" ? (
          <button className="btn iconlabel" onClick={() => setAiOpen({ scope: "all" })}
            title="AI proposes merge groups and per-code revisions for your review">
            <Icon name="sparkle" size={15} /> <span className="blabel">Reconcile with AI</span>
          </button>
        ) : (
          <button className="btn iconlabel" onClick={() => setThemeAiOpen(true)}
            title="AI groups the cleaned codebook into theme islands for you to reshape">
            <Icon name="sparkle" size={15} /> <span className="blabel">Group into themes with AI</span>
          </button>
        )}
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
            fitView={!initialViewport}
            defaultViewport={initialViewport ?? undefined}
            onMoveEnd={onMoveEnd}
            minZoom={0.1} maxZoom={3}
            selectionOnDrag panOnDrag={[1, 2]} selectionMode={SelectionMode.Partial}
            autoPanOnSelection={false}
            onSelectionStart={onSelectionStart} onSelectionEnd={onSelectionEnd}
            elevateNodesOnSelect={false}
            multiSelectionKeyCode={["Control", "Meta"]}
            onNodeDragStop={onNodeDragStop} onNodeDrag={onNodeDrag}
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
            {stage === "reconcile" && plan.length > 0 && (
              <Panel position="top-left" className="mapPlan">
                <div className="mapPlanHead">
                  <b>Revision plan</b> <span className="mapPlanCount">{plan.length}</span>
                  <span className="mapPlanKey">✎ rename · ⊘ reject · merge groups show as halos</span>
                  <button className="btn" onClick={() => { [...plan].forEach(applyAction); }}>Accept all</button>
                  <button className="btn" onClick={() => setPlan([])} title="Discard every remaining proposal">Clear</button>
                </div>
                <div className="mapPlanList nicescroll">
                  {plan.map((a, i) => (
                    <div key={`${a.code}:${i}`} className="mapPlanRow" title={a.rationale}>
                      <span className={"mapPlanKind " + a.action}>{a.action === "rename" ? "✎" : "⊘"}</span>
                      <span className="mapPlanText">
                        {a.action === "rename" ? <><b>{a.code}</b> → {a.newName}</>
                          : <>reject <b>{a.code}</b>'s excerpts</>}
                      </span>
                      <button className="btn ok" onClick={() => applyAction(a)} title={"Apply — " + a.rationale}>✓</button>
                      <button className="btn" onClick={() => skipAction(a)} title="Skip this proposal">✗</button>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

          </ReactFlow>
        )}
      </div>
      {themeAiOpen && (
        <GroupModal
          onClose={() => setThemeAiOpen(false)}
          onReconcileInstead={() => { setThemeAiOpen(false); setStageOverride("reconcile"); }}
          onGroups={(groups) => { useStore.getState().applyThemeGroups(groups); }} />
      )}
      {aiOpen && (
        <ReconcileModal groups={codeGroups} initialScope={aiOpen.scope} onClose={() => setAiOpen(false)}
          onPlan={(p: ReconcilePlan, scope) => {
            const st = useStore.getState();
            if (scope === "all") {
              st.applyReconcilePlan(p.clusters, p.actions, true);
            } else {
              // island-scoped refinement merges into the pending state: pending
              // clusters intersecting the subset are replaced (doc rule)
              const subset = new Set(codeGroups[scope]?.codes ?? []);
              st.applyReconcilePlan(
                mergeScopedClusters(st.codeClusters, subset, p.clusters),
                [...st.codePlan.filter((a) => !subset.has(a.code)), ...p.actions],
                false);
            }
          }} />
      )}
      {confirmAi && (() => {
        const st = useStore.getState();
        const red = redactor(st.ai.redactTerms);
        const inputs = glimpseInputs(confirmAi.ci);
        const inTok = estimateGlimpseTokens(inputs, red);
        const model = modelOf(st.ai.model);
        const cost = costOf(model, inTok, estimateTokens(" ".repeat(80)));
        return (
          <div className="ctxmenu mapMenu mapAiConfirm" role="alertdialog" aria-label="Confirm AI request"
            style={{ left: confirmAi.x, top: confirmAi.y, fontSize: sidebarFontSize }}>
            <div className="mapAiConfirmText">
              Describe with AI — sends <b>{inputs.length} codes · ≈{inTok.toLocaleString()} tokens
              · ≈${cost.toFixed(4)}</b> to OpenAI ({model.id}).
            </div>
            <div className="mapCardActions">
              <button className="btn primary" autoFocus
                onClick={() => { const ci = confirmAi.ci; setConfirmAi(null); void runGlimpse(ci); }}>Send</button>
              <button className="btn" onClick={() => setConfirmAi(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {menu && menu.halo && (
        <div className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => {
            const list = clusters[menu.halo!.ci]?.codes.filter((c) => c in codebook) ?? [];
            openInCodebook(list); setMenu(null);
          }}>
            Open these codes in Codebook
          </button>
          <button role="menuitem" onClick={() => { setConfirmAi({ ci: menu.halo!.ci, x: menu.x, y: menu.y }); setMenu(null); }}>
            AI: describe this group…
          </button>
          {clusters[menu.halo.ci]?.desc && hiddenNotes.has(menu.halo.ci) && (
            <button role="menuitem" onClick={() => {
              setHiddenNotes((old) => { const n = new Set(old); n.delete(menu.halo!.ci); return n; });
              setMenu(null);
            }}>
              Show the description note
            </button>
          )}
        </div>
      )}
      {menu && menu.island && (
        <div className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => {
            const list = menu.island!.gi === -1
              ? codes.filter((c) => !codeGroups.some((g) => g.codes.includes(c)))
              : codeGroups[menu.island!.gi]?.codes.filter((c) => c in codebook) ?? [];
            openInCodebook(list); setMenu(null);
          }}>
            Open all grouped codes in Codebook
          </button>
          {menu.island.gi !== -1 && (
            <button role="menuitem" onClick={() => { setAiOpen({ scope: menu.island!.gi }); setMenu(null); }}>
              Reconcile “{menu.island.name}”…
            </button>
          )}
        </div>
      )}
      {menu && !menu.island && !menu.halo && menu.sel.length > 0 && (
        <div className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => { openInCodebook(menu.sel); setMenu(null); }}>
            Open {menu.sel.length === 1 ? menu.sel[0] : `${menu.sel.length} codes`} in Codebook
          </button>
          {menu.sel.length > 1 && stage === "reconcile" && (
            <button role="menuitem" onClick={() => clusterSelection(menu.sel)}>
              Propose merging these {menu.sel.length} codes
            </button>
          )}
          {menu.sel.length > 1 && stage === "themes" && (
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
