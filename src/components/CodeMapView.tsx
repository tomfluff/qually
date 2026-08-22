// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Code map: the whole codebook as a spatial surface, in ONE view at a
// time. A view says what containers you see and what a drag means in them —
// there is no second selector, because there never were two independent
// dimensions here (see VIEWS below).
//
// The rule that makes a drag anticipatable across all of them:
//
//   Position and membership are mutually exclusive carriers of meaning.
//   INSIDE a container a code's coordinates mean nothing — it is a set — so
//   the view packs them. OUTSIDE, coordinates are the only thing carrying the
//   researcher's intent, so nothing touches them.
//
// From that: dropping a code into a container appends it (nothing already
// inside moves); dropping it on open canvas takes it out and leaves it exactly
// where you let go; dropping it on the catch-all pile takes it out AND forgets
// its spot, so the packer tidies it in with the other unfiled codes.
// Performance shape per the react-flow skill: uncontrolled flow, narrow
// per-component subscriptions, memo'd nodes, imperative marquee.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, MiniMap, Controls, Panel, SelectionMode,
  useReactFlow, useStore as useFlowStore, useStoreApi as useFlowStoreApi,
  type Node, type NodeProps, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore, bestSurvivor, type MapStage } from "../state/store";
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
import { onProjectSwap } from "../sessionReset";
import { relaxBoxes } from "../mapRelax";
import { earcon } from "../earcons";
import { norm } from "../contract/segments";
import { findSimilar } from "../similar";
import { findSimilarWithAi, estimateSimilarTokens } from "../ai/similar";
import { mergeScopedClusters, dropAction, estimateGlimpseTokens, glimpseCluster, reconcileFocus, mergeFocusResults, estimateFocusTokens, haloIdsFor, type CodeAction, type ReconcilePlan } from "../ai/reconcile";

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

// Captions (island and halo) float ABOVE their block and counter-scale against
// the viewport, so zoomed out they are the widest thing on the map while the
// blocks they name stay small — pack without reserving their room and the
// names collide. Both dimensions are in WORLD units at a given zoom: the
// caption's on-screen size is meant to hold steady, so its world size grows as
// the zoom shrinks (capped, mirroring IslandNode/HaloNode).
const captionFs = (fs: number, zoom: number, cap: number) => {
  const base = fs * 1.3;
  return Math.min(base * cap, Math.max(base, base / zoom));
};
const captionBox = (fs: number, zoom: number, cap: number, text: string, extraEm: number, family?: string) => {
  const size = captionFs(fs, zoom, cap);
  // the family read forces a style recalc — the layout memo hoists it and
  // passes it in rather than paying that per block
  measurer.font = `800 ${size}px ${family ?? getComputedStyle(document.body).fontFamily}`;
  // extraEm covers the caption's trailing furniture (tag, count, buttons)
  return { w: Math.round(measurer.measureText(text).width + size * extraEm), h: Math.round(size * 1.5) };
};

type ChipData = { code: string; color: string; segs: number; pids: number; act?: CodeAction };
type ChipNodeT = Node<ChipData, "chip">;
// lens islands are synthetic (gi indexes the LENS grouping, not codeGroups),
// so they carry their member list — the context menu must never reach into
// saved theme groups through a lens island's gi
type IslandData = { name: string; gi: number; pile?: boolean; list?: string[];
  // areas view only: which stored area this pile is (-1 = Unassigned)
  ai?: number;
  // lens islands only: the grouping's own name, without the count suffix —
  // the stable key session positions hang off (gi is just row order)
  gkey?: string };
type IslandNodeT = Node<IslandData, "island">;
type HaloData = { name: string; renamed: boolean; joins: boolean; ci: number; count: number; open: boolean };
type HaloNodeT = Node<HaloData, "halo">;
type CardData = { ci: number; gen: boolean }; // gen: a glimpse is being written
type CardNodeT = Node<CardData, "card">;
// the "find similar" results: a node tethered to the code you asked about, so
// it pans and zooms with the map instead of floating over it
type SimilarRow = { name: string; score: number; why: string; band?: "very" | "related" };
type SimilarData = {
  source: string; rows: SimilarRow[]; ticked: Set<string>;
  ai: "idle" | "busy" | "done"; cost?: number; inTok: number; costEst: number;
};
type SimilarNodeT = Node<SimilarData, "similar">;
type MapNode = ChipNodeT | IslandNodeT | HaloNodeT | CardNodeT | SimilarNodeT;

// THE VIEWS. One value, five entries — not a stage crossed with a lens. The
// old pair could express eight situations for a product that has five, and
// every feature had to answer "is this a stage thing or a lens thing?" with
// "neither, it depends". Each view declares what a drag means in it and which
// layout slot it owns; `layout: null` marks a DERIVED view whose piles come
// from counts, where there is no membership to edit and so nothing moves at
// all — better an absent gesture than one that silently does nothing.
export type MapView = "reconcile" | "themes" | "areas" | "pids" | "segs";
type ViewSpec = {
  label: string;
  group: "work" | "explore";
  /** said out loud beside the view name, and announced on every switch */
  drag: string;
  /** the layout slot this view owns, or null when nothing here can move */
  layout: MapStage | null;
};
const VIEWS: Record<MapView, ViewSpec> = {
  reconcile: {
    label: "Reconcile", group: "work", layout: "reconcile",
    drag: "Dragging a code in or out of a capsule changes what gets merged",
  },
  themes: {
    label: "Themes", group: "work", layout: "themes",
    drag: "Dragging a code between islands changes its theme",
  },
  areas: {
    label: "AI areas", group: "explore", layout: "areas",
    drag: "Dragging a code files it into an area",
  },
  pids: {
    label: "Transcript buckets", group: "explore", layout: null,
    drag: "Looking only — nothing here moves and nothing changes",
  },
  segs: {
    label: "Excerpt buckets", group: "explore", layout: null,
    drag: "Looking only — nothing here moves and nothing changes",
  },
};
const VIEW_ORDER: MapView[] = ["reconcile", "themes", "areas", "pids", "segs"];

// session view state that outlives the unmounting view; positions ride the
// store's undo history and the camera persists in ui (across reloads)
const remembered = {
  // the view override: null = derived (Reconcile while anything is pending).
  // NULLABLE on purpose — an eager value stops the default following the work.
  view: null as MapView | null,
  selected: new Set<string>(),
  // which halos have their card unfolded (session)
  openCards: new Set<number>(),
  // where the researcher parked the Revision plan panel (screen offset)
  planPos: { x: 0, y: 0 },
  planMin: false,
};

// A project swap makes every one of these meaningless — they are keyed by
// code and group NAMES, which the next project reuses with different
// meanings. The map is remounted by then, so the reset only has to clear the
// module state the next mount reads.
onProjectSwap(function forgetMapSession() {
  remembered.view = null; // stays NULL, so the next project derives its own
  remembered.selected = new Set();
  remembered.openCards = new Set();
  remembered.planPos = { x: 0, y: 0 };
  remembered.planMin = false;
});

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
function SelectionHud({ canEvict, onSelectionChanged }: { canEvict: boolean; onSelectionChanged: () => void }) {
  const joined = useFlowStore(selectedIdsSel);
  const sel = useMemo(() => (joined ? joined.split("\n") : []), [joined]);
  useEffect(() => { remembered.selected = new Set(sel); }, [sel]);
  // the one place that already re-renders exactly when chip selection changes
  useEffect(() => { onSelectionChanged(); }, [joined, onSelectionChanged]);
  const clusters = useStore((st) => st.codeClusters);
  const { getNodes } = useReactFlow();
  // the keyboard path for eviction: dragging out is pointer-only, this is not.
  // Only offered in the Reconcile view — capsules are not drawn anywhere else,
  // so eviction would have no visible effect.
  const inMerge = sel.filter((c) => clusters.some((x) => x.codes.includes(c)));
  const evictSelected = () => {
    const st = useStore.getState();
    for (const code of inMerge) {
      const ci = st.codeClusters.findIndex((x) => x.codes.includes(code));
      if (ci < 0) continue;
      const halo = getNodes().find((x) => x.id === `halo:${ci}`);
      const pos = halo ? { x: halo.position.x + (halo.width ?? 0) + 28, y: halo.position.y } : { x: 0, y: 0 };
      st.reconcileDrop(code, pos, null);
    }
    if (inMerge.length) {
      earcon.evict();
      announce(`Removed ${inMerge.length} code${inMerge.length === 1 ? "" : "s"} from their merge groups`);
    }
  };
  return (
    <Panel position="top-right" className="mapSelPanel"
      style={{ visibility: sel.length > 0 ? "visible" : "hidden" }}>
      <span className="mapSelCount">{sel.length} selected</span>
      {inMerge.length > 0 && canEvict && (
        <button className="btn" onClick={evictSelected}
          title="Move the selected codes out of their merge groups (they park beside them)">
          Remove from merge
        </button>
      )}
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
  // rename affordances close back to a focused span — on a canvas of hundreds
  // of tabbable chips, losing focus to <body> is losing your place
  const spanRef = useRef<HTMLSpanElement>(null);
  // keyboard closers land back on the span (a canvas of hundreds of tabbable
  // chips is a bad place to lose your spot); a BLUR must not — the click that
  // caused it is going somewhere else on purpose
  const refocus = () => requestAnimationFrame(() => spanRef.current?.focus());
  const rename = () => {
    setEditing(false);
    const st = useStore.getState();
    const name = draft.trim();
    if (!name || st.codeGroups[data.gi]?.name === name) return; // no change, no history entry
    st.setCodeGroups(st.codeGroups.map((g, i) => (i === data.gi ? { ...g, name } : g)));
  };
  const dissolve = () => {
    const st = useStore.getState();
    st.setCodeGroups(st.codeGroups.filter((_, i) => i !== data.gi));
  };
  return (
    <div className={"mapIsland" + (data.gi === -1 ? " loose" : "")}>
      <div className="mapIslandLabel" style={{ fontSize }}>
        {data.pile || data.gi === -1 ? (
          <span className={"mapIslandName" + (data.gi === -1 ? " loose" : "")}>{data.name}</span>
        ) : editing ? (
          <input className="mapIslandEdit nodrag" value={draft} autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") { rename(); refocus(); }
              if (e.key === "Escape") { e.stopPropagation(); setDraft(data.name); setEditing(false); refocus(); }
            }} />
        ) : (
          <>
            <span className="mapIslandName" title="Drag to move the group; double-click or Enter to rename"
              tabIndex={0} role="button" ref={spanRef} aria-label={`Rename ${data.name}`}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "F2" || e.key === " ") { e.preventDefault(); setDraft(data.name); setEditing(true); } }}
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
  const spanRef = useRef<HTMLSpanElement>(null);
  const refocus = () => requestAnimationFrame(() => spanRef.current?.focus());
  const rename = () => {
    setEditing(false);
    const st = useStore.getState();
    const cur = st.codeClusters[data.ci];
    if (!cur) return;
    const name = draft.trim();
    const next = name && name !== cur.survivor ? name : undefined;
    if (next === cur.newName) return; // no change, no history entry
    st.setCodeClusters(st.codeClusters.map((x, i) => i !== data.ci ? x
      : next ? { ...x, newName: next } : (({ newName: _drop, ...rest }) => rest)(x)));
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
              if (e.key === "Enter") { rename(); refocus(); }
              if (e.key === "Escape") { e.stopPropagation(); setDraft(data.name); setEditing(false); refocus(); }
            }} />
        ) : (
          // NO `nodrag` here: the caption is the halo's documented drag handle,
          // and the name is most of the caption — RF's own drag threshold
          // separates a click from a drag
          <span className="mapIslandName" title="The merged code's name — double-click or Enter to rename"
            tabIndex={0} role="button" ref={spanRef} aria-label={`Rename ${data.name}`}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "F2" || e.key === " ") { e.preventDefault(); setDraft(data.name); setEditing(true); } }}
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(data.name); setEditing(true); }}>{data.name}</span>
        )}
        {data.renamed && !editing && <span className="mapOrbitTag">{data.joins ? "joins existing" : "new name"}</span>}
        <span className="mapHaloCount">{data.count}</span>
        <button className="mapHaloArrow nodrag" title={data.open ? "Fold the details" : "Reasoning and the verdict"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleCard(data.ci)}>{data.open ? "▾" : "▸"}</button>
      </div>
    </div>
  );
});

// The stem card: reasoning, the AI glimpse (when asked for), and the verdict
// — one foldable place for everything ABOUT the group; the halo's chips
// already show membership and counts. The name lives on the caption
// (double-click it to rename the merged concept).
const CardNode = memo(function CardNode({ data }: NodeProps<CardNodeT>) {
  const cluster = useStore((st) => st.codeClusters[data.ci]);
  if (!cluster) return null;
  const c = cluster;
  const st = () => useStore.getState();
  const skip = () => { st().setCodeClusters(st().codeClusters.filter((_, i) => i !== data.ci)); earcon.skip(); };
  const canAccept = c.codes.length >= 2;
  // the glimpse described a membership; if the group changed since, say so
  // rather than silently presenting an outdated description
  const stale = !!c.desc && !!c.descCodes &&
    [...c.codes].sort().join("\n") !== [...c.descCodes].sort().join("\n");
  return (
    <div className="mapCardNode nodrag nowheel">
      <div className="mapCardRat">{c.rationale}</div>
      {(data.gen || c.desc) && (
        <div className="mapCardGlimpse">
          <span className="mapNoteWho">AI glimpse{stale && <span className="mapGlimpseStale" title="The group's members changed after this was written — re-run “AI: describe this group” for a fresh one">may be outdated</span>}</span>
          {data.gen
            ? <div className="mapNoteGen">Reading the codes and their excerpts…</div>
            : <div>{c.desc}</div>}
        </div>
      )}
      <div className="mapCardActions">
        <button className="btn primary" disabled={!canAccept}
          onClick={() => { st().applyCluster(data.ci); earcon.accept(); }}
          title={canAccept ? `Merge ${c.codes.length} codes into ${c.newName ?? c.survivor} — one undo step` : "A merge needs at least 2 members"}>
          Accept merge
        </button>
        <button className="btn" onClick={skip} title="Discard this proposal (codes stay as they are)">Skip</button>
      </div>
    </div>
  );
});

// The similar-results node: same tethered-to-its-subject rule as the card.
// It talks to the view through events, so the node stays memo-cheap and the
// state lives in one place.
const simEvent = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(`qually:sim${name}`, { detail }));
const SimilarNode = memo(function SimilarNode({ data }: NodeProps<SimilarNodeT>) {
  // It rides the canvas (tethered to its code) but it is a PANEL: at 10% zoom
  // a world-sized panel is 33px wide and unreadable, so it counter-scales the
  // way the captions do and holds a steady on-screen size.
  const zoom = useFlowStore(zoomSel);
  const scale = Math.min(10, Math.max(1, 1 / zoom));
  const codebook = useStore((s) => s.codebook);
  const groups = useStore((s) => s.codeGroups);
  const clusters = useStore((s) => s.codeClusters);
  const homeOf = (code: string) => {
    const cl = clusters.find((c) => c.codes.includes(code));
    if (cl) return `merge: ${cl.newName ?? cl.survivor}`;
    return groups.find((g) => g.codes.includes(code))?.name ?? null;
  };
  const n = data.ticked.size;
  return (
    <div className="mapSimNode nodrag nowheel"
      style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
      <div className="mapSimHead">
        <b>Similar to “{data.source}”</b>
        <button className="mapNoteX" aria-label="Close" onClick={() => simEvent("close")}>×</button>
        <span>{data.rows.length} of {Object.keys(codebook).length - 1} codes · {n} ticked</span>
      </div>
      {data.rows.length === 0 && (
        <div className="mapSimEmpty">
          {data.ai === "done"
            ? "No relatives found. This code is doing its own work."
            : "Nothing here shares wording with this code. A semantic look may still find relatives."}
        </div>
      )}
      <div className="mapSimList nicescroll">
        {data.rows.map((m) => {
          const home = homeOf(m.name);
          return (
            <label key={m.name} className="mapSimRow">
              <input type="checkbox" checked={data.ticked.has(m.name)}
                onChange={() => simEvent("toggle", m.name)} />
              <span className="mapSimName">
                <b>{m.name}</b>
                {home && (
                  <span className="mapSimHome"
                    title={home.startsWith("merge: ")
                      ? `Already in the merge proposal “${home.slice(7)}” — taking it here removes it from that one`
                      : `Already in the theme island “${home}” — a merge leaves that alone, grouping moves it here`}>
                    {home.startsWith("merge: ") ? "in a merge" : "in a group"}
                  </span>
                )}
                <i>{m.why}</i>
              </span>
              <span className="mapSimBar" aria-hidden="true">
                <i style={{ width: `${Math.round(Math.min(1, m.score) * 100)}%` }} />
              </span>
            </label>
          );
        })}
      </div>
      {data.ai !== "done" && (
        <button className="btn mapSimAi" disabled={data.ai === "busy"} onClick={() => simEvent("ai")}>
          {data.ai === "busy" ? "Reading the codebook…"
            : <>Ask the AI for semantic matches — <b>≈{data.inTok.toLocaleString()} tokens · ≈${data.costEst.toFixed(4)}</b></>}
        </button>
      )}
      {data.ai === "done" && data.cost != null && (
        <div className="mapSimNote">AI pass done · ${data.cost.toFixed(4)} · logged</div>
      )}
      {n > 0 && (
        <div className="mapSimNote mapSimChoice">
          <b>Merge</b> makes them one code · <b>Group</b> keeps them separate, filed together
        </div>
      )}
      <div className="mapCardActions">
        <button className="btn primary" disabled={!n} onClick={() => simEvent("take", "merge")}
          title="These are ONE code: fold them into a single code. Lands as a proposal you review and can still edit — accepting it shrinks the codebook.">
          Merge into one{n ? ` (${n + 1})` : ""}
        </button>
        <button className="btn" disabled={!n} onClick={() => simEvent("take", "group")}
          title="These stay SEPARATE codes, filed together as a theme. Nothing about the codes changes.">
          Group as theme
        </button>
        <button className="btn" disabled={!n} onClick={() => simEvent("select")}
          title="Select these on the map and close">Select</button>
      </div>
    </div>
  );
});
const nodeTypes = { chip: ChipNode, island: IslandNode, halo: HaloNode, card: CardNode, similar: SimilarNode };

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

// Popups are placed at the pointer, which near an edge puts half of them
// off-screen. Measure once after they render and nudge them back in — cheaper
// and more honest than guessing each panel's size in advance.
function useKeepOnScreen<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = ""; // measure where CSS actually put it
    const r = el.getBoundingClientRect();
    const pad = 8;
    const dx = Math.min(0, window.innerWidth - pad - r.right) - Math.min(0, r.left - pad);
    const dy = Math.min(0, window.innerHeight - pad - r.bottom) - Math.min(0, r.top - pad);
    if (dx || dy) el.style.transform = `translate(${dx}px, ${dy}px)`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
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
  const { setNodes: rfSetNodes, getNodes, getInternalNode, fitView, getZoom, getViewport, setViewport } = useReactFlow();
  // menu state carries the selection it acts on, captured at open — the menu
  // needs no live subscription
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string[];
    island?: { gi: number; name: string }; halo?: { ci: number; name: string } } | null>(null);
  // the modal, optionally pre-scoped to one island (island context menu)
  const [aiOpen, setAiOpen] = useState<false | { scope: number | "all" | { focus: string[] } }>(false);
  const [themeAiOpen, setThemeAiOpen] = useState(false);
  const [confirmRelayout, setConfirmRelayout] = useState<{ right: number; y: number } | null>(null);
  const [layoutMenu, setLayoutMenu] = useState<{ right: number; y: number } | null>(null);
  // the gestures used to sit in the bar as a paragraph; they are reference,
  // not something to read every session, so they live behind a button
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useKeepOnScreen<HTMLDivElement>([menu]);
  // "find similar codes": a ranked panel at the cursor. Local matches appear
  // instantly; the AI pass is a second, paid step inside the same panel.
  const [similar, setSimilar] = useState<null | {
    source: string; rows: SimilarRow[];
    ticked: Set<string>; ai: "idle" | "busy" | "done"; cost?: number;
  }>(null);
  // the quote for the optional AI pass, computed when the panel opens
  const simTokens = useMemo(() => {
    const st = useStore.getState();
    if (!similar) return { inTok: 0, cost: 0 };
    const red = redactor(st.ai.redactTerms);
    const book = Object.keys(st.codebook).filter((n) => n !== similar.source)
      .map((name) => ({ name, def: st.codebook[name]?.def ?? "" }));
    const inTok = estimateSimilarTokens(
      { name: similar.source, def: st.codebook[similar.source]?.def ?? "", excerpts: [] }, book, red);
    return { inTok, cost: costOf(modelOf(st.ai.model), inTok, estimateTokens(" ".repeat(240))) };
  }, [similar]);
  // the areas view is project data: it survives a reload and travels in the file
  const topicGroups = useStore((s) => s.codeAreas);
  const topicFp = useStore((s) => s.codeAreasFp);
  // the codebook's IDENTITY, not the map's display order: `codes` is sorted by
  // excerpt count, so accepting one excerpt would reorder it and cry stale
  const codebookFp = useMemo(() => Object.keys(codebook).sort().join("\n"), [codebook]);
  const topicsStale = topicFp !== codebookFp;
  const [topicAiOpen, setTopicAiOpen] = useState(false);
  const [viewMenu, setViewMenu] = useState<{ left: number; y: number } | null>(null);
  const viewMenuRef = useKeepOnScreen<HTMLDivElement>([viewMenu]);
  const [openCards, setOpenCards] = useState<Set<number>>(remembered.openCards);
  useEffect(() => { remembered.openCards = openCards; }, [openCards]);
  const [genCi, setGenCi] = useState<number | null>(null);
  const [confirmAi, setConfirmAi] = useState<{ ci: number; x: number; y: number } | null>(null);
  const aiConfirmRef = useKeepOnScreen<HTMLDivElement>([confirmAi]);
  // "where do these belong": the same one-line consent the group description
  // uses. The full modal was the wrong weight for a question you ask often.
  const [confirmFocus, setConfirmFocus] = useState<{ codes: string[]; x: number; y: number } | null>(null);
  const focusConfirmRef = useKeepOnScreen<HTMLDivElement>([confirmFocus]);
  const [focusBusy, setFocusBusy] = useState(false);
  // what the run actually said, shown on the map until dismissed
  const [focusNote, setFocusNote] = useState<null | {
    text: string; cost: number;
    // node ids the run produced, so the note can take you to them
    show?: string[]; showLabel?: string;
  }>(null);
  // card fold/unfold arrives from the node components as an event
  useEffect(() => {
    const onToggle = (e: Event) => setOpenCards((old) => {
      const ci = (e as CustomEvent<number>).detail;
      const n = new Set(old); n.has(ci) ? n.delete(ci) : n.add(ci); return n;
    });
    window.addEventListener("qually:togglecard", onToggle);
    return () => window.removeEventListener("qually:togglecard", onToggle);
  }, []);
  // the similar node talks back through events, so it stays a cheap memo'd
  // component and every decision lives here
  useEffect(() => {
    const onToggleRow = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      setSimilar((s) => {
        if (!s) return s;
        const t = new Set(s.ticked);
        t.has(name) ? t.delete(name) : t.add(name);
        return { ...s, ticked: t };
      });
    };
    const onClose = () => setSimilar(null);
    const onAi = () => void runSimilarAiRef.current?.();
    const onTake = (e: Event) => takeSimilarRef.current?.((e as CustomEvent<"merge" | "group">).detail);
    const onSelect = () => selectSimilarRef.current?.();
    window.addEventListener("qually:simtoggle", onToggleRow);
    window.addEventListener("qually:simclose", onClose);
    window.addEventListener("qually:simai", onAi);
    window.addEventListener("qually:simtake", onTake);
    window.addEventListener("qually:simselect", onSelect);
    return () => {
      window.removeEventListener("qually:simtoggle", onToggleRow);
      window.removeEventListener("qually:simclose", onClose);
      window.removeEventListener("qually:simai", onAi);
      window.removeEventListener("qually:simtake", onTake);
      window.removeEventListener("qually:simselect", onSelect);
    };
  }, []);
  // the handlers close over changing state, so the listeners reach them
  // through refs rather than re-subscribing on every keystroke
  const runSimilarAiRef = useRef<() => void>(null);
  const takeSimilarRef = useRef<(m: "merge" | "group") => void>(null);
  const selectSimilarRef = useRef<() => void>(null);
  // the pending revision plan is PROJECT data — it survives reloads and travels
  // in the file, so the review can continue in a later session
  const plan = useStore((st) => st.codePlan);
  const clusters = useStore((st) => st.codeClusters);
  // openCards keys clusters by INDEX; whenever the cluster at an index
  // changes identity (shrink, wholesale replace by a focus run), stale
  // entries would light the wrong halo — keep only the ones whose survivor
  // still matches
  const prevSurvivors = useRef(clusters.map((c) => c.survivor));
  useEffect(() => {
    const prev = prevSurvivors.current;
    const changed = clusters.length !== prev.length || clusters.some((c, i) => c.survivor !== prev[i]);
    if (changed) {
      setOpenCards((old) => new Set([...old].filter((ci) => clusters[ci]?.survivor === prev[ci])));
    }
    prevSurvivors.current = clusters.map((c) => c.survivor);
  }, [clusters]);
  // The view: Reconcile while ANYTHING is pending, Themes on an empty plan —
  // unless the researcher picked one this session. The override stays NULL
  // until they do, which is what keeps the default following the work rather
  // than freezing on whatever the map opened with.
  const [viewOverride, setViewOverride] = useState(remembered.view);
  useEffect(() => { remembered.view = viewOverride; }, [viewOverride]);
  const view: MapView =
    viewOverride ?? (clusters.length + plan.length > 0 ? "reconcile" : "themes");
  const spec = VIEWS[view];
  // the layout slot this view owns; null means nothing here moves
  const slot = spec.layout;
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
    const family = getComputedStyle(document.body).fontFamily; // read once per rebuild
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
    // "Find similar" hangs off the chip you asked about, so it pans and zooms
    // with the map. It is placed LAST, after positions are known, and never
    // participates in packing — asking a question must not move the map.
    const withSimilar = (ns: MapNode[]): MapNode[] => {
      if (!similar) return ns;
      const host = ns.find((n) => n.type === "chip" && n.id === similar.source);
      if (!host) return ns;
      const abs = { x: host.position.x, y: host.position.y };
      // a child of an island carries a parent-relative position; walk up once
      if (host.parentId) {
        const parent = ns.find((n) => n.id === host.parentId);
        if (parent) { abs.x += parent.position.x; abs.y += parent.position.y; }
      }
      const node: SimilarNodeT = {
        id: "similar", type: "similar",
        position: { x: abs.x, y: abs.y + (host.height ?? ch) + 14 },
        width: Math.max(330, fs * 24),
        draggable: false, selectable: false, focusable: false,
        zIndex: 20,
        data: { ...similar, inTok: simTokens.inTok, costEst: simTokens.cost },
      };
      return [...ns, node];
    };
    const actOf = new Map(plan.map((a) => [a.code, a]));
    // A chip INSIDE a container is packed, always: its coordinates carry no
    // meaning there, so a hand position is neither read nor kept. A FREE chip
    // is the opposite — its position is the only thing carrying intent, so the
    // stored one wins over the packer's.
    const hand = slot ? mapPositions[slot] : {};
    const chipNode = (c: string, position: { x: number; y: number }, parentId?: string): ChipNodeT => ({
      id: c,
      type: "chip" as const,
      position: parentId ? position : hand[c] ?? position,
      ...(parentId ? { parentId } : {}),
      width: widths.get(c)!, height: ch,
      selected: remembered.selected.has(c),
      draggable: slot !== null,
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0, act: actOf.get(c) },
    });
    // Codes in no container: the ones you placed by hand stay exactly there and
    // are NOT packed; the rest fall to the catch-all pile. That is what makes
    // "drop out and it stays put" and "drop onto Unassigned and it tidies in"
    // two visibly different things instead of one ambiguous state.
    const splitLoose = (list: string[]) => ({
      free: list.filter((c) => hand[c]),
      packed: list.filter((c) => !hand[c]),
    });

    // Piles of codes rendered as islands — shared by the derived bucket views
    // and the AI areas. `islandId` gives each pile a stable identity: row order
    // shifts as piles empty and refill, so positions must not hang off it.
    const pileNodes = (
      piles: { name: string; list: string[]; ai?: number }[],
      opts: { islandId: (p: { name: string }) => string; movable: boolean; freeChips?: string[] },
    ) => {
      const blocks = piles.map((g, gi) => ({
        name: g.name, gi, list: g.list, ai: g.ai, ...pack(g.list, near(g.list)),
        // the caption reads "name · count" and carries no buttons
        cap: captionBox(fs, 1, 7, `${g.name} · ${g.list.length}`, 1, family),
      }));
      const rowW = Math.max(900, Math.sqrt(blocks.reduce((a, b) => a + (Math.max(b.w + 2 * PAD, b.cap.w) + ISLAND_GAP) * (b.h + 2 * PAD + ISLAND_GAP), 0)) * 1.4,
        ...blocks.map((b) => b.cap.w));
      const islands: IslandNodeT[] = [];
      const children: ChipNodeT[] = [];
      const stored = opts.movable && slot ? mapIslandPos[slot] : {};
      let ix = 0, iy = blocks[0]?.cap.h ?? 0, rowH = 0;
      for (const b of blocks) {
        const key = opts.islandId(b);
        const bw = b.w + 2 * PAD, bh = b.h + 2 * PAD;
        // the caption overhangs a narrow island: reserve ITS width for spacing
        const stepW = Math.max(bw, b.cap.w);
        if (ix > 0 && ix + stepW > rowW) { ix = 0; iy += rowH + ISLAND_GAP + b.cap.h; rowH = 0; }
        islands.push({
          id: key, type: "island" as const,
          position: stored[key] ?? { x: ix, y: iy }, width: bw, height: bh,
          draggable: opts.movable, selectable: false, focusable: false,
          dragHandle: ".mapIslandLabel",
          data: { name: `${b.name} · ${b.list.length}`, gi: b.gi, pile: true, list: b.list, gkey: b.name,
            ...(b.ai !== undefined ? { ai: b.ai } : {}) },
        });
        for (const c of b.list)
          children.push(chipNode(c, { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y }, key));
        ix += stepW + ISLAND_GAP;
        rowH = Math.max(rowH, bh);
      }
      // hand-placed unfiled codes float beside the piles at their own spots
      const free = (opts.freeChips ?? []).map((c) => chipNode(c, { x: 0, y: 0 }));
      return [...islands, ...children, ...free] as MapNode[];
    };

    // DERIVED views: piles come from counts, so there is no membership to edit
    // and nothing here moves — not the chips, not the piles.
    if (view === "pids" || view === "segs") {
      const val = (c: string) => (view === "pids" ? stats[c]?.pids ?? 0 : stats[c]?.segs ?? 0);
      const buckets: [string, (n: number) => boolean][] = view === "pids"
        ? [["1 transcript", (n) => n <= 1], ["2–4 transcripts", (n) => n <= 4], ["5+ transcripts", () => true]]
        : [["1 excerpt", (n) => n <= 1], ["2–5 excerpts", (n) => n <= 5], ["6–15 excerpts", (n) => n <= 15], ["16+ excerpts", () => true]];
      const piles = buckets.map(([name]) => ({ name, list: [] as string[] }));
      for (const c of codes) piles[buckets.findIndex(([, fits]) => fits(val(c)))].list.push(c);
      return { nodes: withSimilar(pileNodes(piles.filter((g) => g.list.length > 0), {
        islandId: (p) => `bucket:${p.name}`, movable: false,
      })) };
    }

    // AI AREAS: real project data, so a drop files the code. `ai` is the index
    // of the pile in the stored areas (-1 = the Unassigned parking lot), which
    // survives the filtering of empty ones — row order does not.
    if (view === "areas") {
      const grouped = new Set(topicGroups.flatMap((g) => g.codes));
      const piles = topicGroups
        .map((g, ai) => ({ name: g.name, list: g.codes.filter(inBook), ai }))
        .filter((g) => g.list.length > 0);
      // codes the areas have never seen — added, or renamed since the run —
      // collect here rather than vanishing: file them by hand, or re-run
      const { free, packed } = splitLoose(codes.filter((c) => !grouped.has(c)));
      if (packed.length) piles.push({ name: "Unassigned", list: packed, ai: -1 });
      return { nodes: withSimilar(pileNodes(piles, {
        islandId: (p) => `area:${p.name}`, movable: true, freeChips: free,
      })) };
    }

    if (view === "reconcile") {
      const live = clusters
        .map((c, ci) => ({ ...c, ci, codes: c.codes.filter(inBook) }))
        .filter((c) => c.codes.length >= 2);
      const clustered = new Set(live.flatMap((c) => c.codes));
      const singles = codes.filter((c) => !clustered.has(c));

      const haloNodes: HaloNodeT[] = [];
      const chipNodes: ChipNodeT[] = [];
      const extraNodes: CardNodeT[] = [];
      // capsule blocks: square-ish packed members + halo padding
      const blocks = live.map((c) => {
        const totalW = c.codes.reduce((a, x) => a + widths.get(x)! + GX, 0);
        const packed = pack(c.codes, Math.max(widths.get(c.codes[0])! + GX, Math.sqrt(totalW * (ch + GY)) * 1.15));
        // reserve room for the unfolded card below (reasoning + glimpse +
        // actions), so neighbors never sit under it
        const cardW = Math.max(280, Math.min(420, (packed.w + 2 * HALO_PAD) - 24));
        const open = openCards.has(c.ci);
        const showGlimpse = genCi === c.ci || !!c.desc;
        const lines = (text: string, width: number) =>
          text ? Math.ceil(text.length * (fs * 0.52) / width) : 0;
        // the glimpse sits in its own inset block (margins + padding + rule)
        // under an "AI glimpse" header, so it neither shares the rationale's
        // width nor comes free — and while it generates, the pulse line stands
        // in for text that isn't there yet
        // Card height is measured but NOT reserved: unfolding a card used to
        // grow its row, which re-wrapped the packing and slid every halo after
        // it to a new place — you opened one thing and the map moved under
        // you. The card now floats over whatever is beneath it (it is a
        // transient detail, and it is the thing you are looking at), so
        // opening and folding never disturb a single position.
        const ratLines = open ? Math.max(1, lines(c.rationale ?? "", cardW - 24)) : 0;
        const glimpseLines = open && showGlimpse
          ? Math.max(1, lines(genCi === c.ci ? "" : c.desc ?? "", cardW - 41)) : 0;
        void ratLines; void glimpseLines;
        const cardH = 0;
        // the halo caption carries the name plus tag, count and fold arrow —
        // and CSS clips it at max(200%, 30ch), so reserving its full measured
        // width would just waste space on a long merged name
        const capFull = captionBox(fs, 1, 4.5, c.newName ?? c.survivor, c.newName ? 9 : 4, family);
        const blockW = packed.w + 2 * HALO_PAD;
        const cap = { ...capFull, w: Math.min(capFull.w, Math.max(2 * blockW, 30 * 0.5 * captionFs(fs, 1, 4.5))) };
        return { c, packed, w: packed.w + 2 * HALO_PAD, h: packed.h + 2 * HALO_PAD, cardH, cap };
      });
      const rowW = Math.max(1000, Math.sqrt(blocks.reduce((a, b) => a + (Math.max(b.w, b.cap.w) + HALO_GAP) * (b.h + b.cardH + b.cap.h + HALO_GAP), 0)) * 1.5);
      let x = 0, y = 40 + (blocks[0]?.cap.h ?? 0), rowH = 0;
      for (const b of blocks) {
        // the halo caption is centered on the capsule and can overhang both
        // sides — space by whichever is wider
        const stepW = Math.max(b.w, b.cap.w);
        if (x > 0 && x + stepW > rowW) { x = 0; y += rowH + HALO_GAP + b.cap.h; rowH = 0; }
        const key = `halo:${b.c.ci}`;
        haloNodes.push({
          id: key, type: "halo" as const,
          // the halo caption is CENTERED on the capsule (unlike an island's,
          // which is left-aligned), so a name wider than its capsule bleeds
          // backwards too — offset the capsule by half the overhang and both
          // gaps come out at exactly HALO_GAP
          position: mapIslandPos.reconcile[key] ?? { x: x + Math.max(0, (b.cap.w - b.w) / 2), y },
          width: b.w, height: b.h,
          // NOT pointer-selectable: a group counts as selected when every one
          // of its codes is (see the derivation effect), so brushing a capsule
          // with the marquee picks the codes you touched, not the whole group
          draggable: true, selectable: false, focusable: false,
          dragHandle: ".mapHaloLabel",
          data: {
            name: b.c.newName ?? b.c.survivor, renamed: !!b.c.newName,
            // norm(), not exact equality: acceptance resolves the target with
            // norm(), so a case/whitespace variant of an outside code IS a
            // silent three-way merge and must show "joins existing"
            joins: !!b.c.newName && Object.keys(codebook).some((k) =>
              norm(k) === norm(b.c.newName!) && !b.c.codes.some((m) => norm(m) === norm(k))),
            ci: b.c.ci, count: b.c.codes.length, open: openCards.has(b.c.ci),
          },
        });
        for (const m of b.c.codes)
          chipNodes.push(chipNode(m, { x: HALO_PAD + b.packed.pos[m].x, y: HALO_PAD + b.packed.pos[m].y }, key));
        // the unfolded card hangs below its halo on a stem — reasoning, the
        // AI glimpse (or its loading pulse), and the verdict, all foldable
        if (openCards.has(b.c.ci)) {
          extraNodes.push({
            id: `card:${b.c.ci}`, type: "card" as const,
            position: { x: 12, y: b.h + 22 }, parentId: key,
            draggable: false, selectable: false, focusable: false,
            zIndex: 15, // it floats over the field below instead of pushing it
            width: Math.max(280, Math.min(420, b.w - 24)),
            data: { ci: b.c.ci, gen: genCi === b.c.ci },
          });
        }
        x += stepW + HALO_GAP;
        rowH = Math.max(rowH, b.h + b.cardH);
      }
      // the untouched field below the halos
      const flat = pack(singles, near(singles));
      const offY = blocks.length ? y + rowH + HALO_GAP : 0;
      for (const c of singles)
        chipNodes.push(chipNode(c, { x: flat.pos[c].x, y: offY + flat.pos[c].y }));
      return { nodes: withSimilar([...haloNodes, ...chipNodes, ...extraNodes] as MapNode[]) };
    }

    // THEMES
    const groups = codeGroups
      .map((g, gi) => ({ ...g, gi, codes: g.codes.filter(inBook) }))
      .filter((g) => g.codes.length > 0);
    const grouped = new Set(groups.flatMap((g) => g.codes));
    // same parking-lot rule as the areas view: hand-placed ungrouped codes keep
    // their spot, the rest gather in the catch-all island
    const { free: looseFree, packed: loosePacked } = splitLoose(codes.filter((c) => !grouped.has(c)));

    if (groups.length === 0) {
      const flat = pack(codes, near(codes));
      return { nodes: withSimilar(codes.map((c) => chipNode(c, flat.pos[c])) as MapNode[]) };
    }
    const blocks = [...groups.map((g) => ({ name: g.name, gi: g.gi, list: g.codes })),
      ...(loosePacked.length ? [{ name: "Ungrouped", gi: -1, list: loosePacked }] : [])]
      .map((b) => ({ ...b, ...pack(b.list, near(b.list)),
        // name plus the dissolve button; editable captions can also grow
        cap: captionBox(fs, 1, 7, b.name, 2, family) }));
    const totalW = blocks.reduce((a, b) => a + Math.max(b.w + 2 * PAD, b.cap.w) + ISLAND_GAP, 0);
    const rowW = Math.max(900, Math.sqrt(totalW * (blocks[0] ? blocks[0].h + 160 : 1)) * 1.6, ...blocks.map((b) => Math.max(b.w + 2 * PAD, b.cap.w)));
    const islands: IslandNodeT[] = [];
    const children: ChipNodeT[] = [];
    let ix = 0, iy = blocks[0]?.cap.h ?? 0, rowH = 0;
    for (const b of blocks) {
      const key = b.gi === -1 ? LOOSE : `island:${b.gi}`;
      const bw = b.w + 2 * PAD, bh = b.h + 2 * PAD;
      const stepW = Math.max(bw, b.cap.w);
      if (ix > 0 && ix + stepW > rowW) { ix = 0; iy += rowH + ISLAND_GAP + b.cap.h; rowH = 0; }
      islands.push({
        id: key,
        type: "island" as const,
        position: mapIslandPos.themes[key] ?? { x: ix, y: iy },
        width: bw, height: bh,
        draggable: true, selectable: false, focusable: false,
        dragHandle: ".mapIslandLabel",
        data: { name: b.name, gi: b.gi },
      });
      for (const c of b.list) children.push(chipNode(c, { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y }, key));
      ix += stepW + ISLAND_GAP;
      rowH = Math.max(rowH, bh);
    }
    for (const c of looseFree) children.push(chipNode(c, { x: 0, y: 0 }));
    // parents strictly before children (RF sub-flow requirement)
    return { nodes: withSimilar([...islands, ...children] as MapNode[]) };
  }, [codes, codebook, stats, sidebarFontSize, codeGroups, plan, clusters, view, slot, mapPositions, mapIslandPos, openCards, genCi, segments, topicGroups, similar, simTokens]);
  const build = useCallback(() => layout.nodes, [layout]);

  // built once per mount; RF owns the array from here (uncontrolled). When the
  // codebook changes under the map (a merge, a rename, new codes), rebuild —
  // dragged chips keep their place via remembered.positions.
  const [initialNodes] = useState(build);
  useEffect(() => { rfSetNodes(build()); }, [build, rfSetNodes]);

  // plan strip verdicts (renames and rejects only — merges are halos). One
  // earcon per GESTURE: "Accept all" silences the per-item marks and plays a
  // single confirmation, else N simultaneous envelopes stack into clipping.
  const applyAction = (a: CodeAction, sound = true) => {
    const st = useStore.getState();
    // the row leaves the plan FIRST: renameCode rebuilds every entry object,
    // so a filter afterwards would find only stale clones (see dropAction)
    setPlan((ps) => dropAction(ps, a.code));
    if (a.action === "rename") st.renameCode(a.code, a.newName!);
    else if (a.action === "remove") st.rejectCode(a.code);
    if (sound) (a.action === "remove" ? earcon.reject : earcon.accept)();
  };
  const skipAction = (a: CodeAction) => { setPlan((ps) => dropAction(ps, a.code)); earcon.skip(); };

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
    // the glimpse streams into the card — open it so the loading pulse shows
    setOpenCards((old) => new Set(old).add(ci));
    setGenCi(ci);
    earcon.aiStart();
    try {
      const { glimpse, usage } = await glimpseCluster({
        key, model: st.ai.model, codes: inputs, redaction: red,
      });
      const s2 = useStore.getState();
      s2.setCodeClusters(s2.codeClusters.map((c, i) =>
        (i === ci ? { ...c, desc: glimpse, descCodes: [...c.codes] } : c)));
      s2.logAiCall({
        at: new Date().toISOString(), model: st.ai.model, task: "glimpse", pid: "(codebook)",
        lines: inputs.length, redactions: 0,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      announce("Group description ready.");
      earcon.aiDone();
    } catch (e) {
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      announce(`Describe failed: ${msg}`, { assertive: true });
      earcon.error();
    } finally {
      setGenCi(null);
    }
  }, [glimpseInputs]);

  // where each code currently lives, so a match can say "in <group>" and stay
  // unticked until the researcher deliberately takes it
  const homeOf = useCallback((code: string): string | null => {
    const st = useStore.getState();
    const cl = st.codeClusters.find((c) => c.codes.includes(code));
    if (cl) return `merge: ${cl.newName ?? cl.survivor}`;
    const g = st.codeGroups.find((x) => x.codes.includes(code));
    return g ? g.name : null;
  }, []);
  const openSimilar = useCallback((source: string) => {
    const st = useStore.getState();
    const book = Object.keys(st.codebook).map((name) => ({ name, def: st.codebook[name]?.def ?? "" }));
    const rows = findSimilar(source, book).map((m) => ({ ...m }));
    setSimilar({
      source, rows, ai: "idle",
      // codes already filed stay unticked: taking one is a deliberate act
      ticked: new Set(rows.filter((m) => !homeOf(m.name)).map((m) => m.name)),
    });
    announce(rows.length
      ? `${rows.length} code${rows.length === 1 ? "" : "s"} with similar wording to ${source}`
      : `No codes share wording with ${source}. Ask the AI for semantic matches.`);
  }, [homeOf]);
  // the paid second look: names and definitions only, one small request
  const runSimilarAi = useCallback(async () => {
    const cur = similar;
    if (!cur) return;
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const red = redactor(st.ai.redactTerms);
    const book = Object.keys(st.codebook)
      .filter((n) => n !== cur.source)
      .map((name) => ({ name, def: st.codebook[name]?.def ?? "" }));
    // a few excerpts of the focus code sharpen the judgement; the rest of the
    // book rides on names and definitions alone
    const focus = { name: cur.source, def: st.codebook[cur.source]?.def ?? "", excerpts: [] as string[] };
    const byCode: string[] = [];
    for (const seg of st.segments) {
      if (seg.status !== "accepted" || seg.code !== cur.source || !st.transcripts[seg.pid]) continue;
      if (byCode.length >= 4) break;
      const ex = segExcerpt(seg, st.transcripts[seg.pid].lines).excerpt;
      if (ex) byCode.push(ex);
    }
    focus.excerpts = byCode;
    setSimilar((s) => s && { ...s, ai: "busy" });
    earcon.aiStart();
    try {
      const { matches, usage } = await findSimilarWithAi({
        key, model: st.ai.model, focus, book, redaction: red,
      });
      st.logAiCall({
        at: new Date().toISOString(), model: st.ai.model, task: "similar",
        pid: `(similar to: ${cur.source})`, lines: book.length + 1,
        redactions: red.count(focus.def) + focus.excerpts.reduce((n, e) => n + red.count(e), 0),
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      setSimilar((s) => {
        if (!s) return s;
        // the AI's list leads; a local-only match keeps its place below
        const seen = new Set(matches.map((m) => m.name));
        const merged = [
          ...matches.map((m) => ({ name: m.name, score: m.band === "very" ? 0.95 : 0.6, why: m.why, band: m.band })),
          ...s.rows.filter((r) => !seen.has(r.name)),
        ];
        const ticked = new Set(s.ticked);
        for (const m of matches) if (m.band === "very" && !homeOf(m.name)) ticked.add(m.name);
        return { ...s, rows: merged, ticked, ai: "done", cost: usage.costUsd };
      });
      earcon.aiDone();
      announce(`${matches.length} semantic match${matches.length === 1 ? "" : "es"} for ${cur.source}`);
    } catch (e) {
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      setSimilar((s) => s && { ...s, ai: "idle" });
      earcon.error();
      announce(`Find similar failed: ${msg}`, { assertive: true });
    }
  }, [similar, homeOf]);
  // acting on the ticked rows: the source code always rides along, and any
  // code taken from another group or merge leaves it (one entry, undoable)
  const takeSimilar = useCallback((mode: "merge" | "group") => {
    const cur = similar;
    if (!cur) return;
    const picked = [...cur.ticked];
    if (!picked.length) return;
    const members = [cur.source, ...picked];
    const st = useStore.getState();
    if (mode === "merge") {
      const clusters = st.codeClusters
        .map((c) => ({ ...c, codes: c.codes.filter((x) => !members.includes(x)) }))
        .filter((c) => c.codes.length >= 2);
      const next = [...clusters, {
        survivor: bestSurvivor(st, members), codes: members,
        rationale: `Found by searching for codes similar to “${cur.source}”.`,
      }];
      st.setCodeClusters(next);
      earcon.join();
      announce(`Proposed merging ${members.length} codes into one — showing it on the map`);
      // take the researcher to the proposal, or nothing appears to have happened
      showNodes(haloIdsFor(useStore.getState().codeClusters, [next[next.length - 1]]), "reconcile");
    } else {
      const groups = st.codeGroups
        .map((g) => ({ ...g, codes: g.codes.filter((x) => !members.includes(x)) }))
        .filter((g) => g.codes.length > 0);
      st.setCodeGroups([...groups, { name: cur.source, codes: members }]);
      earcon.join();
      announce(`Grouped ${members.length} codes as “${cur.source}” — showing it on the map`);
      // islands live in the Themes stage: land there, or the group is made and
      // the map looks unchanged
      showNodes([`island:${useStore.getState().codeGroups.length - 1}`], "themes");
    }
    setSimilar(null);
  }, [similar]);

  // the focus run, inline: gather evidence, send, land the plan, and SAY what
  // came back — the old modal reported its result on a screen you had already
  // dismissed, so an empty answer looked like nothing happened
  const focusInputs = useCallback((codes: string[]) => {
    const st = useStore.getState();
    const focusSet = new Set(codes.filter((c) => c in st.codebook));
    const byCode = new Map<string, string[]>();
    for (const seg of st.segments) {
      if (seg.status !== "accepted" || !st.transcripts[seg.pid]) continue;
      const cap = focusSet.has(seg.code) ? 8 : 2;
      const arr = byCode.get(seg.code) ?? [];
      if (arr.length >= cap) continue;
      const ex = segExcerpt(seg, st.transcripts[seg.pid].lines).excerpt;
      if (ex) { arr.push(ex); byCode.set(seg.code, arr); }
    }
    const mk = (name: string) => ({ name, def: st.codebook[name]?.def ?? "", excerpts: byCode.get(name) ?? [] });
    return {
      focus: [...focusSet].map(mk),
      context: Object.keys(st.codebook).filter((c) => !focusSet.has(c)).map(mk),
    };
  }, []);
  const runFocus = useCallback(async (codes: string[]) => {
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const { focus, context } = focusInputs(codes);
    if (!focus.length || !context.length) { announce("Nothing to compare these against.", { assertive: true }); return; }
    const red = redactor(st.ai.redactTerms);
    setFocusBusy(true);
    earcon.aiStart();
    announce(`Asking where ${focus.length} code${focus.length === 1 ? "" : "s"} belong…`);
    try {
      const r = await reconcileFocus({ key, model: st.ai.model, focus, context, redaction: red, mode: "consolidate" });
      const s2 = useStore.getState();
      const merged = mergeFocusResults(s2.codeClusters, s2.codePlan, r.plan, new Set(r.reviewed));
      s2.applyReconcilePlan(merged.clusters, merged.actions, false);
      s2.logAiCall({
        at: new Date().toISOString(), model: st.ai.model, task: "reconcile",
        pid: `(focus: ${focus.length} codes)`, lines: focus.length + context.length,
        redactions: [...focus, ...context].reduce((n, c) =>
          n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0),
        inTok: r.usage.inTok, outTok: r.usage.outTok, costUsd: +r.usage.costUsd.toFixed(5),
      });
      earcon.aiDone();
      const nC = r.plan.clusters.length, nA = r.plan.actions.length;
      // the answer is often "these are fine" — say so out loud rather than
      // leaving the map looking unchanged and unexplained
      const verdict = nC + nA === 0
        ? `No changes proposed — the AI reads ${focus.length === 1 ? "this code" : "these codes"} as already belonging where ${focus.length === 1 ? "it is" : "they are"}.`
        : `${nC} merge proposal${nC === 1 ? "" : "s"} and ${nA} rename or reject${nA === 1 ? "" : "s"} — on the map now.`;
      const missed = r.unreviewed.length ? ` ${r.unreviewed.length} code${r.unreviewed.length === 1 ? "" : "s"} came back unreviewed.` : "";
      // which nodes the run actually produced, so "Show" has somewhere to go:
      // the halos for fresh clusters, else the chips the actions touched
      const haloIds = haloIdsFor(useStore.getState().codeClusters, r.plan.clusters);
      const show = haloIds.length ? haloIds : r.plan.actions.map((a) => a.code);
      setFocusNote({
        text: verdict + missed, cost: r.usage.costUsd,
        ...(show.length ? {
          show,
          showLabel: haloIds.length
            ? `Show ${haloIds.length === 1 ? "the group" : `the ${haloIds.length} groups`}`
            : `Show ${show.length === 1 ? "the code" : "the codes"}`,
        } : {}),
      });
      announce(verdict + missed);
      if (nC) setViewOverride("reconcile");
    } catch (e) {
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      earcon.error();
      setFocusNote({ text: `That request failed: ${msg}`, cost: 0 });
      announce(`Where-do-these-belong failed: ${msg}`, { assertive: true });
    } finally {
      setFocusBusy(false);
    }
  }, [focusInputs]);

  // The results node lives in world space, so a code near the bottom of the
  // screen puts its panel below the fold. Pan by the smallest amount that
  // brings it fully into view — once, on open, never fighting the researcher
  // afterwards. React Flow renders the node a frame or two after the state
  // changes, so this waits for it rather than measuring thin air.
  useEffect(() => {
    if (!similar) return;
    let tries = 0, frame = 0;
    const tick = () => {
      const el = document.querySelector(".react-flow__node-similar");
      const canvas = document.querySelector(".mapCanvas");
      if (!el || !canvas) {
        if (tries++ < 12) frame = requestAnimationFrame(tick);
        return;
      }
      const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      const pad = 14;
      const dx = Math.min(0, c.right - pad - r.right) - Math.min(0, r.left - c.left - pad);
      const dy = Math.min(0, c.bottom - pad - r.bottom) - Math.min(0, r.top - c.top - pad);
      if (dx || dy) {
        const vp = getViewport();
        void setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy }, { duration: 220 });
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [similar, getViewport, setViewport]);

  // Take me to what the run produced. Halos only exist in the Reconcile view,
  // islands only in Themes, so switch there first and then wait for React Flow
  // to render the nodes before framing them.
  const showNodes = useCallback((ids: string[], wanted: MapView = "reconcile") => {
    if (!ids.length) return;
    setViewOverride(wanted);
    let tries = 0, frame = 0;
    const tick = () => {
      const live = getNodes().filter((n) => ids.includes(n.id));
      if (!live.length) {
        if (tries++ < 12) frame = requestAnimationFrame(tick);
        return;
      }
      void fitView({ nodes: live.map((n) => ({ id: n.id })), padding: 0.35, duration: 420, maxZoom: 1.1 });
      // the chips inside also carry the selection, so the answer is legible
      // the moment the camera lands
      const wanted = new Set(live.flatMap((n) =>
        n.type === "halo" ? getNodes().filter((x) => x.parentId === n.id).map((x) => x.id) : [n.id]));
      rfSetNodes((ns) => ns.map((n) => ({ ...n, selected: n.type === "chip" && wanted.has(n.id) })));
      announce(`Showing ${live.length === 1 ? "the proposal" : `${live.length} proposals`} on the map`);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getNodes, fitView, rfSetNodes]);

  // Switching view: keep the ZOOM. Every switch used to fitView, which on 178
  // codes lands near 20% where nothing is readable — the losing-your-place bug.
  // The camera only moves when the new layout left you looking at empty canvas,
  // and then it pans (same zoom) to the content rather than zooming out to it.
  const canvasRef = useRef<HTMLDivElement>(null);
  const switchView = useCallback((next: MapView) => {
    if (next === view) { setViewMenu(null); return; }
    // the areas view cannot exist before the AI has worked them out
    if (next === "areas" && topicGroups.length === 0) { setViewMenu(null); setTopicAiOpen(true); return; }
    setViewOverride(next);
    setViewMenu(null);
    let frame = 0, tries = 0;
    const settle = () => {
      const el = canvasRef.current;
      const ns = getNodes().filter((n) => !n.parentId);
      if (!el || !ns.length) { if (tries++ < 12) frame = requestAnimationFrame(settle); return; }
      const vp = getViewport();
      const view0 = {
        x: -vp.x / vp.zoom, y: -vp.y / vp.zoom,
        w: el.clientWidth / vp.zoom, h: el.clientHeight / vp.zoom,
      };
      const seen = ns.some((n) => n.position.x < view0.x + view0.w && n.position.x + (n.width ?? 0) > view0.x
        && n.position.y < view0.y + view0.h && n.position.y + (n.height ?? 0) > view0.y);
      let moved = false;
      if (!seen) {
        // pan to the middle of what this view drew, at the SAME zoom
        const minX = Math.min(...ns.map((n) => n.position.x));
        const maxX = Math.max(...ns.map((n) => n.position.x + (n.width ?? 0)));
        const minY = Math.min(...ns.map((n) => n.position.y));
        const maxY = Math.max(...ns.map((n) => n.position.y + (n.height ?? 0)));
        void setViewport({
          zoom: vp.zoom,
          x: el.clientWidth / 2 - ((minX + maxX) / 2) * vp.zoom,
          y: el.clientHeight / 2 - ((minY + maxY) / 2) * vp.zoom,
        }, { duration: 240 });
        moved = true;
      }
      const spec2 = VIEWS[next];
      const containers = ns.filter((n) => n.type === "halo" || n.type === "island").length;
      announce(`${spec2.label}. ${containers
        ? `${containers} ${next === "reconcile" ? "merge capsule" : next === "themes" ? "island" : "pile"}${containers === 1 ? "" : "s"}, `
        : ""}${codes.length} codes. ${spec2.drag}.${moved ? " Moved the view to where they are." : ""}`);
      // focus lands somewhere predictable — never on whichever chip happened to
      // be under the pointer
      el.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [view, topicGroups.length, getNodes, getViewport, setViewport, codes.length]);

  // Adjust to zoom: measure what is on screen — every top-level thing plus the
  // caption floating above it, at THIS zoom — then nudge only the boxes that
  // actually collide, by the least that clears them. Nothing inside a group
  // moves, the camera does not move, and it lands as one undoable layout edit.
  const cleanUpLayout = useCallback(() => {
    const zoom = getZoom();
    const nodes = getNodes().filter((n) => !n.parentId && n.type !== "card" && n.type !== "similar");
    if (nodes.length < 2) { announce("Nothing needed moving at this zoom"); return; }
    const boxes = nodes.map((n) => {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"] .mapIslandLabel`);
      const w = n.width ?? 0, h = n.height ?? 0;
      if (!el) return { id: n.id, x: n.position.x, y: n.position.y, w, h };
      const r = el.getBoundingClientRect();
      const capW = r.width / zoom, capH = r.height / zoom;
      // an island's caption is left-aligned, a halo's is centred on its capsule
      const left = n.type === "halo" ? n.position.x - Math.max(0, (capW - w) / 2) : n.position.x;
      return { id: n.id, x: left, y: n.position.y - capH, w: Math.max(w, capW), h: h + capH };
    });
    // Two rounds, because only GROUPS actually collide when you zoom out:
    // their captions counter-scale and grow past their capsules, while a chip's
    // text rides inside it and a packed field of chips never overlaps itself.
    // So settle the groups against each other first, then move only the codes
    // a caption has landed on — instead of shaking the whole field.
    const pad = 10 / zoom; // a constant ~10px of breathing space on screen
    const groupIds = new Set(nodes.filter((n) => n.type !== "chip").map((n) => n.id));
    const chipIds = new Set(nodes.filter((n) => n.type === "chip").map((n) => n.id));
    const settled = relaxBoxes(boxes, { pad, horizontalBias: 3, anchored: chipIds });
    const relaxed = relaxBoxes(settled, { pad, horizontalBias: 3, anchored: groupIds });
    const chips: Record<string, { x: number; y: number }> = {};
    const islands: Record<string, { x: number; y: number }> = {};
    let moved = 0;
    nodes.forEach((n, i) => {
      const dx = relaxed[i].x - boxes[i].x, dy = relaxed[i].y - boxes[i].y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved++;
      // EVERY top-level thing gets an explicit position, including the ones
      // that did not move: leave some to the packer and it will happily pack
      // them straight back on top of the ones that did.
      const pos = { x: n.position.x + dx, y: n.position.y + dy };
      if (n.type === "chip") chips[n.id] = pos; else islands[n.id] = pos;
    });
    if (!slot) return; // a derived view has no layout to tidy
    useStore.getState().applyMapLayout(chips, islands, moved, slot);
  }, [getZoom, getNodes, slot]);

  const selectSimilar = useCallback(() => {
    const cur = similar;
    if (!cur) return;
    const pick = new Set([cur.source, ...cur.ticked]);
    rfSetNodes((ns) => ns.map((n) => ({ ...n, selected: n.type === "chip" && pick.has(n.id) })));
    setSimilar(null);
    announce(`${pick.size} codes selected on the map`);
  }, [similar, rfSetNodes]);
  runSimilarAiRef.current = runSimilarAi;
  takeSimilarRef.current = takeSimilar;
  selectSimilarRef.current = selectSimilar;

  const groupSelection = (sel: string[]) => {
    const cleaned = codeGroups.map((g) => ({ ...g, codes: g.codes.filter((c) => !sel.includes(c)) }));
    setCodeGroups([...cleaned, { name: `Group ${codeGroups.length + 1}`, codes: sel }]);
    setMenu(null);
  };
  // by-hand merge proposal: a new halo from the selection
  const clusterSelection = (sel: string[]) => {
    const st = useStore.getState();
    // a hand-made group has no deliberate direction yet — say so explicitly
    // (bestSurvivor with no preference) rather than leaning on setCodeClusters
    // to overwrite whatever placeholder we passed
    st.setCodeClusters([...st.codeClusters,
      { survivor: bestSurvivor(st, sel), codes: sel, rationale: "Grouped by hand on the map." }]);
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
  // the halo under the held chip, tracked across the drag: the .will outline
  // AND the crossing sounds key off transitions of this one value
  const dragOver = useRef<string | null>(null);
  const onNodeDragStart = useCallback((_: unknown, n: Node) => {
    if (remembered.view !== "reconcile" || n.type !== "chip") return;
    const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
    // seed with where the chip already sits, so lifting a member inside its
    // own halo doesn't chirp "entered"
    dragOver.current = haloAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2)?.id ?? null;
    earcon.grab();
  }, [getInternalNode, haloAt]);
  const onNodeDrag = useCallback((_: unknown, n: Node) => {
    // capsules exist only in Reconcile; nothing to outline anywhere else
    if (remembered.view !== "reconcile" || n.type !== "chip" || dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
      const hit = haloAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2);
      clearWill();
      if (hit) document.querySelector(`.react-flow__node[data-id="${hit.id}"] .mapHalo`)?.classList.add("will");
      const over = hit?.id ?? null;
      if (over !== dragOver.current) {
        // crossing a field boundary mid-drag: a quiet preview of what release
        // would do (the louder join/evict marks confirm the actual drop)
        (over ? earcon.hoverIn : earcon.hoverOut)();
        dragOver.current = over;
      }
    });
  }, [getInternalNode, haloAt]);

  // ONE drop rule, every view that has containers:
  //   into a container  → joins, APPENDED at the end (its hand position is
  //                       forgotten, so the packer puts it after the others)
  //   onto the catch-all→ leaves, and forgets its position so it tidies in
  //   open canvas       → leaves, and stays exactly where you let go
  // Derived views never get here: nothing in them is draggable.
  const onNodeDragStop = useCallback((_: unknown, n: Node, dragged: Node[]) => {
    // the last onNodeDrag's frame is still pending: let it run and it repaints
    // a stale .will outline and chirps a crossing on top of the drop's own mark
    if (dragFrame.current) { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; }
    dragOver.current = null;
    // React Flow reports a multi-selection drag ONCE, with the whole set in the
    // third argument. File every node in it, or the ones you did not happen to
    // grab snap back to their packed spots on the next rebuild.
    if (!slot) return; // derived view: nothing here moves
    const moved = dragged?.length ? dragged : [n];
    // A group is selected only when all of its codes are, so a group drag
    // carries its members in the set too. React Flow already moves children
    // with their parent, so filing them again would bake in a doubled offset —
    // and they never left their container anyway.
    const movedIds = new Set(moved.map((x) => x.id));
    const carried = moved.filter((x) => !(x.parentId && movedIds.has(x.parentId)));

    const chips: Record<string, { x: number; y: number }> = {};
    const islands: Record<string, { x: number; y: number }> = {};
    const tidy: string[] = [];
    const reconcile: { code: string; ci: number | null }[] = [];
    const themes: { code: string; gi: number }[] = [];
    const areas: { code: string; ai: number }[] = [];
    const absOf = (x: Node) => getInternalNode(x.id)?.internals.positionAbsolute ?? x.position;
    const containers = getNodes().filter((x) => x.type === (view === "reconcile" ? "halo" : "island"));
    let joined = 0, freed = 0, tidied = 0, into = "";

    for (const x of carried) {
      if (x.type === "island" || x.type === "halo") { islands[x.id] = x.position; continue; }
      if (x.type !== "chip") continue;
      const abs = absOf(x);
      const cx = abs.x + (x.width ?? 0) / 2, cy = abs.y + (x.height ?? 0) / 2;
      const hit = containers.find((r) => cx >= r.position.x && cx <= r.position.x + (r.width ?? 0)
        && cy >= r.position.y && cy <= r.position.y + (r.height ?? 0));
      const d = hit?.data as (HaloData & IslandData) | undefined;
      // the catch-all is a PARKING LOT, not a container: landing on it means
      // "take me out and tidy me in with the other unfiled codes"
      const isCatchAll = view !== "reconcile" && !!hit && (d?.gi === -1 || d?.ai === -1);
      const inside = !!hit && !isCatchAll;

      if (inside) { tidy.push(x.id); joined++; into = d?.gkey ?? d?.name ?? into; }
      else if (isCatchAll) { tidy.push(x.id); tidied++; }
      else { chips[x.id] = abs; freed++; }

      if (view === "reconcile") reconcile.push({ code: x.id, ci: inside ? d!.ci : null });
      else if (view === "themes") themes.push({ code: x.id, gi: inside ? d!.gi : -1 });
      else areas.push({ code: x.id, ai: inside ? d!.ai ?? -1 : -1 });
    }
    if (view === "reconcile") clearWill();

    const st = useStore.getState();
    const membershipOf = (code: string) => view === "reconcile"
      ? st.codeClusters.findIndex((c) => c.codes.includes(code))
      : view === "themes"
        ? st.codeGroups.findIndex((g) => g.codes.includes(code))
        : st.codeAreas.findIndex((a) => a.codes.includes(code));
    const before = new Map([...reconcile, ...themes, ...areas].map((m) => [m.code, membershipOf(m.code)]));
    st.applyMapDrop({ stage: slot, chips, islands, tidy, reconcile, themes, areas });

    // Say what actually happened — every drop, single or not. A count ("moved 3
    // things") is not a consequence, and a lone drag used to make no sound at
    // all beyond an earcon.
    if (!before.size) {
      if (Object.keys(islands).length) {
        announce(`Moved ${Object.keys(islands).length === 1 ? "a group" : `${Object.keys(islands).length} groups`}`);
      }
      return;
    }
    const noun = (k: number) => `${k} code${k === 1 ? "" : "s"}`;
    const what = view === "reconcile" ? "the merge" : view === "themes" ? "the theme" : "the area";
    if (joined) earcon.join(); else if (freed || tidied) earcon.evict();
    const parts: string[] = [];
    if (joined) parts.push(`${noun(joined)} joined ${into ? `“${into}”` : what}`);
    if (tidied) parts.push(`${noun(tidied)} moved to ${view === "themes" ? "Ungrouped" : "Unassigned"}`);
    if (freed) parts.push(`${noun(freed)} left ${what} and stayed where you dropped ${freed === 1 ? "it" : "them"}`);
    if (parts.length) announce(parts.join("; "));
  }, [getNodes, getInternalNode, view, slot]);
  // a drag can end by unmount too; never leave a frame pointed at dead nodes
  useEffect(() => () => { if (dragFrame.current) cancelAnimationFrame(dragFrame.current); }, []);
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
      // a bucket or area pile's gi indexes THAT grouping, not codeGroups —
      // acting through codeGroups[gi] would open an unrelated saved theme. Its
      // member list becomes a plain selection menu instead.
      if (d.pile) {
        const list = (d.list ?? []).filter((c) => c in codebook);
        if (list.length) setMenu({ x: e.clientX, y: e.clientY, sel: list });
        return;
      }
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
  }, [selectionAt, rfSetNodes, codebook]);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => e.preventDefault(), []);
  const [selecting, setSelecting] = useState(false);
  // the Revision plan floats: drag it by its header anywhere on the canvas.
  // The drag paints imperatively (the marquee lesson: no React work per move);
  // state commits once on release, clamped so the header stays reachable.
  const [planPos, setPlanPos] = useState(remembered.planPos);
  useEffect(() => { remembered.planPos = planPos; }, [planPos]);
  const [planMin, setPlanMin] = useState(remembered.planMin);
  useEffect(() => { remembered.planMin = planMin; }, [planMin]);
  const planDragAbort = useRef<AbortController | null>(null);
  useEffect(() => () => planDragAbort.current?.abort(), []);
  const dragPlan = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).closest(".mapPlan") as HTMLElement | null;
    const canvas = panel?.closest(".mapCanvas") as HTMLElement | null;
    if (!panel || !canvas) return;
    const pid = e.pointerId;
    const head = e.currentTarget as HTMLElement;
    const sx = e.clientX - planPos.x, sy = e.clientY - planPos.y;
    let last = planPos;
    let frame = 0;
    // a previous drag still live (missed release) must fully wind down first
    planDragAbort.current?.abort();
    const ac = new AbortController();
    planDragAbort.current = ac;
    const paint = () => { frame = 0; panel.style.transform = `translate(${last.x}px, ${last.y}px)`; };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      ac.abort();
      if (frame) cancelAnimationFrame(frame);
      const c = canvas.getBoundingClientRect();
      setPlanPos({
        x: Math.max(-8, Math.min(last.x, c.width - 120)),
        y: Math.max(-8, Math.min(last.y, c.height - 60)),
      });
    };
    // capture the pointer so a release outside the window still reaches us;
    // lostpointercapture is the catch-all end signal either way
    try { head.setPointerCapture(pid); } catch { /* capture is best-effort */ }
    head.addEventListener("lostpointercapture", finish, { signal: ac.signal });
    window.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== pid) return;
      last = { x: ev.clientX - sx, y: ev.clientY - sy };
      if (!frame) frame = requestAnimationFrame(paint);
    }, { signal: ac.signal });
    window.addEventListener("pointerup", (ev) => { if (ev.pointerId === pid) finish(); }, { signal: ac.signal });
    window.addEventListener("pointercancel", (ev) => { if (ev.pointerId === pid) finish(); }, { signal: ac.signal });
  }, [planPos]);
  const onSelectionStart = useCallback(() => setSelecting(true), []);
  const onSelectionEnd = useCallback(() => setSelecting(false), []);
  // A group is selected when EVERY one of its codes is — brushing a capsule
  // with the marquee gives you the codes you touched, and taking the whole
  // group is a deliberate act (sweep all of it, or Ctrl-click the last one).
  // React Flow's selectionMode is global, so this rule is derived here rather
  // than configured: it also means the rule holds for Ctrl-click, not just
  // the marquee.
  const syncGroupSelection = useCallback(() => {
    rfSetNodes((ns) => {
      const picked = new Set(ns.filter((n) => n.type === "chip" && n.selected).map((n) => n.id));
      const members = new Map<string, string[]>();
      for (const n of ns) if (n.type === "chip" && n.parentId) {
        const list = members.get(n.parentId) ?? [];
        list.push(n.id);
        members.set(n.parentId, list);
      }
      let changed = false;
      const next = ns.map((n) => {
        if (n.type === "chip") return n;
        const mine = members.get(n.id);
        const whole = !!mine?.length && mine.every((c) => picked.has(c));
        if (!!n.selected === whole) return n;
        changed = true;
        return { ...n, selected: whole };
      });
      return changed ? next : ns; // never write for a no-op: this runs on every selection change
    });
  }, [rfSetNodes]);
  const nodeColor = useCallback((n: Node) => n.type === "chip" ? (n as ChipNodeT).data.color : "transparent", []);

  const mergeSel = (menuSel: string[], into: string) => {
    const mergeCode = useStore.getState().mergeCode;
    menuSel.filter((c) => c !== into).forEach((c) => mergeCode(c, into));
    setMenu(null);
  };

  // menu dismissal: any outside press or Escape
  useEffect(() => {
    if (!menu && !confirmAi && !confirmRelayout && !helpOpen && !similar && !confirmFocus && !layoutMenu && !viewMenu) return;
    const close = () => { setMenu(null); setConfirmAi(null); setConfirmRelayout(null); setHelpOpen(false); setConfirmFocus(null); setLayoutMenu(null); setViewMenu(null); };
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      // the help button toggles itself; let its own handler run
      if (!t.closest(".mapMenu") && !t.closest(".mapHelpBtn")) close();
      // the similar results are a NODE on the canvas, not a menu: panning and
      // clicking around the map must not dismiss them. Escape and its own ×
      // close it, like the halo's card.
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); setSimilar(null); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [menu, confirmAi, confirmRelayout, helpOpen, similar, confirmFocus, layoutMenu, viewMenu]);

  return (
    <div id="codemap" className={"view-" + view} style={{ fontSize: sidebarFontSize }}>
      <div className="mapBar">
        <span className="mapTitle">Code map</span>
        <button className="btn iconbtn mapHelpBtn" aria-expanded={helpOpen}
          aria-label={helpOpen ? "Hide how to use the map" : "How to use the map"}
          onClick={() => setHelpOpen((v) => !v)}
          title="How to use the map">
          <Icon name="help" size={15} />
        </button>
        <span className="mapCount">{codes.length} code{codes.length === 1 ? "" : "s"}</span>
        {/* what a drag does HERE — the same motion means three different things
            across the views, and this is the only thing that says which */}
        <span className="mapDragHint" aria-live="off">{spec.drag}</span>
        <span className="mapBarGap" />
        {/* the two work views stay one click away: this is the switch made most
            often, and the menu below holds the same five views */}
        <div className="segmented mapStage" role="radiogroup" aria-label="Working view">
          {(["reconcile", "themes"] as const).map((v) => (
            <button key={v} className={"seg" + (view === v ? " on" : "")} role="radio"
              aria-checked={view === v} onClick={() => switchView(v)}
              title={v === "reconcile"
                ? "Clean the codebook: merge capsules, renames, rejects"
                : "Group the cleaned codebook into theme islands"}>
              {VIEWS[v].label}
            </button>
          ))}
        </div>
        <button className="btn iconlabel mapViewBtn" aria-haspopup="menu" aria-expanded={!!viewMenu}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setViewMenu(viewMenu ? null : { left: r.left, y: r.bottom + 8 });
          }}
          title="Choose what the map shows">
          <span className="blabel">View: {spec.label}</span>
          <Icon name={viewMenu ? "chevron-up" : "chevron-down"} size={13} />
        </button>
        {view === "areas" && (
          <button className="btn" onClick={() => setTopicAiOpen(true)}
            title={topicsStale
              ? "The codebook changed since these areas were worked out — re-run to refresh them"
              : "Ask the AI to work the areas out again"}>
            {topicsStale ? "Areas are stale — re-run…" : "Re-run areas…"}
          </button>
        )}
        {/* each view's own AI verb; the derived views have none */}
        {view === "reconcile" && (
          <button className="btn iconlabel" onClick={() => setAiOpen({ scope: "all" })}
            title="AI proposes merge groups and per-code revisions for your review">
            <Icon name="sparkle" size={15} /> <span className="blabel">Reconcile with AI</span>
          </button>
        )}
        {view === "themes" && (
          <button className="btn iconlabel" onClick={() => setThemeAiOpen(true)}
            title="AI groups the cleaned codebook into theme islands for you to reshape">
            <Icon name="sparkle" size={15} /> <span className="blabel">Group into themes with AI</span>
          </button>
        )}
        <button className="btn iconbtn" aria-label="Move the minimap to the next corner"
          onClick={() => setUi({ mapMinimap: NEXT_CORNER[mapMinimap] })}
          title="Move the minimap to the next corner">
          <Icon name="pip" size={15} />
        </button>
        <button className="btn iconlabel" aria-haspopup="menu" aria-expanded={!!layoutMenu}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setLayoutMenu(layoutMenu ? null : { right: window.innerWidth - r.right, y: r.bottom + 8 });
          }}
          title="Reset or clean up the arrangement you are looking at">
          {/* the caret is how every other menu button in the app says it is a
              menu (Export, Assist) — without it this read as a plain action */}
          <Icon name="refresh" size={15} /> <span className="blabel">Layout</span>
          <Icon name={layoutMenu ? "chevron-up" : "chevron-down"} size={13} />
        </button>
      </div>
      <div className="mapCanvas" ref={canvasRef} tabIndex={-1}
        aria-label={`${spec.label} view. ${spec.drag}.`}>
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
            onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onNodeDrag={onNodeDrag}
            zoomOnDoubleClick={false} deleteKeyCode={null} nodesConnectable={false}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}>
            <Controls showInteractive={false} />
            {/* the MiniMap re-scans the store on every write; unmounting it for
                the duration of a box-drag costs one render at gesture start/end
                instead of aggregate scans per membership change (codex consult) */}
            {!selecting && <MiniMap pannable zoomable position={mapMinimap} nodeColor={nodeColor} />}
            {(focusBusy || focusNote) && (
              <Panel position="top-center" className="mapFocusNote">
                {focusBusy
                  ? <span className="mapNoteGen">Asking where these codes belong…</span>
                  : <>
                      <span>{focusNote!.text}</span>
                      {focusNote!.cost > 0 && <span className="mapFocusCost">${focusNote!.cost.toFixed(4)} · logged</span>}
                      {focusNote!.show && (
                        <button className="btn primary" onClick={() => showNodes(focusNote!.show!)}>
                          {focusNote!.showLabel}
                        </button>
                      )}
                      <button className="btn" onClick={() => setFocusNote(null)}>Dismiss</button>
                    </>}
              </Panel>
            )}
            <RafSelectionMarquee />
            <SelectionHud canEvict={view === "reconcile"} onSelectionChanged={syncGroupSelection} />
            {view === "reconcile" && plan.length > 0 && (
              <Panel position="top-left" className="mapPlan"
                style={{ transform: `translate(${planPos.x}px, ${planPos.y}px)` }}>
                <div className="mapPlanHead" onPointerDown={dragPlan}
                  onDoubleClick={() => setPlanPos({ x: 0, y: 0 })}
                  title="Drag to move this panel; double-click to send it home">
                  <b>Revision plan</b> <span className="mapPlanCount">{plan.length}</span>
                  {!planMin && <>
                    <span className="mapPlanKey">✎ rename · ⊘ reject · merge groups show as halos</span>
                    <button className="btn" title="Apply every remaining proposal"
                      onClick={() => { [...plan].forEach((a) => applyAction(a, false)); earcon.accept(); }}>Accept all</button>
                    <button className="btn" onClick={() => setPlan([])}
                      title="Discard every remaining proposal">Clear</button>
                  </>}
                  <button className="btn iconbtn mapPlanMin" onClick={() => setPlanMin((m) => !m)}
                    aria-expanded={!planMin}
                    aria-label={planMin ? "Expand the revision plan" : "Minimize the revision plan"}
                    title={planMin ? "Expand the revision plan" : "Minimize to just the header"}>
                    {planMin ? "▸" : "▾"}
                  </button>
                </div>
                {!planMin && <div className="mapPlanList nicescroll">
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
                </div>}
              </Panel>
            )}

          </ReactFlow>
        )}
      </div>
      {topicAiOpen && (
        <GroupModal transient
          onClose={() => setTopicAiOpen(false)}
          onReconcileInstead={() => { setTopicAiOpen(false); switchView("reconcile"); }}
          onGroups={(groups) => {
            useStore.getState().setCodeAreas(groups.map((g) => ({ name: g.name, codes: g.codes })), codebookFp);
            setViewOverride("areas");
            requestAnimationFrame(() => fitView({ duration: 200 }));
          }} />
      )}
      {themeAiOpen && (
        <GroupModal
          onClose={() => setThemeAiOpen(false)}
          onReconcileInstead={() => { setThemeAiOpen(false); switchView("reconcile"); }}
          onGroups={(groups) => { useStore.getState().applyThemeGroups(groups); }} />
      )}
      {aiOpen && (
        <ReconcileModal groups={codeGroups} initialScope={aiOpen.scope}
          onClose={() => setAiOpen(false)}
          onPlan={(p: ReconcilePlan, scope) => {
            const st = useStore.getState();
            if (scope === "all") {
              st.applyReconcilePlan(p.clusters, p.actions, true);
            } else if (typeof scope === "object") {
              // focus run: the modal already merged into the pending state
              // (replace-intersecting incl. fresh context targets)
              st.applyReconcilePlan(p.clusters, p.actions, false);
            } else {
              // island-scoped refinement merges into the pending state: pending
              // clusters intersecting the subset are replaced (doc rule)
              const subset = new Set<string>(codeGroups[scope]?.codes ?? []);
              st.applyReconcilePlan(
                mergeScopedClusters(st.codeClusters, subset, p.clusters),
                [...st.codePlan.filter((a) => !subset.has(a.code)), ...p.actions],
                false);
            }
          }} />
      )}
      {confirmFocus && (() => {
        const st = useStore.getState();
        const { focus, context } = focusInputs(confirmFocus.codes);
        const red = redactor(st.ai.redactTerms);
        const inTok = estimateFocusTokens(focus, context, red);
        const model = modelOf(st.ai.model);
        const cost = costOf(model, inTok, estimateTokens(" ".repeat(400)));
        const n = focus.length;
        return (
          <div ref={focusConfirmRef} className="ctxmenu mapMenu mapAiConfirm" role="alertdialog"
            aria-label="Confirm AI request" aria-describedby="focus-confirm-text"
            style={{ left: confirmFocus.x, top: confirmFocus.y, fontSize: sidebarFontSize }}>
            <div className="mapAiConfirmText" id="focus-confirm-text">
              Where {n === 1 ? "does this code" : "do these codes"} belong? Sends {n} code{n === 1 ? "" : "s"} with
              their excerpts <b>plus your other {context.length} codes</b> as possible homes —
              <b> ≈{inTok.toLocaleString()} tokens · ≈${cost.toFixed(4)}</b> to OpenAI ({model.id}).
              Excerpts are participant data.
            </div>
            <div className="mapCardActions">
              <button className="btn primary" autoFocus disabled={focusBusy}
                onClick={() => { const c = confirmFocus.codes; setConfirmFocus(null); void runFocus(c); }}>
                {focusBusy ? "Asking…" : "Send"}
              </button>
              <button className="btn" onClick={() => setConfirmFocus(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {helpOpen && (
        <div className="mapMenu mapHelp" role="dialog" aria-label="How to use the map"
          style={{ fontSize: sidebarFontSize }}>
          <div className="mapHelpHead"><b>The whole codebook at once</b></div>
          <dl className="mapHelpList">
            <dt>Select</dt><dd>Drag a box. Ctrl (Cmd) adds to it.</dd>
            <dt>Pan</dt><dd><b>Space+drag</b>, or middle/right-drag.</dd>
            <dt>Zoom</dt><dd>Wheel, or the +/− controls.</dd>
            <dt>Act on codes</dt><dd>Right-click a selection.</dd>
            <dt>Read a code</dt><dd>Double-click a chip.</dd>
            <dt>Reconcile</dt><dd>A capsule is a proposed merge: drag chips in or out. Its caption names the merged code; the arrow opens the reasoning.</dd>
            <dt>Merge vs group</dt><dd>A <b>merge</b> says these are one code and folds them into one, shrinking the codebook. A <b>group</b> says they are different codes that belong together, and changes nothing about them.</dd>
            <dt>Themes</dt><dd>Drag codes between islands, or an island by its caption.</dd>
            <dt>Views</dt><dd>One list: Reconcile and Themes are where you work, the buckets and AI areas are ways of looking. Each keeps its own layout, and the bar always says what a drag does in the one you are in.</dd>
            <dt>Dragging</dt><dd>Into a group it joins, and lands after the ones already there. Out to open canvas it leaves and stays where you drop it. Onto the catch-all pile it leaves and tidies in.</dd>
            <dt>Layout</dt><dd>Reset packs this view again; Clean up nudges things apart until names stop overlapping.</dd>
          </dl>
          <div className="mapHelpFoot">Esc, or the ? button, closes this.</div>
        </div>
      )}
      {viewMenu && (
        <div ref={viewMenuRef} className="ctxmenu mapMenu mapViewMenu" role="menu" aria-label="Map view"
          style={{ left: viewMenu.left, top: viewMenu.y, fontSize: sidebarFontSize }}>
          {(["work", "explore"] as const).map((g) => (
            <div key={g} className="mapViewGroup">
              {/* the two tiers carry what a flat list of five would lose: these
                  two are phases of the work, those three are ways of looking */}
              <div className="mapMenuHead">{g === "work" ? "Work on the codebook" : "Look at it by"}</div>
              {VIEW_ORDER.filter((v) => VIEWS[v].group === g).map((v) => {
                const s = VIEWS[v];
                const status = v === "reconcile" && clusters.length + plan.length > 0
                  ? `${clusters.length + plan.length} pending`
                  : v === "areas"
                    ? (topicGroups.length === 0 ? "not worked out yet"
                      : `${topicGroups.length} areas${topicsStale ? " · stale" : ""}`)
                    : v === "themes" && codeGroups.length ? `${codeGroups.length} islands` : "";
                return (
                  <button key={v} role="menuitemradio" aria-checked={view === v}
                    className={view === v ? "on" : ""}
                    onClick={() => switchView(v)}>
                    {view === v ? "✓ " : ""}{s.label}
                    <span className="mapMenuNote">{status ? `${status} · ` : ""}{s.drag}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {layoutMenu && (
        <div className="ctxmenu mapMenu mapLayoutMenu" role="menu" aria-label="Layout"
          style={{ right: layoutMenu.right, top: layoutMenu.y, fontSize: sidebarFontSize }}>
          <button role="menuitem" onClick={() => {
            const at = layoutMenu;
            setLayoutMenu(null);
            setConfirmRelayout(at);   // resetting discards hand placement: confirm it
          }}>
            Reset layout
            <span className="mapMenuNote">Back to the packed layout, in this view only</span>
          </button>
          <button role="menuitem" onClick={() => { setLayoutMenu(null); cleanUpLayout(); }}>
            Clean up layout
            <span className="mapMenuNote">Nudge things apart until nothing overlaps at this zoom</span>
          </button>
        </div>
      )}
      {confirmRelayout && (
        <div className="ctxmenu mapMenu mapAiConfirm" role="alertdialog" aria-label="Confirm re-layout"
          aria-describedby="relayout-confirm-text"
          style={{ right: confirmRelayout.right, top: confirmRelayout.y, fontSize: sidebarFontSize }}>
          <div className="mapAiConfirmText" id="relayout-confirm-text">
            Lay the map out fresh? Every chip and group you placed by hand returns to the
            packed layout. <b>One undo step brings it all back.</b>
          </div>
          <div className="mapCardActions">
            <button className="btn primary" autoFocus
              onClick={() => {
                setConfirmRelayout(null);
                if (slot && useStore.getState().resetMapLayout(slot))
                  requestAnimationFrame(() => fitView({ duration: 200 }));
              }}>Re-layout</button>
            <button className="btn" onClick={() => setConfirmRelayout(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirmAi && (() => {
        const st = useStore.getState();
        const red = redactor(st.ai.redactTerms);
        const inputs = glimpseInputs(confirmAi.ci);
        const inTok = estimateGlimpseTokens(inputs, red);
        const model = modelOf(st.ai.model);
        const cost = costOf(model, inTok, estimateTokens(" ".repeat(80)));
        return (
          <div ref={aiConfirmRef} className="ctxmenu mapMenu mapAiConfirm" role="alertdialog" aria-label="Confirm AI request"
            aria-describedby="ai-confirm-text"
            style={{ left: confirmAi.x, top: confirmAi.y, fontSize: sidebarFontSize }}>
            <div className="mapAiConfirmText" id="ai-confirm-text">
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
        <div ref={menuRef} className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => {
            const list = clusters[menu.halo!.ci]?.codes.filter((c) => c in codebook) ?? [];
            openInCodebook(list); setMenu(null);
          }}>
            Open these codes in Codebook
          </button>
          <button role="menuitem" onClick={() => { setConfirmAi({ ci: menu.halo!.ci, x: menu.x, y: menu.y }); setMenu(null); }}>
            AI: describe this group…
          </button>
        </div>
      )}
      {menu && menu.island && (
        <div ref={menuRef} className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
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
        <div ref={menuRef} className="ctxmenu mapMenu" style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => { openInCodebook(menu.sel); setMenu(null); }}>
            Open {menu.sel.length === 1 ? menu.sel[0] : `${menu.sel.length} codes`} in Codebook
          </button>
          {menu.sel.length === 1 && (
            <button role="menuitem" onClick={() => { const c = menu.sel[0]; setMenu(null); openSimilar(c); }}>
              Find similar codes…
            </button>
          )}
          {view === "reconcile" && (
            <button role="menuitem" onClick={() => {
              setConfirmFocus({ codes: menu.sel, x: menu.x, y: menu.y }); setMenu(null);
            }}>
              AI: where {menu.sel.length === 1 ? "does this code" : "do these codes"} belong…
            </button>
          )}
          {/* each view offers only the structural edit it can show */}
          {menu.sel.length > 1 && view === "reconcile" && (
            <button role="menuitem" onClick={() => clusterSelection(menu.sel)}>
              Propose merging these {menu.sel.length} codes
            </button>
          )}
          {menu.sel.length > 1 && view === "themes" && (
            <button role="menuitem" onClick={() => groupSelection(menu.sel)}>
              Group {menu.sel.length} codes together
            </button>
          )}
          {menu.sel.length > 1 && slot !== null && <>
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
