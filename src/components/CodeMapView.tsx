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
import { linesOf, useStore, bestSurvivor, liveCodes, MAP_RING_PX, type DecisionSource, type MapStage } from "../state/store";
import { codeStats } from "../codeStats";
import { speakerBuckets } from "../speakerBuckets";
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
import { cooccurrence, pairOf, companionsOf, type Companion } from "../cooccur";
import { coverageOf, stretchDims, evidence } from "../stretches";
import { findSimilar } from "../similar";
import { sweepWording, refusedPairs, familyReason } from "../sweep";
import { openTailQueue } from "./TailQueue";
import { TellApartModal } from "./TellApartModal";
import { DescribeModal } from "./DescribeModal";
import { estimateSimilarTokens, type SemanticMatch } from "../ai/similar";
import { mergeScopedClusters, dropAction, estimateGlimpseTokens, glimpseCluster, argueAgainst, estimateAgainstTokens, reconcileFocus, mergeFocusResults, estimateFocusTokens, haloIdsFor, nameArea, estimateNameAreaTokens, type CodeAction, type ReconcilePlan } from "../ai/reconcile";
import { useMenuArrows, useMenuToggleFocus } from "../usePopover";
import { SimilarModal } from "./SimilarModal";
import { CodeMenu } from "./CodeMenu";

// chip geometry in WORLD units — the viewport transform scales the world.
// Chips fit their content: width is the measured name plus the count block
// (uniform padding would leave a field of dead air around short names), and
// everything scales with the sidebar text ramp so large accessible settings
// never clip. Rows are shelf-packed toward a near-square map.
const GX = 14, GY = 12, PAD = 18, ISLAND_GAP = 64, HALO_PAD = 26, HALO_GAP = 72;
const chipH = (fs: number) => Math.round(fs * 2.4);
const measurer = document.createElement("canvas").getContext("2d")!;
// `badge` is the proposal mark (✎ / ⊘) that sits between the name and the
// counts. It was not measured, so a chip carrying one was built at the width of
// a chip without one — and .mapChip clips, so the badge pushed the counts out
// of the node and they simply vanished. The node is what should grow.
const chipW = (fs: number, name: string, segs: number, pids: number, badge = false) => {
  const family = getComputedStyle(document.body).fontFamily;
  measurer.font = `600 ${fs}px ${family}`;
  const nameW = measurer.measureText(name).width;
  measurer.font = `700 ${fs}px ${family}`; // the counts render bold
  const counts = measurer.measureText(`${segs}${pids}`).width + fs * 2.6; // icons + inner gaps
  // the glyph itself plus the flex gap it introduces (map.css: .mapChip gap:14px)
  const mark = badge ? measurer.measureText("✎").width + 14 : 0;
  // borders + padding + name/counts gap, with slack — a measured width that
  // comes up 2px short reads as a bug on every single chip
  return Math.round(nameW + counts + mark + 64);
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

type ChipData = { code: string; color: string; segs: number; pids: number; act?: CodeAction;
  /** compare view: the code's evidence split, appended to the tooltip */
  cover?: string };
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
type HaloData = { name: string; renamed: boolean; joins: boolean; ci: number; count: number; open: boolean;
  /** whose idea this merge was — the capsule says so on its face (see SOURCE_MARK) */
  source?: DecisionSource };
type HaloNodeT = Node<HaloData, "halo">;
type CardData = { ci: number; gen: boolean; // gen: a glimpse is being written
  /** how often a PAIR's two codes land on the same lines — cited against the merge */
  co?: number };
type CardNodeT = Node<CardData, "card">;
// the "find similar" results: a node tethered to the code you asked about, so
// it pans and zooms with the map instead of floating over it
type SimilarRow = { name: string; score: number; why: string; band?: "very" | "related" };
type SimilarData = {
  source: string; rows: SimilarRow[]; ticked: Set<string>;
  /** codes that keep landing on the source's lines — companionship, not duplication */
  companions: Companion[];
  ai: "idle" | "busy" | "done"; cost?: number; inTok: number; costEst: number;
  /** what filing these together MEANS in the view you are in, or null where
      nothing files (the derived groupings edit no membership) */
  take: TakeSpec | null;
};
type SimilarNodeT = Node<SimilarData, "similar">;
// the by-definition view's branch: the definition hangs under its chip on a
// stem, always open — text you can select, not a line the chip clips
type DefCardData = { def: string; color: string };
type DefCardNodeT = Node<DefCardData, "defcard">;
type MapNode = ChipNodeT | IslandNodeT | HaloNodeT | CardNodeT | SimilarNodeT | DefCardNodeT;

/** What a node is CALLED — the thing map search matches on, and the only text
    a researcher can be looking for when they type into it. Cards and stems
    have no name of their own; they hang off a chip that does. */
const labelOf = (n: MapNode): string =>
  n.type === "chip" ? n.data.code
    : n.type === "island" || n.type === "halo" ? n.data.name : "";

// THE VIEWS. One value — not a stage crossed with a lens. The old pair could
// express eight situations for a product that has five, and every feature had
// to answer "is this a stage thing or a lens thing?" with "neither, it
// depends". Each view declares what a drag means in it and which layout slot
// it owns; `layout: null` marks a DERIVED view, whose piles come from the data
// rather than from anything you filed. There is no membership to edit there,
// so a CHIP never moves — but the piles themselves rearrange, in the session
// only, because a derived pile drifts as the coding grows.
export type MapView = "reconcile" | "themes" | "areas" | "pids" | "segs" | "defs" | "speaker" | "compare";
type TakeSpec = {
  mode: "merge" | "group" | "area";
  /** the button, e.g. "Group as theme" */
  label: string;
  /** one line saying what it does to the codes, shown above the button */
  what: string;
};
type ViewSpec = {
  label: string;
  /** the one-liner under the label in the Map tab's menu */
  hint: string;
  /** said out loud beside the view name, and announced on every switch */
  drag: string;
  /** the layout slot this view owns, or null when nothing here can move */
  layout: MapStage | null;
  /** Taking a set of similar codes files them the way THIS view files things.
      Merge is not one of these dressed differently: it folds codes into one
      and shrinks the codebook, so it is offered only where merges live. */
  take: TakeSpec | null;
};
const VIEWS: Record<MapView, ViewSpec> = {
  reconcile: {
    // "Consolidate" is the word the methods literature uses for this step and
    // the one this app's own prompts use ("consolidate a first-cycle inductive
    // codebook"). "Reconcile" reads as settling a disagreement between two
    // coders, which is a different thing QuAlly may yet want the word for.
    // The KEY stays `reconcile`: it names a layout slot saved in every
    // project file, and renaming it would cost a migration for nothing.
    label: "Consolidate", hint: "near-duplicate codes fold into one", layout: "reconcile",
    drag: "Dragging a code in or out of a capsule changes what gets merged",
    take: { mode: "merge", label: "Propose a merge", what: "A merge makes them ONE code — it lands as a proposal you can still edit" },
  },
  themes: {
    label: "Themes", hint: "codes filed together as islands", layout: "themes",
    drag: "Dragging a code between islands changes its theme",
    take: { mode: "group", label: "Group as theme", what: "They stay separate codes, filed together as a theme" },
  },
  areas: {
    label: "Areas", hint: "shelves for finding your way around", layout: "areas",
    drag: "Dragging a code files it into an area",
    take: { mode: "area", label: "Group as area", what: "They stay separate codes, filed together in an area" },
  },
  pids: {
    label: "By document count", hint: "which codes span transcripts", layout: null,
    drag: "Drag a group to rearrange; the codes inside stay put",
    take: null,
  },
  segs: {
    label: "By segment count", hint: "where the thin tail is", layout: null,
    drag: "Drag a group to rearrange; the codes inside stay put",
    take: null,
  },
  defs: {
    label: "By definition", hint: "which codes have one, read in place", layout: null,
    drag: "Drag a group to rearrange; the codes inside stay put",
    take: null,
  },
  speaker: {
    label: "By speaker", hint: "whose voice a code lives in", layout: null,
    drag: "Drag a group to rearrange; the codes inside stay put",
    take: null,
  },
  compare: {
    label: "By comparison", hint: "where each code's evidence comes from", layout: null,
    drag: "Drag a group to rearrange; the codes inside stay put",
    take: null,
  },
};
const VIEW_ORDER: MapView[] = ["reconcile", "themes", "areas", "pids", "segs", "defs", "speaker", "compare"];

// The Map tab's menu (Tabs.tsx) is the way into a view now — same shape as the
// Assist menu. It needs the views' names and the current choice without
// mounting the map, so both are exported here where the views live.
export const MAP_VIEW_ITEMS = VIEW_ORDER.map((id) => ({
  id, label: VIEWS[id].label, hint: VIEWS[id].hint, grouping: VIEWS[id].layout === null,
}));
/** what the map would show right now (the session override, else the default
    that follows the work) — for the tab menu's checkmark */
export function currentMapView(pending: number): MapView {
  return remembered.view ?? (pending > 0 ? "reconcile" : "themes");
}
/** pick a view from outside the map: remembered for the next mount, an event
    for a map already on screen (it switches with the camera settle) */
export function openMapView(v: MapView) {
  remembered.view = v;
  window.dispatchEvent(new CustomEvent("qually:mapview", { detail: v }));
  useStore.getState().setActive("map");
}

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
  // which comparison dimensions the compare view divides by (session; null = all)
  compareDims: null as string[] | null,
  // hand-moved PILES in the derived grouping views (session only: the piles
  // themselves drift as coding continues, so remembering them across sessions
  // would pin stale geography). Chips inside never move — only the groups do.
  bucketPos: {} as Partial<Record<MapView, Record<string, { x: number; y: number }>>>,
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
  remembered.bucketPos = {};
  remembered.compareDims = null;
});

const ChipNode = memo(function ChipNode({ data, selected }: NodeProps<ChipNodeT>) {
  const fs = MAP_FS;
  return (
    <div className={"mapChip" + (selected ? " sel" : "")}
      style={{ "--chip-c": data.color } as React.CSSProperties}
      title={`${data.code} — ${data.segs} excerpt${data.segs === 1 ? "" : "s"} in ${data.pids} transcript${data.pids === 1 ? "" : "s"}${data.cover ? `\n${data.cover}` : ""}`}>
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

// Four targets, not a cycle: the old button stepped to "the next corner", so
// putting the minimap somewhere meant clicking until it landed there. Each
// corner is now its own radio, drawn where it puts the minimap; the label
// survives as the tooltip and the accessible name.
const CORNERS = [
  ["top-left", "Top left"], ["top-right", "Top right"],
  ["bottom-left", "Bottom left"], ["bottom-right", "Bottom right"],
] as const;
const RING_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

const openInCodebook = (list: string[]) => {
  preselectBrowse(list);
  useStore.getState().setActive("browse");
};

// The one selection subscriber. A newline-joined id string is its own
// equality check, so this re-renders exactly when membership changes —
// and nothing else in the tree does.
const selectedIdsSel = (s: { nodes: Node[] }) =>
  // containers ride along so that picking a group wakes the sync that adopts
  // its codes; the HUD counts codes only (see `sel` below)
  s.nodes.filter((n) => n.selected).map((n) => n.type + ":" + n.id).join("\n");
function SelectionHud({ canEvict, onSelectionChanged }: { canEvict: boolean; onSelectionChanged: () => void }) {
  const joined = useFlowStore(selectedIdsSel);
  const sel = useMemo(() => (joined ? joined.split("\n")
    .filter((x) => x.startsWith("chip:")).map((x) => x.slice(5)) : []), [joined]);
  useEffect(() => { remembered.selected = new Set(sel); }, [sel]);
  // the one place that already re-renders exactly when chip selection changes
  useEffect(() => { onSelectionChanged(); }, [joined, onSelectionChanged]);
  const clusters = useStore((st) => st.codeClusters);
  const { getNodes, getInternalNode } = useReactFlow();
  // The selected codes as text, one name per line, in the order they are laid
  // out — reading order, top row first, because that is the order the
  // researcher sees and the only one they can predict. (Click order would be
  // the other candidate; react-flow does not keep it, and a marquee has none.)
  const selectedText = useCallback(() => {
    const at = (id: string) => getInternalNode(id)?.internals.positionAbsolute ?? { x: 0, y: 0 };
    // what the chip itself says: the name and its two counts, so a line of the
    // paste carries the same evidence the map showed — not just a bare word
    const say = (id: string) => {
      const d = getNodes().find((n) => n.id === id)?.data as ChipData | undefined;
      if (!d) return id;
      return `${id} (${d.segs} excerpt${d.segs === 1 ? "" : "s"}, ${d.pids} transcript${d.pids === 1 ? "" : "s"})`;
    };
    // rows first: chips packed in a container sit on visual rows, and raw
    // y-sorting would zigzag between two chips a pixel apart in height
    return sel.slice().sort((a, b) => {
      const pa = at(a), pb = at(b);
      return Math.round(pa.y / 24) - Math.round(pb.y / 24) || pa.x - pb.x;
    }).map(say).join("\n");
  }, [sel, getInternalNode, getNodes]);
  const copySelected = () => {
    const t = selectedText();
    if (!t) return;
    const said = `Copied ${sel.length} code name${sel.length === 1 ? "" : "s"}`;
    // No async clipboard (an insecure origin — this app is offline-first and
    // gets served off a LAN address as often as localhost): ask the document
    // to copy instead, which fires the copy event the handler below already
    // fills. Silently doing nothing is the one outcome a copy button must not
    // have.
    if (!navigator.clipboard) {
      if (document.execCommand("copy")) announce(said);
      else announce("Could not copy — press Ctrl+C instead", { assertive: true });
      return;
    }
    navigator.clipboard.writeText(t).then(() => announce(said), () => announce("Could not copy"));
  };
  // Ctrl/Cmd+C with the map open. On the copy EVENT, like the transcript's own
  // copy (App.tsx): it needs no clipboard permission and works where
  // navigator.clipboard is missing. The button above is the same thing for the
  // mouse, and goes through the async API because no event is in flight.
  useEffect(() => {
    if (!sel.length) return;
    const onCopy = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (window.getSelection()?.toString().trim()) return; // a real text selection copies itself
      const t = selectedText();
      if (!t) return;
      e.clipboardData?.setData("text/plain", t);
      e.preventDefault();
      announce(`Copied ${sel.length} code name${sel.length === 1 ? "" : "s"}`);
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [sel, selectedText]);
  // the keyboard path for eviction: dragging out is pointer-only, this is not.
  // Only offered in the Reconcile view — capsules are not drawn anywhere else,
  // so eviction would have no visible effect.
  const inMerge = sel.filter((c) => clusters.some((x) => x.codes.includes(c)));
  const evictSelected = () => {
    if (!inMerge.length) return;
    // ONE undo entry for the gesture (store rule), and a staggered landing
    // spot per code: dropping them all on one point left only the top chip
    // hittable. Landing spots are computed from the state BEFORE any
    // eviction — the first eviction can thin a two-member capsule away, and
    // its other member still deserves the position it was promised.
    const st0 = useStore.getState();
    const drops = inMerge.map((code, k) => {
      const ci = st0.codeClusters.findIndex((x) => x.codes.includes(code));
      // the capsule is addressed by the cluster's id, like everywhere else
      const cid = ci >= 0 ? st0.codeClusters[ci].cid : undefined;
      const halo = ci >= 0 ? getNodes().find((x) => x.id === `halo:${cid ?? `i${ci}`}`) : undefined;
      const pos = halo
        ? { x: halo.position.x + (halo.width ?? 0) + 28, y: halo.position.y + k * 40 }
        : { x: 0, y: k * 40 };
      return { code, pos };
    });
    useStore.getState().pushUndo();
    // fresh state each pass: membership indices shift as capsules thin away
    for (const d of drops) useStore.getState().reconcileDrop(d.code, d.pos, null, false);
    earcon.evict();
    announce(`Removed ${inMerge.length} code${inMerge.length === 1 ? "" : "s"} from their merge groups`);
  };
  return (
    // bottom-center, unconditionally: every corner is somebody's parking spot
    // (minimap, zoom controls, the toolbar), and a HUD that hops corners as
    // the minimap moves was its own visual artifact. The centre of the bottom
    // edge belongs to nothing else, so the actions are always in one place.
    <Panel position="bottom-center" className="mapSelPanel"
      style={{ visibility: sel.length > 0 ? "visible" : "hidden" }}>
      <span className="mapSelCount">{sel.length} selected</span>
      {inMerge.length > 0 && canEvict && (
        <button className="btn" onClick={evictSelected}
          title="Move the selected codes out of their merge groups (they park beside them)">
          Remove from merge
        </button>
      )}
      <button className="btn" onClick={copySelected}
        title="Copy the selected code names, one per line (Ctrl+C)">Copy names</button>
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
// The map does not ride the app's text-size ramp: it has its own zoom, and a
// setting meant for reading surfaces was scaling half the canvas (chips,
// captions) while the controls stayed put. One fixed size; zoom is the scale.
const MAP_FS = 13;

const zoomSel = (s: { transform: [number, number, number] }) => s.transform[2];
// Moving a group by hand is pointer-only otherwise, and precision dragging is
// exactly what magnification makes expensive. Same window-event idiom the card
// toggle uses, so the node needs no callback threaded through React Flow.
const moveIsland = (id: string, dx: number, dy: number) =>
  window.dispatchEvent(new CustomEvent("qually:moveisland", { detail: { id, dx, dy } }));
const ARROW: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
/** arrow keys nudge the group; Shift takes a bigger step */
const islandArrowKeys = (id: string) => (e: React.KeyboardEvent) => {
  const d = ARROW[e.key];
  if (!d) return;
  e.preventDefault();
  e.stopPropagation();          // RF pans the canvas on arrows otherwise
  const step = e.shiftKey ? 100 : 20;
  moveIsland(id, d[0] * step, d[1] * step);
};
const IslandNode = memo(function IslandNode({ id, data }: NodeProps<IslandNodeT>) {
  const zoom = useFlowStore(zoomSel);
  const fs = MAP_FS;
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
  // an areas-view pile is the researcher's own shelf, not a derived bucket —
  // it renames and dissolves like a theme island, writing to codeAreas
  const isArea = !!data.pile && data.ai !== undefined && data.ai >= 0;
  const bare = data.gkey ?? data.name; // the name without the "· count" suffix
  const rename = () => {
    setEditing(false);
    const st = useStore.getState();
    const name = draft.trim();
    if (isArea) {
      if (!name || st.codeAreas[data.ai!]?.name === name) return;
      if (st.codeAreas.some((g, i) => i !== data.ai && g.name === name)) {
        announce("An area with that name already exists.", { assertive: true }); return;
      }
      st.setCodeAreas(st.codeAreas.map((g, i) => (i === data.ai ? { ...g, name } : g)), st.codeAreasFp);
      return;
    }
    if (!name || st.codeGroups[data.gi]?.name === name) return; // no change, no history entry
    st.setCodeGroups(st.codeGroups.map((g, i) => (i === data.gi ? { ...g, name } : g)));
  };
  const dissolve = () => {
    const st = useStore.getState();
    if (isArea) {
      // the shelf goes; its codes fall back to Unassigned
      st.setCodeAreas(st.codeAreas.filter((_, i) => i !== data.ai), st.codeAreasFp);
      return;
    }
    st.setCodeGroups(st.codeGroups.filter((_, i) => i !== data.gi));
  };
  return (
    <div className={"mapIsland" + (data.gi === -1 ? " loose" : "")}>
      <div className="mapIslandLabel" style={{ fontSize }}>
        {(data.pile && !isArea) || data.gi === -1 ? (
          // a derived pile has no name to edit, but it still moves — so the
          // caption is focusable for the arrow keys and says so
          <span className={"mapIslandName" + (data.gi === -1 ? " loose" : "")}
            tabIndex={0} role="button" ref={spanRef}
            aria-label={`${data.name}. Arrow keys move this group, Shift for a bigger step`}
            title="Drag, or focus and use the arrow keys, to move this group"
            onKeyDown={islandArrowKeys(id)}>{data.name}</span>
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
            <span className="mapIslandName" title="Drag or arrow-key to move the group; double-click or Enter to rename"
              tabIndex={0} role="button" ref={spanRef}
              aria-label={`${data.name}. Enter renames; arrow keys move this group`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "F2" || e.key === " ") { e.preventDefault(); setDraft(bare); setEditing(true); return; }
                islandArrowKeys(id)(e);
              }}
              onDoubleClick={() => { setDraft(bare); setEditing(true); }}>{data.name}</span>
            <button className="mapIslandX nodrag"
              title={isArea ? "Dissolve this area (codes go back to Unassigned)" : "Dissolve this group (codes stay)"}
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
// the card is a React Flow node; the dialog belongs to the view around it
// It carries the cluster's cid, never its index: the merge answer prunes the
// capsule itself (mergeInto drops a two-member cluster with a dead member),
// and an index captured when the dialog opened would then name whatever
// proposal slid into its place. The survivor rides along so the answer merges
// in the direction the capsule was already showing.
const countRed = (inputs: MergeCodeInput[], red: ReturnType<typeof redactor>) =>
  inputs.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0);

const tellApart = (cid: number | undefined, codes: [string, string], survivor: string,
  newName?: string, source?: DecisionSource, model?: string) =>
  window.dispatchEvent(new CustomEvent("qually:tellapart", { detail: { cid, codes, survivor, newName, source, model } }));
const HaloNode = memo(function HaloNode({ data }: NodeProps<HaloNodeT>) {
  const zoom = useFlowStore(zoomSel);
  const fs = MAP_FS;
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
    <div className={"mapHalo" + (data.source ? " src-" + data.source : "")}>
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
        {/* a hand-edited project file can carry a source this build has never
            heard of; an unknown one says nothing rather than reaching Icon
            with a name that is not in PATHS */}
        {data.source && SOURCE_MARK[data.source] && (
          <span className={"mapHaloSrc " + data.source} title={SOURCE_MARK[data.source].label}
            aria-label={SOURCE_MARK[data.source].label}>
            <Icon name={SOURCE_MARK[data.source].icon} size={Math.round(fontSize * 0.8)} />
          </span>
        )}
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
  const canAccept = c.codes.length >= 2;
  const skip = () => { st().dismissCluster(data.ci); earcon.skip(); };
  // the glimpse described a membership; if the group changed since, say so
  // rather than silently presenting an outdated description
  const stale = !!c.desc && !!c.descCodes &&
    [...c.codes].sort().join("\n") !== [...c.descCodes].sort().join("\n");
  const againstStale = !!c.against && !!c.againstCodes &&
    [...c.codes].sort().join("\n") !== [...c.againstCodes].sort().join("\n");
  return (
    <div className="mapCardNode nodrag nowheel">
      <div className="mapCardRat">{c.rationale}</div>
      {/* offline counter-evidence: two codes deliberately laid on the same
          moments are usually two lenses, not one idea typed twice */}
      {data.co !== undefined && data.co >= 2 && (
        <div className="mapCardCo">
          These two land on the same lines {data.co}× — co-coding often marks two
          different things about one moment.
        </div>
      )}
      {(c.against || c.againstWeak) && (
        // the case against sits with the case for, not in a dialog you dismiss
        // before deciding — and a shrug is drawn as a shrug, not as an objection
        <div className={"mapCardAgainst" + (c.againstWeak ? " weak" : "")}>
          <span className="mapNoteWho">
            {c.againstWeak ? "No real case against" : "The case against"}
            {againstStale && <span className="mapGlimpseStale" title="The group's members changed after this was written — ask again for a fresh one">may be outdated</span>}
          </span>
          <div>{c.against}</div>
        </div>
      )}
      {(data.gen || c.desc) && (
        <div className="mapCardGlimpse">
          <span className="mapNoteWho">AI glimpse{stale && <span className="mapGlimpseStale" title="The group's members changed after this was written — re-run “Describe this group” for a fresh one">may be outdated</span>}</span>
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
        {c.codes.length === 2 && (
          // only for a pair: the question is "what separates THESE two", and
          // three codes at once is a different, worse question
          <button className="btn" onClick={() => tellApart(c.cid, c.codes as [string, string], c.survivor, c.newName, c.source, c.model)}
            title="Read both sides and write the line between them — or find that you cannot">
            Tell them apart…
          </button>
        )}
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
  // The panel is a thing ON the map, not a control floating above it: it
  // takes the zoom like a chip does, shrinking as you pull back and growing
  // as you come in. It counter-scaled once, to hold one readable size — but a
  // panel that stays 330px while the codebook shrinks to a smudge stops being
  // part of the picture, and reading it is what zooming in is FOR.
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
    <div className="mapSimNode nodrag nowheel">
      <div className="mapSimHead">
        <b>Similar to “{data.source}”</b>
        <button className="mapNoteX" aria-label="Close" onClick={() => simEvent("close")}>×</button>
        <span>{data.rows.length} of {liveCodes(codebook).length - 1} codes · {n} ticked</span>
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
      {data.companions.length > 0 && (
        // the other axis: not "spelled the same" but "used together" — these
        // are theme material, which is why there is no checkbox here: folding
        // a companion into a merge is exactly the mistake this list prevents
        <div className="mapSimCo">
          <div className="mapSimCoHead">On the same lines <span>· theme material, not merge</span></div>
          {data.companions.slice(0, 6).map((c) => (
            <div key={c.name} className="mapSimCoRow">
              <b>{c.name}</b>
              <span>{c.count}× · {c.pids} transcript{c.pids === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
      )}
      {/* two lines: the act, then what it costs in smaller type — one long
          wrapping line read as a paragraph, not a button */}
      {data.ai !== "done" && (
        <button className="btn mapSimAi" disabled={data.ai === "busy"} onClick={() => simEvent("ai")}>
          <span className="mapSimAiAct">
            <Icon name="sparkle" size={16} />
            {data.ai === "busy" ? "Reading the codebook…" : "Find semantic matches"}
          </span>
          {data.ai !== "busy" && (
            <span className="mapSimAiCost">≈{data.inTok.toLocaleString()} tokens · ≈${data.costEst.toFixed(4)}</span>
          )}
        </button>
      )}
      {data.ai === "done" && data.cost != null && (
        <div className="mapSimNote">AI pass done · ${data.cost.toFixed(4)} · logged</div>
      )}
      {/* ONE filing action, the one this view can show. Offering merge and
          group side by side made the same panel mean different things in
          different views — and in a view with neither, both were nonsense. */}
      {n > 0 && data.take && (
        <div className="mapSimNote mapSimChoice">{data.take.what}</div>
      )}
      <div className="mapCardActions">
        {data.take && (
          <button className="btn primary" disabled={!n} onClick={() => simEvent("take", data.take!.mode)}
            title={data.take.what}>
            {data.take.label}{n ? ` (${n + 1})` : ""}
          </button>
        )}
        {/* the same count as the filing button: both act on the source code
            plus everything ticked */}
        <button className="btn" disabled={!n} onClick={() => simEvent("select")}
          title="Select these on the map and close">Select{n ? ` (${n + 1})` : ""}</button>
      </div>
    </div>
  );
});
const DefCardNode = memo(function DefCardNode({ data }: NodeProps<DefCardNodeT>) {
  return (
    <div className="mapDefCard nodrag nowheel" style={{ "--chip-c": data.color } as React.CSSProperties}>
      {data.def}
    </div>
  );
});

const nodeTypes = { chip: ChipNode, island: IslandNode, halo: HaloNode, card: CardNode, similar: SimilarNode, defcard: DefCardNode };

// A capsule is a proposal, and where it came from changes how much of your
// attention it has earned. Icon first (colour is never the only carrier here,
// and the map is already full of colour), the same three icons the rest of the
// app uses: a sparkle for the model, two sheets for the offline wording pass,
// a hand-drawn pencil for one you made yourself.
const SOURCE_MARK: Record<DecisionSource, { icon: string; label: string }> = {
  ai: { icon: "sparkle", label: "Proposed by the AI" },
  wording: { icon: "copy", label: "Matched on wording, on this machine" },
  you: { icon: "pencil", label: "You proposed this merge" },
};

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

// A selected chip's 2px border is world ink: at 0.1 zoom it paints at 0.2px
// and the selection — the one thing a low-vision researcher must be able to
// find on a 178-code canvas — simply vanishes. This spends a constant ~6px of
// SCREEN ink on a ring, priced in world units here and read by the .sel rules
// in map.css as one CSS length on the flow container. One subscription total:
// the chips never watch the zoom themselves, so only the few selected
// elements restyle when it changes — nothing new rides the drag path.
function SelectionRingScale() {
  const zoom = useFlowStore(zoomSel);
  const px = MAP_RING_PX[useStore((s) => s.ui.mapRing)];
  const flowStore = useFlowStoreApi();
  useEffect(() => {
    // priced in world units so it PAINTS at `px` screen pixels whatever the
    // camera is doing. The ceiling only matters if the zoom range ever
    // deepens: it keeps a far-out camera from burying the tiny map under ring
    // paint, and rides the chosen weight so it never crops the setting.
    flowStore.getState().domNode?.style.setProperty(
      "--map-ring", `${Math.min(px * 10, px / zoom).toFixed(2)}px`);
  }, [zoom, px, flowStore]);
  return null;
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

// The find marks, reconciled AFTER React Flow paints. They are DOM classes on
// RF's node wrappers (a match changes nothing about what a node IS, and node
// data would churn the whole flow per keystroke) — but RF rewrites those
// wrappers' classNames on select and drag, and a layout rebuild (rfSetNodes)
// or view switch swaps the DOM set, and both silently wiped classes set from
// a plain effect (which also ran BEFORE the rebuild committed, marking DOM
// about to be thrown away). Subscribing to the flow store re-runs this after
// every commit RF makes, so the marks are re-asserted over whatever it just
// painted; class toggles that change nothing are no-ops, so the steady state
// costs one read pass. Mounted only while find is open; unmounting sweeps.
function FindMarks({ canvas, hits, cur }: {
  canvas: { current: HTMLDivElement | null }; hits: string[]; cur?: string;
}) {
  // Subscribed to the node ids PLUS their selected/dragging bits, joined —
  // not the nodes array. A drag rewrites that array every frame, and a full
  // DOM pass per frame is the one thing this component must not cost; but
  // React Flow rewrites a wrapper's className when selection or dragging
  // flips, wiping the imperative marks with the id string unchanged — so
  // those two bits are exactly the extra edges that must retrigger it.
  // (Same string-identity trick SelectionHud uses above.)
  useFlowStore((s: { nodes: Node[] }) =>
    s.nodes.map((n) => n.id + (n.selected ? "+s" : "") + (n.dragging ? "+d" : "")).join("\n"));
  useEffect(() => {           // deliberately undepped: reconcile after EVERY render
    const el = canvas.current;
    if (!el) return;
    const want = new Map(hits.map((id) => [id, id === cur]));
    for (const n of el.querySelectorAll<HTMLElement>(".react-flow__node")) {
      const w = want.get(n.dataset.id ?? "");
      n.classList.toggle("findMatch", w === false);
      n.classList.toggle("findHit", w === true);
    }
  });
  useEffect(() => {
    const el = canvas.current;
    return () => {
      for (const n of el?.querySelectorAll(".findMatch, .findHit") ?? [])
        n.classList.remove("findMatch", "findHit");
    };
  }, [canvas]);
  return null;
}

function MapInner() {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const stretches = useStore((s) => s.stretches);
  // the comparison axes the compare view divides by — mix and match; a code
  // files under the JOINED values of every ticked dimension it has evidence in
  const [compareOn, setCompareOnState] = useState(remembered.compareDims);
  // EVIDENCE only: an unreviewed proposal must not put a new axis on the map,
  // nor split a code's excerpts under a boundary nobody has agreed to
  // (coverageOf holds the same line internally — see stretches.ts)
  const allDims = useMemo(() => stretchDims(evidence(stretches)), [stretches]);
  const activeDims = useMemo(
    () => (compareOn ?? allDims).filter((d) => allDims.includes(d)),
    [compareOn, allDims]);
  const toggleCompareDim = (d: string) => {
    const cur = new Set(activeDims);
    cur.has(d) ? cur.delete(d) : cur.add(d);
    if (!cur.size) return; // at least one axis stays on
    const next = allDims.filter((x) => cur.has(x));
    remembered.compareDims = next; setCompareOnState(next);
    // the regrouped piles land elsewhere; bring them on screen, with margin
    // enough that the top caption clears the floating pill
    requestAnimationFrame(() => requestAnimationFrame(() => fitView({ duration: 200, padding: 0.15 })));
  };
  const [compareMenu, setCompareMenu] = useState<{ left: number; y: number } | null>(null);
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const ai = useStore((s) => s.ai);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const dark = useStore((s) => s.ui.dark);
  const mapMinimap = useStore((s) => s.ui.mapMinimap);
  const mapRing = useStore((s) => s.ui.mapRing);
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
  const [aiOpen, setAiOpen] = useState<
    false | { scope: number | "all" | { focus: string[] }; selected?: string[] }>(false);
  const [themeAiOpen, setThemeAiOpen] = useState(false);
  const [confirmRelayout, setConfirmRelayout] = useState<{ left: number; y: number } | null>(null);
  const [layoutMenu, setLayoutMenu] = useState<{ left: number; y: number } | null>(null);
  // the map's own settings: they live HERE rather than in the Settings modal
  // because both are judged by eye against the codes on screen, and a modal
  // covers the thing you are judging
  const [mapSetMenu, setMapSetMenu] = useState<{ left: number; y: number } | null>(null);
  const mapSetRef = useKeepOnScreen<HTMLDivElement>([mapSetMenu]);
  const layoutRef = useKeepOnScreen<HTMLDivElement>([layoutMenu]);
  // the chrome menus are reachable by keyboard, so they owe the keyboard the
  // usual contract: focus moves in on open and back to the button on close
  const mapSetBtn = useRef<HTMLButtonElement>(null);
  const layoutBtn = useRef<HTMLButtonElement>(null);
  const compareBtn = useRef<HTMLButtonElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  useMenuToggleFocus(!!mapSetMenu, mapSetRef, mapSetBtn);
  useMenuToggleFocus(!!layoutMenu, layoutRef, layoutBtn);
  useMenuToggleFocus(!!compareMenu, compareRef, compareBtn);
  const mapSetArrows = useMenuArrows(mapSetRef);
  const layoutArrows = useMenuArrows(layoutRef);
  const compareArrows = useMenuArrows(compareRef);
  const relayoutRef = useKeepOnScreen<HTMLDivElement>([confirmRelayout]);
  // the gestures used to sit in the bar as a paragraph; they are reference,
  // not something to read every session, so they live behind a button
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useKeepOnScreen<HTMLDivElement>([menu]);
  const menuArrows = useMenuArrows(menuRef);
  // no trigger button: these open by right-click (or the keyboard's context-menu
  // key) on a canvas node, and focus returns to whatever held it — without the
  // focus-in the arrows above could never reach the menu at all
  useMenuToggleFocus(!!menu, menuRef);
  // "find similar codes": a ranked panel at the cursor. Local matches appear
  // instantly; the AI pass is a second, paid step inside the same panel.
  const [similar, setSimilar] = useState<null | {
    source: string; rows: SimilarRow[]; companions: Companion[];
    ticked: Set<string>; ai: "idle" | "busy" | "done"; cost?: number;
  }>(null);
  const similarSource = similar?.source ?? "";
  // One request snapshot feeds the map's quote and, if approved, the modal's
  // preview, accounting and dispatch. The focus excerpts were once assembled
  // only after the quote, which made the consent price describe a smaller call.
  const similarRequest = useMemo(() => {
    if (!similarSource) return null;
    const book = liveCodes(codebook).filter((name) => name !== similarSource)
      .map((name) => ({ name, def: codebook[name]?.def ?? "" }));
    const focus: MergeCodeInput = {
      name: similarSource, def: codebook[similarSource]?.def ?? "", excerpts: [],
    };
    for (const seg of segments) {
      if (seg.status !== "accepted" || seg.code !== similarSource || !transcripts[seg.pid]) continue;
      if (focus.excerpts.length >= 4) break;
      const ex = segExcerpt(seg, linesOf(transcripts, lang, seg.pid)).excerpt;
      if (ex) focus.excerpts.push(ex);
    }
    return { source: similarSource, focus, book };
  }, [similarSource, codebook, segments, transcripts, lang]);
  const [similarGate, setSimilarGate] = useState<typeof similarRequest>(null);
  // the quote for the optional AI pass, using the request the gate will show
  const simTokens = useMemo(() => {
    if (!similarRequest) return { inTok: 0, cost: 0 };
    const red = redactor(ai.redactTerms);
    const inTok = estimateSimilarTokens(similarRequest.focus, similarRequest.book, red);
    return { inTok, cost: costOf(modelOf(ai.model), inTok, estimateTokens(" ".repeat(240))) };
  }, [similarRequest, ai]);
  // the areas view is project data: it survives a reload and travels in the file
  const topicGroups = useStore((s) => s.codeAreas);
  const topicFp = useStore((s) => s.codeAreasFp);
  // the codebook's IDENTITY, not the map's display order: `codes` is sorted by
  // excerpt count, so accepting one excerpt would reorder it and cry stale
  const codebookFp = useMemo(() => Object.keys(codebook).sort().join("\n"), [codebook]);
  const topicsStale = topicFp !== codebookFp;
  const [topicAiOpen, setTopicAiOpen] = useState(false);
  const [openCards, setOpenCards] = useState<Set<number>>(remembered.openCards);
  useEffect(() => { remembered.openCards = openCards; }, [openCards]);
  const [genCi, setGenCi] = useState<number | null>(null);
  // one cost gate, two questions: describing the group and arguing against it
  // send the same payload and differ only in what they ask of it
  const [confirmAi, setConfirmAi] = useState<
    { ci: number; x: number; y: number; ask: "describe" | "against" } | null>(null);
  const aiConfirmRef = useKeepOnScreen<HTMLDivElement>([confirmAi]);
  // "where do these belong": the same one-line consent the group description
  // uses. The full modal was the wrong weight for a question you ask often.
  const [confirmFocus, setConfirmFocus] = useState<{ codes: string[]; x: number; y: number } | null>(null);
  const [confirmArea, setConfirmArea] = useState<{ codes: string[]; x: number; y: number } | null>(null);
  // the by-definition view's way into the Definitions assist, preselected
  const [describeFor, setDescribeFor] = useState<string[] | null>(null);
  const areaConfirmRef = useKeepOnScreen<HTMLDivElement>([confirmArea]);
  const [areaBusy, setAreaBusy] = useState(false);
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
  // "tell them apart" opens over the map, from a capsule's own card
  type ApartAsk = { cid?: number; codes: [string, string]; survivor: string; newName?: string;
    source?: DecisionSource; model?: string };
  const [apart, setApart] = useState<ApartAsk | null>(null);
  useEffect(() => {
    const onApart = (e: Event) => setApart((e as CustomEvent<ApartAsk>).detail);
    window.addEventListener("qually:tellapart", onApart);
    return () => window.removeEventListener("qually:tellapart", onApart);
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
    const onAi = () => openSimilarAiRef.current?.();
    const onTake = (e: Event) => takeSimilarRef.current?.((e as CustomEvent<"merge" | "group" | "area">).detail);
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
  const openSimilarAiRef = useRef<() => void>(null);
  const takeSimilarRef = useRef<(m: "merge" | "group" | "area") => void>(null);
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
  // Bumps when session pile positions are RESET or CLEANED UP — `remembered`
  // lives outside React, so the layout memo needs a dep that changes to
  // rebuild from it. A pointer drag deliberately does NOT bump: see the note
  // at its branch in onNodeDragStop.
  const [bucketRev, setBucketRev] = useState(0);
  useEffect(() => { remembered.view = viewOverride; }, [viewOverride]);
  const view: MapView =
    viewOverride ?? (clusters.length + plan.length > 0 ? "reconcile" : "themes");
  const spec = VIEWS[view];
  // the layout slot this view owns; null means nothing here moves
  const slot = spec.layout;
  // arrow-key group moves land here and take whichever route the view owns:
  // the store's layout slot, or the session's pile positions. Same two paths the
  // pointer drop uses, so a keyboard move is not a second kind of move.
  useEffect(() => {
    const onMove = (e: Event) => {
      const { id, dx, dy } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
      const n = getNodes().find((x) => x.id === id);
      if (!n) return;
      const pos = { x: n.position.x + dx, y: n.position.y + dy };
      rfSetNodes((ns) => ns.map((x) => (x.id === id ? { ...x, position: pos } : x)));
      if (slot) useStore.getState().applyMapLayout({}, { [id]: pos }, 1, slot);
      else remembered.bucketPos[view] = { ...(remembered.bucketPos[view] ?? {}), [id]: pos };
    };
    window.addEventListener("qually:moveisland", onMove);
    return () => window.removeEventListener("qually:moveisland", onMove);
  }, [getNodes, rfSetNodes, slot, view]);
  const setPlan = useCallback((updater: CodeAction[] | ((p: CodeAction[]) => CodeAction[])) => {
    const st = useStore.getState();
    st.setCodePlan(typeof updater === "function" ? updater(st.codePlan) : updater);
  }, []);

  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  // which codes share lines — keyed on segments alone: the layout memo below
  // rebuilds on every card fold and drag-drop, and re-sweeping all segments
  // each time was the most expensive thing in it
  const cooc = useMemo(() => cooccurrence(segments), [segments]);
  // biggest first: the codes doing the most work anchor the top of the map
  // codes you set aside are off the map too — the map IS the working codebook
  const codes = useMemo(() =>
    liveCodes(codebook).sort((a, b) =>
      (stats[b]?.segs ?? 0) - (stats[a]?.segs ?? 0) || a.localeCompare(b)),
    [codebook, stats]);

  // Two stages, one canvas. Themes: islands (groups) as before. Reconcile:
  // constellations — each pending cluster is a circular parent node with the
  // survivor at the center and members on the orbit; codes in no cluster pack
  // as a flat field below. Parents precede children (RF sub-flow rule).
  const layout = useMemo(() => {
    const fs = MAP_FS;
    const ch = chipH(fs);
    const family = getComputedStyle(document.body).fontFamily; // read once per rebuild
    // the badge is part of the chip, so it is part of the chip's width — read
    // here, before the packing, from the same plan the node renders from, and
    // gated on the same VIEW the stylesheet gates the glyph on (map.css hides
    // it outside reconcile). Widening for a glyph that is not drawn leaves a
    // hole between the name and the counts, and display:none takes the flex gap
    // with it, so nothing fills the space that was measured for it.
    const marked = view === "reconcile"
      ? new Set(plan.filter((a) => a.action !== "merge").map((a) => a.code))
      : new Set<string>();
    const widths = new Map(codes.map((c) =>
      [c, chipW(fs, c, stats[c]?.segs ?? 0, stats[c]?.pids ?? 0, marked.has(c))]));
    const pack = (list: string[], targetW: number, dimsOf?: (c: string) => { w: number; h: number }) => {
      let x = 0, y = 0, maxW = 0, rowH = 0;
      const pos: Record<string, { x: number; y: number }> = {};
      for (const c of list) {
        const { w, h } = dimsOf ? dimsOf(c) : { w: widths.get(c)!, h: ch };
        // rows are as tall as their tallest member — definitions vary in length
        if (x > 0 && x + w > targetW) { x = 0; y += rowH + GY; rowH = 0; }
        pos[c] = { x, y };
        x += w + GX;
        rowH = Math.max(rowH, h);
        maxW = Math.max(maxW, x - GX);
      }
      return { pos, w: maxW, h: list.length ? y + rowH : 0 };
    };
    const near = (list: string[]) => {
      const area = list.reduce((a, c) => a + (widths.get(c)! + GX) * (ch + GY), 0);
      return Math.max(460, Math.sqrt(area) * 1.5);
    };
    // on the MAP, not merely in the codebook: a code you set aside has no chip,
    // so a cluster or island still listing it would pack against a width that
    // does not exist and lay the whole row out on NaN
    const inBook = (c: string) => c in codebook && !codebook[c].parked;
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
        // a world-unit gap below the chip: panel and stem scale together, so
        // the 14px stem drawn by .mapSimNode::before bridges it at any zoom
        position: { x: abs.x, y: abs.y + (host.height ?? ch) + 14 },
        width: Math.max(330, fs * 24),
        draggable: false, selectable: false, focusable: false,
        zIndex: 20,
        data: { ...similar, inTok: simTokens.inTok, costEst: simTokens.cost, take: spec.take },
      };
      return [...ns, node];
    };
    const actOf = new Map(plan.map((a) => [a.code, a]));
    // A chip INSIDE a container is packed, always: its coordinates carry no
    // meaning there, so a hand position is neither read nor kept. A FREE chip
    // is the opposite — its position is the only thing carrying intent, so the
    // stored one wins over the packer's.
    const hand = slot ? mapPositions[slot] : {};
    const chipNode = (c: string, position: { x: number; y: number }, parentId?: string, cover?: string): ChipNodeT => ({
      id: c,
      type: "chip" as const,
      position: parentId ? position : hand[c] ?? position,
      ...(parentId ? { parentId } : {}),
      width: widths.get(c)!, height: ch,
      selected: remembered.selected.has(c),
      draggable: slot !== null,
      data: { code: c, color: codebook[c]?.color || "#999", segs: stats[c]?.segs ?? 0, pids: stats[c]?.pids ?? 0, act: actOf.get(c),
        ...(cover ? { cover } : {}) },
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
      // `key` separates a pile's IDENTITY from its drawn name, for the groupings
      // whose labels a participant could collide with (a speaker named "Mixed")
      piles: { name: string; key?: string; list: string[]; ai?: number;
        /** the by-definition view: each chip in this pile grows a definition
            branch under it, so its cell is as tall as its definition */
        def?: (c: string) => string;
        /** compare view: the code's evidence split, for the chip tooltip */
        cover?: (c: string) => string }[],
      opts: {
        islandId: (p: { name: string; key?: string; ai?: number }) => string; movable: boolean; freeChips?: string[];
        /** positions for piles moved by hand when the view has no store slot
            (the grouping views park them in the session) */
        stored?: Record<string, { x: number; y: number }>;
      },
    ) => {
      // a defined chip's cell: as wide as chip or branch, as tall as both
      const DEF_W = 300, DEF_STEM = 12;
      // Measured by the DOM itself, not re-derived: every estimate of the
      // card's wrap (chars, then canvas greedy-wrap) disagreed with CSS by a
      // line whenever fonts, spacing, or shaping differed — and the row below
      // sat on the card's last line. So render each definition off-screen in
      // the REAL .mapDefCard class at the real width and read offsetHeight:
      // the reserved cell is the drawn card, by construction. One hidden
      // holder, one layout flush for all of them.
      const defHs = new Map<string, number>();
      {
        const withDefs = piles.filter((g) => g.def);
        if (withDefs.length) {
          const holder = document.createElement("div");
          holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${DEF_W}px;font-size:${fs}px;`;
          const order: string[] = [];
          for (const g of withDefs) for (const c of g.list) {
            const d = document.createElement("div");
            d.className = "mapDefCard";
            d.textContent = g.def!(c);
            holder.appendChild(d);
            order.push(c);
          }
          document.body.appendChild(holder);
          [...holder.children].forEach((el, i) => defHs.set(order[i], (el as HTMLElement).offsetHeight));
          holder.remove();
        }
      }
      const defH = (c: string) => defHs.get(c) ?? Math.round(chipH(fs) * 1.6);
      const defDims = () => (c: string) => ({
        w: Math.max(widths.get(c)!, DEF_W),
        h: ch + DEF_STEM + defH(c),
      });
      const blocks = piles.map((g, gi) => ({
        name: g.name, key: g.key, gi, list: g.list, ai: g.ai, def: g.def, cover: g.cover,
        ...(g.def
          ? pack(g.list, Math.max(700, Math.ceil(Math.sqrt(g.list.length)) * (DEF_W + GX)), defDims())
          : pack(g.list, near(g.list))),
        // the caption reads "name · count" and carries no buttons
        cap: captionBox(fs, 1, 7, `${g.name} · ${g.list.length}`, 1, family),
      }));
      const rowW = Math.max(900, Math.sqrt(blocks.reduce((a, b) => a + (Math.max(b.w + 2 * PAD, b.cap.w) + ISLAND_GAP) * (b.h + 2 * PAD + ISLAND_GAP), 0)) * 1.4,
        ...blocks.map((b) => b.cap.w));
      const islands: IslandNodeT[] = [];
      const children: (ChipNodeT | DefCardNodeT)[] = [];
      const stored = opts.stored ?? (opts.movable && slot ? mapIslandPos[slot] : {});
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
          // selectable AND draggable by its whole body: a group is a thing you
          // can grab, not a caption with a decoration under it. Its selected
          // state stays derived from its members (see syncGroupSelection), so
          // a marquee that clips two of five chips never carries the group off.
          draggable: opts.movable, selectable: opts.movable, focusable: false,
          data: { name: `${b.name} · ${b.list.length}`, gi: b.gi, pile: true, list: b.list, gkey: b.name,
            ...(b.ai !== undefined ? { ai: b.ai } : {}) },
        });
        for (const c of b.list) {
          if (b.def) {
            // the branch: not selectable, not draggable — a reading surface
            // tethered under its chip, wearing the chip's colour. Pushed
            // BEFORE the chip: siblings share a z (react-flow levels children
            // to parent+1), so paint order is array order — and the card's
            // stem pokes up through the gap to the chip, where drawn after it
            // crossed the chip's selection ring
            children.push({
              id: `def:${c}`, type: "defcard" as const, parentId: key,
              position: { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y + ch + DEF_STEM },
              width: DEF_W, height: defH(c),
              selectable: false, draggable: false, focusable: false,
              data: { def: b.def(c), color: codebook[c]?.color || "#999" },
            } as DefCardNodeT);
          }
          children.push(chipNode(c, { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y }, key, b.cover?.(c)));
        }
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
        islandId: (p) => `bucket:${p.name}`, movable: true,
        stored: remembered.bucketPos[view] ?? {},
      })) };
    }

    // BY DEFINITION: the map as a worklist for Draft definitions
    if (view === "defs") {
      const defOf = (c: string) => (codebook[c]?.def ?? "").trim();
      const has = (c: string) => defOf(c).length > 0;
      // defined codes carry their definition on the chip — the view's point is
      // reading the book, not just counting the gap
      const piles = [
        { name: "Defined", list: codes.filter(has), def: defOf },
        { name: "Undefined", list: codes.filter((c) => !has(c)) },
      ];
      return { nodes: withSimilar(pileNodes(piles.filter((g) => g.list.length > 0), {
        islandId: (p) => `bucket:${p.name}`, movable: true,
        stored: remembered.bucketPos[view] ?? {},
      })) };
    }

    // BY SPEAKER: whose voice a code lives in. The rule lives in
    // speakerBuckets.ts so the majority boundary is testable without a canvas.
    // BY COMPARISON: where a code's evidence comes from, across one declared
    // dimension's stretches. A code files under the value carrying MOST of its
    // accepted segments (the tooltip shows the full split); evidence outside
    // every stretch is "unmarked". No stretches yet → everything unmarked, and
    // the pile's name says how to change that.
    if (view === "compare") {
      // one coverage per ticked dimension; a code's pile is the JOINED argmax
      // values ("baseline · phase 1"), skipping dims it has no marked evidence
      // in — so a code with only a condition still files under its condition
      const covs = activeDims.map((d) => ({ d, cov: coverageOf(segments, stretches, d) }));
      // argmax over LABELLED values only: a code with 10 unmarked segments and
      // 3 baseline ones has condition evidence, and must not file identically
      // to a code with none — unmarked bulk never outvotes a label (the
      // tooltip still shows the full split, unmarked included)
      const argmax = (m: Map<string, number> | undefined) => {
        if (!m) return "";
        let best = "", n = -1;
        for (const [v, k] of m) { if (!v) continue; if (k > n || (k === n && v < best)) { best = v; n = k; } }
        return best;
      };
      const partsOf = (c: string) => covs.map(({ cov }) => argmax(cov.get(c))).filter(Boolean);
      const tipOf = (c: string) => {
        const bits = covs.map(({ d, cov }) => {
          const m = cov.get(c);
          if (!m) return null;
          return `${d}: ` + [...m.entries()].sort((a, b) => b[1] - a[1])
            .map(([v, k]) => `${v || "unmarked"} ${k}`).join(" · ");
        }).filter(Boolean);
        return bits.length ? bits.join("\n") : "no accepted evidence";
      };
      const byLabel = new Map<string, string[]>();
      for (const c of codes) {
        const label = partsOf(c).join(" · ");
        const arr = byLabel.get(label) ?? [];
        arr.push(c);
        byLabel.set(label, arr);
      }
      const piles = [...byLabel.entries()]
        .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
        .map(([v, list]) => ({
          name: v || (stretches.length ? "unmarked" : "unmarked — select lines in a transcript and right-click to mark stretches"),
          key: `${activeDims.join("+")}:${v || "\u0000unmarked"}`, list, cover: tipOf,
        }));
      return { nodes: withSimilar(pileNodes(piles, {
        islandId: (p) => `bucket:${p.key ?? p.name}`, movable: true,
        stored: remembered.bucketPos[view] ?? {},
      })) };
    }

    if (view === "speaker") {
      const piles = speakerBuckets(codes, segments, transcripts);
      return { nodes: withSimilar(pileNodes(
        piles.map((p) => ({ name: p.label, key: p.key, list: p.codes })), {
          islandId: (p) => `bucket:${p.key ?? p.name}`, movable: true,
          stored: remembered.bucketPos[view] ?? {},
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
        // the derived catch-all gets a RESERVED id: a stored area the
        // researcher happens to name "Unassigned" must not collide with it —
        // two nodes sharing an id file drops against the wrong `ai`
        islandId: (p) => (p.ai === -1 ? "area:\u0000unassigned" : `area:${p.name}`),
        movable: true, freeChips: free,
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
        // keyed by the cluster's own id, never its index: accepting the third
        // proposal must not hand the fourth capsule the third's parking spot
        const key = `halo:${b.c.cid ?? `i${b.c.ci}`}`;
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
          draggable: true, selectable: true, focusable: false,
          data: {
            name: b.c.newName ?? b.c.survivor, renamed: !!b.c.newName,
            // norm(), not exact equality: acceptance resolves the target with
            // norm(), so a case/whitespace variant of an outside code IS a
            // silent three-way merge and must show "joins existing"
            joins: !!b.c.newName && Object.keys(codebook).some((k) =>
              norm(k) === norm(b.c.newName!) && !b.c.codes.some((m) => norm(m) === norm(k))),
            ci: b.c.ci, count: b.c.codes.length, open: openCards.has(b.c.ci),
            // a proposal from before provenance was recorded says nothing
            // rather than claiming to be yours
            source: b.c.source,
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
            // floor matches .mapCardNode's min-width:400px, so RF's box for
            // the node is the box the card actually paints
            width: Math.max(400, Math.min(420, b.w - 24)),
            data: { ci: b.c.ci, gen: genCi === b.c.ci,
              ...(b.c.codes.length === 2
                ? { co: pairOf(cooc, b.c.codes[0], b.c.codes[1])?.count } : {}) },
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
        draggable: true, selectable: true, focusable: false,
        data: { name: b.name, gi: b.gi },
      });
      for (const c of b.list) children.push(chipNode(c, { x: PAD + b.pos[c].x, y: PAD + b.pos[c].y }, key));
      ix += stepW + ISLAND_GAP;
      rowH = Math.max(rowH, bh);
    }
    for (const c of looseFree) children.push(chipNode(c, { x: 0, y: 0 }));
    // parents strictly before children (RF sub-flow requirement)
    return { nodes: withSimilar([...islands, ...children] as MapNode[]) };
    // `spec.take` left out deliberately: this memo re-packs every chip and halo
    // on the map, and the effect at the bottom of this file excludes
    // similar.ticked for the same reason — ticking one checkbox must not
    // re-layout a 178-code map. NOT audited beyond that; see FUTURE.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes, codebook, stats, cooc, codeGroups, plan, clusters, view, slot, mapPositions, mapIslandPos, openCards, genCi, segments, transcripts, topicGroups, similar, simTokens, bucketRev, stretches, activeDims]);
  const build = useCallback(() => layout.nodes, [layout]);

  const canvasRef = useRef<HTMLDivElement>(null);
  // ── Find on the map ────────────────────────────────────────────────────
  // The map is the one view where "where is that code?" has no answer without
  // panning around hunting for it. Same contract as the transcript's search
  // (Ctrl+F, Enter steps, Esc closes), and the same reason Figma's works: it
  // MOVES you — every hit is a camera trip, not a row in a list you then have
  // to find by eye.
  const [find, setFind] = useState<{ q: string; i: number } | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => {
    const q = find?.q.trim().toLowerCase();
    if (!q) return [] as string[];
    // reading order — top row first, left to right. Chips inside a container
    // carry positions relative to it, so absolute coordinates are accumulated
    // in one pass (parents are emitted strictly before their children).
    const abs = new Map<string, { x: number; y: number }>();
    const found: { id: string; x: number; y: number }[] = [];
    for (const n of layout.nodes) {
      const p = n.parentId ? abs.get(n.parentId) : undefined;
      const at = { x: (p?.x ?? 0) + n.position.x, y: (p?.y ?? 0) + n.position.y };
      abs.set(n.id, at);
      if (labelOf(n).toLowerCase().includes(q)) found.push({ id: n.id, ...at });
    }
    // banded by row before x: two chips a pixel apart in height are on the
    // same row to the eye, and raw y-sorting would zigzag between them
    found.sort((a, b) => Math.round(a.y / 24) - Math.round(b.y / 24) || a.x - b.x);
    return found.map((f) => f.id);
  }, [layout, find?.q]);
  // the hit list changes under a live query (typing, or a merge landing) —
  // never leave the cursor past its end
  const at = hits.length ? Math.min(find?.i ?? 0, hits.length - 1) : 0;
  const stepFind = (d: number) =>
    setFind((f) => (f && hits.length ? { ...f, i: (at + d + hits.length) % hits.length } : f));
  // Fly to the current hit — and only when the DESTINATION changes (new query
  // text, or a step). `hits` gets a fresh identity every time `layout`
  // recomputes (a card opening, a chip dropped, an AI result landing), and a
  // flight on mere identity yanked the camera back to the hit mid-gesture.
  // The trip is deferred one frame: a rebuild landing in the same flush (the
  // rfSetNodes effect below) has then committed, so fitView is never aimed at
  // a node id React Flow does not hold yet — that trip was a silent no-op.
  // (The marks themselves are FindMarks' job, rendered with the strip below.)
  const flown = useRef("");
  // the zoom the researcher chose (see the flight below); a flight of OURS
  // ending must not be mistaken for them choosing a new one. A timestamp, not
  // a boolean: rapid steps overlap flights, and d3 fires no end event for the
  // interrupted one — a flag would come out of step and stay wrong, where a
  // stale deadline heals itself the moment the last flight lands.
  const findWantZoom = useRef<number | null>(null);
  const findFlightUntil = useRef(0);
  useEffect(() => {
    const cur = hits[at];
    const trip = cur ? (find?.q.trim() ?? "") + "\u0000" + cur : ""; // NUL: never in a code name
    if (trip === flown.current) return;
    flown.current = trip;
    if (!cur) return;
    requestAnimationFrame(() => {
      if (flown.current !== trip) return; // superseded while the frame waited
      // The researcher's zoom is theirs: they set it because that is the size
      // they can read at, and a trip that zooms out and back in on every step
      // (fitView's smooth flight) made stepping matches feel like turbulence.
      // So: ONE motion, straight to the hit, at their zoom — unless the hit
      // does not fit at that zoom (a wide island), in which case zoom out
      // exactly enough to hold it, and the next fitting hit is back at theirs.
      const inner = getInternalNode(cur);
      const el = canvasRef.current;
      if (!inner || !el) return;
      const { x, y } = inner.internals.positionAbsolute;
      const w = inner.measured?.width ?? inner.width ?? 0;
      const h = inner.measured?.height ?? inner.height ?? 0;
      const vw = el.clientWidth, vh = el.clientHeight;
      // THEIR zoom, not the current one: a previous hop that had to zoom out
      // for a wide island must not become the new normal — the next hit that
      // fits at the zoom the researcher chose goes back to it. The ref is
      // cleared whenever they zoom by hand (onMoveEnd), so "their zoom" is
      // always the last one they actually set.
      const z0 = findWantZoom.current ?? getZoom();
      findWantZoom.current = z0;
      const zFit = Math.min((vw * 0.85) / Math.max(w, 1), (vh * 0.85) / Math.max(h, 1));
      const z = Math.max(0.1, Math.min(z0, zFit)); // never zoom IN uninvited
      // reduced motion: the CSS kill-switch cannot reach a d3 transition, so
      // the trip itself asks — an instant cut says the same thing motionless
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      findFlightUntil.current = performance.now() + (still ? 0 : 320) + 120;
      void setViewport(
        { x: vw / 2 - (x + w / 2) * z, y: vh / 2 - (y + h / 2) * z, zoom: z },
        { duration: still ? 0 : 320, interpolate: "linear" });
    });
  }, [hits, at, find?.q, getInternalNode, setViewport, getZoom]);
  const closeFind = useCallback(() => {
    findWantZoom.current = null;
    setFind(null); // FindMarks unmounts with the strip and sweeps its marks
    canvasRef.current?.focus();
  }, []);
  // Ctrl+F, from anywhere on the map. App's handler owns it on a transcript
  // and steps aside here (it checks the active tab), so this is the only
  // listener that answers — and it must, or the browser's own find opens over
  // a canvas whose text it cannot see.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== "f" && e.key !== "F")) return;
      // A dialog on top owns the keyboard, and a find strip opening BEHIND one
      // breaks its focus trap — the researcher would be typing into something
      // they cannot see. The modal is theirs to close first. (.mapFind is in
      // that list too, so this is also what makes a second Ctrl+F a no-op
      // rather than a re-select of a field that is already focused.)
      if (document.querySelector(".about-backdrop, .modal-backdrop, [role=dialog], .palette-backdrop")) return;
      e.preventDefault();
      setHelpOpen(false); setLayoutMenu(null); setMapSetMenu(null); setCompareMenu(null);
      // and the canvas popovers: their Escape listener runs in the capture
      // phase, so leaving one open would make the first Escape close IT and
      // the find strip need a second one
      setMenu(null); setConfirmAi(null); setConfirmRelayout(null); setConfirmFocus(null); setConfirmArea(null);
      setSimilar(null);
      setFind((f) => f ?? { q: "", i: 0 });
      findRef.current?.select();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { if (find) findRef.current?.focus(); }, [find !== null]);  // eslint-disable-line react-hooks/exhaustive-deps

  // built once per mount; RF owns the array from here (uncontrolled). When the
  // codebook changes under the map (a merge, a rename, new codes), rebuild —
  // dragged chips keep their place via remembered.positions.
  const [initialNodes] = useState(build);
  // which view's nodes React Flow actually holds RIGHT NOW. getNodes() after a
  // view switch returns the PREVIOUS layout until this effect lands, and a
  // stale-but-non-empty node set sailed straight through every settle loop —
  // wrong pile counts announced, cameras framing a layout that no longer exists
  const committedView = useRef(view);
  useEffect(() => { rfSetNodes(build()); committedView.current = view; }, [build, rfSetNodes, view]);

  // plan strip verdicts (renames and rejects only — merges are halos). One
  // earcon per GESTURE: "Accept all" silences the per-item marks and plays a
  // single confirmation, else N simultaneous envelopes stack into clipping.
  const applyAction = (a: CodeAction, sound = true) => {
    const st = useStore.getState();
    // the change FIRST — renameCode/rejectCode push the gesture's ONE undo
    // entry, with the plan row still in the snapshot, so Ctrl+Z brings the
    // rename back AND puts its row back on the plan. Then the row leaves
    // silently (setState, not setCodePlan — no second undo entry). A rename
    // rewrote the remaining entries to the new name, so drop both spellings;
    // dropAction keys by code, which survives the object churn.
    if (a.action === "rename") st.renameCode(a.code, a.newName!, a.rationale, a.source, a.model);
    else if (a.action === "remove") st.rejectCode(a.code, a.rationale, a.source, a.model);
    useStore.setState({
      codePlan: dropAction(dropAction(useStore.getState().codePlan, a.code), a.newName ?? a.code),
    });
    if (sound) (a.action === "remove" ? earcon.reject : earcon.accept)();
  };
  const skipAction = (a: CodeAction) => {
    setPlan((ps) => dropAction(ps, a.code));
    // the noes are part of the record too (see dismissCluster)
    useStore.getState().logDecision({
      kind: "dismiss", codes: [a.code], source: a.source ?? "you",
      ...(a.model ? { model: a.model } : {}),
      why: a.rationale || `A proposed ${a.action}, turned down`,
    });
    earcon.skip();
  };

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
      const ex = segExcerpt(seg, linesOf(st.transcripts, st.ui.lang, seg.pid)).excerpt;
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
    const call = {
      model: st.ai.model, task: "glimpse", pid: "(codebook)",
      lines: inputs.length, redactions: countRed(inputs, red),
    };
    // the capsule's id, taken NOW: the answer lands seconds later, and an
    // index held across that gap names whatever proposal slid into its place
    // if a merge or a dismissal reordered the list in between
    const cid = st.codeClusters[ci]?.cid;
    // the glimpse streams into the card — open it so the loading pulse shows
    setOpenCards((old) => new Set(old).add(ci));
    setGenCi(ci);
    earcon.aiStart();
    try {
      const { glimpse, usage } = await glimpseCluster({
        key, model: st.ai.model, codes: inputs, redaction: red,
      });
      const s2 = useStore.getState();
      // by id, and only if the capsule still stands — a description of a
      // proposal that was settled mid-flight has nowhere honest to land
      if (cid !== undefined && s2.codeClusters.some((c) => c.cid === cid))
        s2.setCodeClusters(s2.codeClusters.map((c) =>
          (c.cid === cid ? { ...c, desc: glimpse, descCodes: [...c.codes] } : c)));
      s2.logAiCall({
        at: new Date().toISOString(), ...call,
        inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
      });
      announce("Group description ready.");
      earcon.aiDone();
    } catch (e) {
      useStore.getState().logAiIncomplete(e, call);
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      announce(`Describe failed: ${msg}`, { assertive: true });
      earcon.error();
    } finally {
      // only clear a pulse this run still owns: a second question started on
      // another capsule mid-flight must not lose its pulse to this finish
      setGenCi((cur) => (cur === ci ? null : cur));
    }
  }, [glimpseInputs]);

  // The critic: same payload as the glimpse, opposite question. It goes into
  // the card beside the reasoning, because the case against a merge belongs
  // next to the case for it — not in a dialog you dismiss before deciding.
  const runAgainst = useCallback(async (ci: number) => {
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const red = redactor(st.ai.redactTerms);
    const inputs = glimpseInputs(ci);
    const call = {
      model: st.ai.model, task: "against", pid: "(codebook)",
      lines: inputs.length, redactions: countRed(inputs, red),
    };
    // same id-not-index discipline as the glimpse: see runGlimpse
    const cid = st.codeClusters[ci]?.cid;
    setOpenCards((old) => new Set(old).add(ci));
    setGenCi(ci);
    earcon.aiStart();
    try {
      const { against, weak, usage } = await argueAgainst({
        key, model: st.ai.model, codes: inputs, redaction: red,
      });
      const s2 = useStore.getState();
      if (cid !== undefined && s2.codeClusters.some((c) => c.cid === cid))
        s2.setCodeClusters(s2.codeClusters.map((c) =>
          (c.cid === cid ? { ...c, against, againstWeak: weak, againstCodes: [...c.codes] } : c)));
      s2.logAiCall({
        at: new Date().toISOString(), ...call,
        inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
      });
      announce(weak ? "No real case against this merge." : "The case against this merge is on the card.");
      earcon.aiDone();
    } catch (e) {
      useStore.getState().logAiIncomplete(e, call);
      const msg = e instanceof AiError ? e.message : (e as Error).message;
      announce(`Could not argue: ${msg}`, { assertive: true });
      earcon.error();
    } finally {
      setGenCi((cur) => (cur === ci ? null : cur));
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
    const book = liveCodes(st.codebook).map((name) => ({ name, def: st.codebook[name]?.def ?? "" }));
    const rows = findSimilar(source, book).map((m) => ({ ...m }));
    // companions come back norm'd; the panel speaks display names
    const display = new Map(book.map((x) => [norm(x.name), x.name]));
    const companions = companionsOf(cooccurrence(st.segments), source)
      .flatMap((c) => { const d = display.get(c.name); return d ? [{ ...c, name: d }] : []; });
    setSimilar({
      source, rows, companions, ai: "idle",
      // codes already filed stay unticked: taking one is a deliberate act
      ticked: new Set(rows.filter((m) => !homeOf(m.name)).map((m) => m.name)),
    });
    announce(rows.length
      ? `${rows.length} code${rows.length === 1 ? "" : "s"} with similar wording to ${source}`
      : `No codes share wording with ${source}. Ask the AI for semantic matches.`);
  }, [homeOf]);
  // The paid second look is protected by the same full disclosure gate as the
  // other AI assists. Its result still lands in the tethered map panel, where
  // the researcher decides what (if anything) to do with it.
  const openSimilarAi = useCallback(() => {
    if (similarRequest) setSimilarGate(similarRequest);
  }, [similarRequest]);
  const landSimilarAi = useCallback((source: string, matches: SemanticMatch[], cost: number) => {
    setSimilar((s) => {
      if (!s || s.source !== source) return s;
      // the AI's list leads; a local-only match keeps its place below
      const seen = new Set(matches.map((m) => m.name));
      const merged = [
        ...matches.map((m) => ({ name: m.name, score: m.band === "very" ? 0.95 : 0.6, why: m.why, band: m.band })),
        ...s.rows.filter((r) => !seen.has(r.name)),
      ];
      const ticked = new Set(s.ticked);
      for (const m of matches) if (m.band === "very" && !homeOf(m.name)) ticked.add(m.name);
      return { ...s, rows: merged, ticked, ai: "done", cost };
    });
  }, [homeOf]);
  // acting on the ticked rows: the source code always rides along, and any
  // code taken from another group or merge leaves it (one entry, undoable)
  const takeSimilar = useCallback((mode: "merge" | "group" | "area") => {
    const cur = similar;
    if (!cur) return;
    const st = useStore.getState();
    // The panel is a snapshot: a code can be renamed, merged, deleted or set
    // aside while it is open — from the map's own menu, a keystroke away — and
    // acting on a name that is no longer in the book writes a cluster or a group
    // around something that does not exist. Checked against the book as it is
    // NOW, not as it was when the search ran.
    const live = new Set(liveCodes(st.codebook));
    const picked = [...cur.ticked].filter((c) => live.has(c));
    if (!picked.length || !live.has(cur.source)) return;
    const members = [cur.source, ...picked];
    if (mode === "merge") {
      const clusters = st.codeClusters
        .map((c) => ({ ...c, codes: c.codes.filter((x) => !members.includes(x)) }))
        .filter((c) => c.codes.length >= 2);
      const next = [...clusters, {
        survivor: bestSurvivor(st, members), codes: members,
        rationale: `Found by searching for codes similar to “${cur.source}”.`,
        // the offline pass matched on wording; the AI pass that can extend the
        // list is what makes a row say "AI proposal" instead
        source: (cur.ai === "done" ? "ai" : "wording") as DecisionSource,
      }];
      st.setCodeClusters(next);
      earcon.join();
      announce(`Proposed merging ${members.length} codes into one — showing it on the map`);
      // take the researcher to the proposal, or nothing appears to have happened
      showNodes(haloIdsFor(useStore.getState().codeClusters, [next[next.length - 1]]), "reconcile", null);
    } else if (mode === "area") {
      // Areas are usually an AI pass, but a hand-made one is the same shape —
      // and the fingerprint stays as it was: this does not make the AI's areas
      // any more or less current than they already were.
      const areas = st.codeAreas
        .map((g) => ({ ...g, codes: g.codes.filter((x) => !members.includes(x)) }))
        .filter((g) => g.codes.length > 0);
      // unique like makeArea: two areas sharing a name would share a node id
      let label = cur.source;
      let n = 2;
      while (areas.some((g) => g.name === label)) label = `${cur.source} ${n++}`;
      st.setCodeAreas([...areas, { name: label, codes: members }], st.codeAreasFp);
      earcon.join();
      announce(`Filed ${members.length} codes in a new area “${label}” — showing it on the map`);
      showNodes([`area:${label}`], "areas", null);
    } else {
      const groups = st.codeGroups
        .map((g) => ({ ...g, codes: g.codes.filter((x) => !members.includes(x)) }))
        .filter((g) => g.codes.length > 0);
      st.setCodeGroups([...groups, { name: cur.source, codes: members }]);
      earcon.join();
      announce(`Grouped ${members.length} codes as “${cur.source}” — showing it on the map`);
      // islands live in the Themes stage: land there, or the group is made and
      // the map looks unchanged
      showNodes([`island:${useStore.getState().codeGroups.length - 1}`], "themes", null);
    }
    setSimilar(null);
    // showNodes is re-made per render; listing it would re-run this on every
    // render. Not judged further — see FUTURE.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const ex = segExcerpt(seg, linesOf(st.transcripts, st.ui.lang, seg.pid)).excerpt;
      if (ex) { arr.push(ex); byCode.set(seg.code, arr); }
    }
    const mk = (name: string) => ({ name, def: st.codebook[name]?.def ?? "", excerpts: byCode.get(name) ?? [] });
    return {
      focus: [...focusSet].map(mk),
      context: liveCodes(st.codebook).filter((c) => !focusSet.has(c)).map(mk),
    };
  }, []);
  // The offline pass over the WHOLE book: free, keyless, and every proposal it
  // makes carries the words it matched on. Offered before the AI button
  // because it clears the half of the work that needs no judgement, and
  // because a researcher without a key gets nothing else book-wide.
  const runSweep = useCallback(() => {
    const st = useStore.getState();
    const book = liveCodes(st.codebook).map((name) => ({ name, def: st.codebook[name]?.def ?? "" }));
    const fams = sweepWording(book, {
      // codes already inside a pending capsule are left alone, and a pair you
      // turned down before is not put back in front of you
      skip: new Set(st.codeClusters.flatMap((c) => c.codes)),
      refused: refusedPairs(st.ledger),
    });
    if (!fams.length) {
      earcon.nothing();
      announce(st.codeClusters.length
        ? "No new wording matches beyond what is already proposed."
        : "No wording matches — nothing in the book is spelled nearly the same.", { assertive: true });
      return;
    }
    const fresh = fams.map((f) => ({
      survivor: bestSurvivor(st, f.codes),
      codes: f.codes,
      rationale: familyReason(f),
      source: "wording" as DecisionSource,
    }));
    st.setCodeClusters([...st.codeClusters, ...fresh]);
    earcon.accept();
    const one = fams.length === 1;
    announce(`${fams.length} wording match${one ? "" : "es"} proposed — `
      + `${fams.filter((f) => f.tier === "typed-twice").length} where one name's words sit inside the other's. `
      + `Nothing is merged until you accept it.`, { assertive: true });
    setViewOverride("reconcile");
    // take the researcher to what just appeared, or the map looks unchanged
    requestAnimationFrame(() =>
      showNodes(haloIdsFor(useStore.getState().codeClusters, fresh), "reconcile", null));
    // mount-only on purpose: this subscribes once and reads the store live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A hand-made area: same shape as the AI's, same rule as the similar panel's
  // "file as an area" — other areas give the codes up, the fingerprint stays
  // (this makes the AI's areas no more or less current than they were).
  const makeArea = useCallback((sel: string[], name?: string, about?: string) => {
    const st = useStore.getState();
    const others = st.codeAreas
      .map((g) => ({ ...g, codes: g.codes.filter((c) => !sel.includes(c)) }))
      .filter((g) => g.codes.length > 0);
    let label = (name ?? "").trim() || "New area";
    let n = 2;
    while (others.some((g) => g.name === label)) label = `${(name ?? "").trim() || "New area"} ${n++}`;
    // the FIRST area on a blank wall stamps the current codebook: nothing
    // existed to be stale, and "" would read as stale forever. Later hand
    // edits keep the stored fp — they make the AI's areas no more or less
    // current than they were.
    const fp = st.codeAreas.length === 0
      ? Object.keys(st.codebook).sort().join("\n") : st.codeAreasFp;
    st.setCodeAreas([...others, { name: label, codes: sel, ...(about ? { rationale: about } : {}) }], fp);
    earcon.join();
    announce(`Filed ${sel.length} code${sel.length === 1 ? "" : "s"} in “${label}”${name ? "" : " — double-click the caption to name it"}`);
    showNodes([`area:${label}`], "areas", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showNodes is declared below (stable enough; same idiom as runSweep)
  }, []);
  const runNameArea = useCallback(async (sel: string[]) => {
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const codes = focusInputs(sel).focus;
    if (!codes.length) return;
    const red = redactor(st.ai.redactTerms);
    const call = {
      model: st.ai.model, task: "areas", pid: `(name area: ${codes.length} codes)`,
      lines: codes.length, redactions: countRed(codes, red),
    };
    setAreaBusy(true);
    earcon.aiStart();
    announce("Asking for a name for this area…");
    try {
      const r = await nameArea({ key, model: st.ai.model, codes, redaction: red });
      st.logAiCall({
        at: new Date().toISOString(), ...call,
        inTok: r.usage.inTok, outTok: r.usage.outTok, costUsd: +r.usage.costUsd.toFixed(5),
      });
      earcon.aiDone();
      makeArea(sel, r.name, r.about);
    } catch (e) {
      useStore.getState().logAiIncomplete(e, call);
      earcon.error();
      announce(`Could not name the area: ${e instanceof Error ? e.message : String(e)}`, { assertive: true });
    } finally {
      setAreaBusy(false);
    }
  }, [focusInputs, makeArea]);

  const runFocus = useCallback(async (codes: string[]) => {
    const st = useStore.getState();
    const key = getKey();
    if (!key) { announce("No API key set. Add one in Settings → AI.", { assertive: true }); return; }
    const { focus, context } = focusInputs(codes);
    if (!focus.length || !context.length) { announce("Nothing to compare these against.", { assertive: true }); return; }
    const red = redactor(st.ai.redactTerms);
    const inputs = [...focus, ...context];
    const call = {
      model: st.ai.model, task: "reconcile", pid: `(focus: ${focus.length} codes)`,
      lines: inputs.length, redactions: countRed(inputs, red),
    };
    setFocusBusy(true);
    earcon.aiStart();
    announce(`Asking where ${focus.length} code${focus.length === 1 ? "" : "s"} belong…`);
    try {
      const r = await reconcileFocus({ key, model: st.ai.model, focus, context, redaction: red });
      const s2 = useStore.getState();
      const merged = mergeFocusResults(s2.codeClusters, s2.codePlan, r.plan, new Set(r.reviewed));
      s2.applyReconcilePlan(merged.clusters, merged.actions, false, "ai", st.ai.model);
      s2.logAiCall({
        at: new Date().toISOString(), ...call,
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
      useStore.getState().logAiIncomplete(e, call);
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
  // `say`: what to announce once the camera has landed. The three take-paths
  // already say what they DID ("Filed 3 codes in a new area…"), and a second
  // message a beat later just overwrites the first in the live region — so
  // they pass null and keep their own sentence.
  // one settle loop at a time: switchView and showNodes both wait on the next
  // layout, and a superseded loop left running would announce (and frame) the
  // wrong thing when its gate finally opened
  const settleFrame = useRef(0);
  const showNodes = useCallback((ids: string[], wanted: MapView = "reconcile",
    say: string | null = "auto") => {
    if (!ids.length) return;
    setViewOverride(wanted);
    cancelAnimationFrame(settleFrame.current);
    let tries = 0;
    const tick = () => {
      // getNodes() must be showing the wanted VIEW, not merely something:
      // the previous layout is non-empty too (see committedView)
      const live = committedView.current === wanted ? getNodes().filter((n) => ids.includes(n.id)) : [];
      if (!live.length) {
        if (tries++ < 12) settleFrame.current = requestAnimationFrame(tick);
        return;
      }
      void fitView({ nodes: live.map((n) => ({ id: n.id })), padding: 0.35, duration: 420, maxZoom: 1.1 });
      // the chips inside also carry the selection, so the answer is legible
      // the moment the camera lands
      const pick = new Set(live.flatMap((n) =>
        n.type === "halo" ? getNodes().filter((x) => x.parentId === n.id).map((x) => x.id) : [n.id]));
      rfSetNodes((ns) => ns.map((n) => ({ ...n, selected: n.type === "chip" && pick.has(n.id) })));
      if (say === "auto") announce(`Showing ${live.length === 1 ? "the proposal" : `${live.length} proposals`} on the map`);
      else if (say) announce(say);
    };
    settleFrame.current = requestAnimationFrame(tick);
  }, [getNodes, fitView, rfSetNodes]);

  // Switching view: keep the ZOOM. Every switch used to fitView, which on 178
  // codes lands near 20% where nothing is readable — the losing-your-place bug.
  // The camera only moves when the new layout left you looking at empty canvas,
  // and then it pans (same zoom) to the content rather than zooming out to it.
  const switchView = useCallback((next: MapView) => {
    if (next === view) return;
    setViewOverride(next);
    cancelAnimationFrame(settleFrame.current);
    let tries = 0;
    const settle = () => {
      const el = canvasRef.current;
      const ns = committedView.current === next ? getNodes().filter((n) => !n.parentId) : [];
      if (!el || !ns.length) { if (tries++ < 12) settleFrame.current = requestAnimationFrame(settle); return; }
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
    settleFrame.current = requestAnimationFrame(settle);
    // topicGroups.length is not read in here, but it is what should re-settle
    // the viewport when grouping changes the layout. Removing it may be right
    // and may drop a needed re-settle; not judged — see FUTURE.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, topicGroups.length, getNodes, getViewport, setViewport, codes.length]);
  // the Map tab's menu picked a view while the map is on screen
  useEffect(() => {
    const onPick = (e: Event) => switchView((e as CustomEvent<MapView>).detail);
    window.addEventListener("qually:mapview", onPick);
    return () => window.removeEventListener("qually:mapview", onPick);
  }, [switchView]);

  // The similar panel is glued to the map, so nothing guarantees the screen
  // shows it: opened under a chip in the lower half of the canvas, its action
  // buttons land below the window — reachable only by panning, which is
  // exactly the work a magnified view makes expensive. Pan the CAMERA (never
  // the layout) the least distance that brings the panel fully into view, at
  // open and again when the AI pass reshapes it. Ticking rows does not
  // re-trigger this, so the camera never fights the user mid-conversation.
  useEffect(() => {
    if (!similar) return;
    let frame = 0, tries = 0;
    const settle = () => {
      const canvas = canvasRef.current;
      const el = canvas?.querySelector(".mapSimNode");
      if (!canvas || !el) { if (tries++ < 12) frame = requestAnimationFrame(settle); return; }
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      const pad = 12;
      // top-left wins when the panel is larger than the canvas: the header
      // names the question and the list starts there
      const dx = Math.min(0, c.right - pad - r.right) - Math.min(0, r.left - (c.left + pad));
      const dy = Math.min(0, c.bottom - pad - r.bottom) - Math.min(0, r.top - (c.top + pad));
      if (!dx && !dy) return;
      const vp = getViewport();
      void setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 240 });
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [similar?.source, similar?.ai, getViewport, setViewport]);

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
    if (!slot) {
      // A Clean up that moved nothing must WRITE nothing. Recording every
      // pile's packed spot would pin them all: the piles are derived, so they
      // are meant to re-pack as the coding grows, and a pinned one is later
      // overlapped by the neighbour that grew into it. (The store path returns
      // early for the same reason.)
      if (!moved) { announce("Nothing needed moving at this zoom"); return; }
      // a grouping view: its only top-level things are the piles, and their
      // hand positions live in the session, not the store
      remembered.bucketPos[view] = { ...(remembered.bucketPos[view] ?? {}), ...islands };
      setBucketRev((r) => r + 1);
      earcon.settle();
      announce(`Moved ${moved === 1 ? "1 group" : `${moved} groups`} apart`);
      return;
    }
    if (moved) earcon.settle();
    useStore.getState().applyMapLayout(chips, islands, moved, slot);
  }, [getZoom, getNodes, slot, view]);

  const selectSimilar = useCallback(() => {
    const cur = similar;
    if (!cur) return;
    const pick = new Set([cur.source, ...cur.ticked]);
    // Seed the session's selection FIRST. Closing the panel rebuilds the
    // layout, and a rebuilt chip takes its selected state from here — the
    // HUD's effect that normally keeps this in step runs a beat later, so
    // without this the rebuild wiped the selection we just made and left the
    // one chip the panel was opened from.
    remembered.selected = new Set(pick);
    rfSetNodes((ns) => ns.map((n) => ({ ...n, selected: n.type === "chip" && pick.has(n.id) })));
    setSimilar(null);
    announce(`${pick.size} codes selected on the map`);
  }, [similar, rfSetNodes]);
  openSimilarAiRef.current = openSimilarAi;
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
      { survivor: bestSurvivor(st, sel), codes: sel, rationale: "Grouped by hand on the map.", source: "you" }]);
    setMenu(null);
  };
  // the camera persists across tab switches AND reloads
  const [initialViewport] = useState(() => useStore.getState().ui.mapViewport);
  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    // a move WE animated (a find flight) ending is not the researcher picking
    // a zoom; any other move is, and resets what "their zoom" means. (A wheel
    // inside the flight window is misread as ours — the cost is one hop at the
    // old zoom, self-corrected by their next touch; the stuck flag this
    // replaces made a wide hit's zoom-out the permanent baseline.)
    if (performance.now() > findFlightUntil.current) findWantZoom.current = null;
    setUi({ mapViewport: vp });
  }, [setUi]);
  // While you hold a chip, the container it would join is tracked — in
  // Reconcile it also outlines in the accent. rAF-coalesced imperative class
  // toggle, no React work per move.
  const dragFrame = useRef(0);
  const clearWill = () => document.querySelectorAll(".mapHalo.will").forEach((el) => el.classList.remove("will"));
  // The container kind this view drops into, or null where a drag files
  // nothing (the grouping views move whole piles, never chips).
  const dropTarget: "halo" | "island" | null =
    view === "reconcile" ? "halo" : view === "themes" || view === "areas" ? "island" : null;
  const containerAt = useMemo(() => dropTarget === null ? null : (cx: number, cy: number) =>
    getNodes().find((h) => h.type === dropTarget
      // the catch-all is a PARKING LOT, not a container: a drop there LEAVES
      // the group. Counting it as a container made the crossing sound promise
      // "this will join" over the one pile that means the opposite.
      && !((h.data as Partial<IslandData & HaloData>)?.gi === -1
        || (h.data as Partial<IslandData & HaloData>)?.ai === -1)
      && cx >= h.position.x && cx <= h.position.x + (h.width ?? 0)
      && cy >= h.position.y && cy <= h.position.y + (h.height ?? 0)) ?? null, [getNodes, dropTarget]);
  // the container under the held chip, tracked across the drag: the .will
  // outline AND the crossing sounds key off transitions of this one value
  const dragOver = useRef<string | null>(null);
  const onNodeDragStart = useCallback((_: unknown, n: Node) => {
    if (!containerAt || n.type !== "chip") return;
    const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
    // seed with where the chip already sits, so lifting a member inside its
    // own container doesn't chirp "entered"
    dragOver.current = containerAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2)?.id ?? null;
  }, [getInternalNode, containerAt]);
  const onNodeDrag = useCallback((_: unknown, n: Node) => {
    // every view WITH containers previews the crossing: the same gesture means
    // join/leave in Reconcile, Themes and Areas alike, and the sound is what
    // says which side of an edge you are on without looking
    if (!containerAt || n.type !== "chip" || dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      const abs = getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
      const hit = containerAt(abs.x + (n.width ?? 0) / 2, abs.y + (n.height ?? 0) / 2);
      clearWill();
      // only capsules carry the .will outline; islands show membership by
      // containment, which the dragged chip already demonstrates
      // dropTarget, NOT remembered.view: the override is null whenever the
      // view is DERIVED, which is the map's usual Reconcile state — so this
      // read left the outline dark exactly where the crossing sounds fire.
      if (hit && dropTarget === "halo")
        document.querySelector(`.react-flow__node[data-id="${hit.id}"] .mapHalo`)?.classList.add("will");
      const over = hit?.id ?? null;
      if (over !== dragOver.current) {
        // crossing a field boundary mid-drag: a quiet preview of what release
        // would do (the louder join/evict marks confirm the actual drop)
        (over ? earcon.hoverIn : earcon.hoverOut)();
        dragOver.current = over;
      }
    });
  }, [getInternalNode, containerAt, dropTarget]);

  // ONE drop rule, every view that has containers:
  //   into a container  → joins, APPENDED at the end (its hand position is
  //                       forgotten, so the packer puts it after the others)
  //   onto the catch-all→ leaves, and forgets its position so it tidies in
  //   open canvas       → leaves, and stays exactly where you let go
  // A derived view arrives here too, with its PILES: only chips are pinned
  // there, and their branch below is guarded by the layout slot.
  const onNodeDragStop = useCallback((_: unknown, n: Node, dragged: Node[]) => {
    // the last onNodeDrag's frame is still pending: let it run and it repaints
    // a stale .will outline and chirps a crossing on top of the drop's own mark
    if (dragFrame.current) { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; }
    dragOver.current = null;
    // React Flow reports a multi-selection drag ONCE, with the whole set in the
    // third argument. File every node in it, or the ones you did not happen to
    // grab snap back to their packed spots on the next rebuild.
    if (!slot) {
      // a grouping view: the PILES rearrange (session memory), chips never move
      const movedPiles = (dragged?.length ? dragged : [n]).filter((x) => x.type === "island");
      if (!movedPiles.length) return;
      const store = (remembered.bucketPos[view] ??= {});
      // No bucketRev bump here, unlike the identical mutation in cleanUpLayout:
      // React Flow is uncontrolled, so the pile ALREADY renders where it was
      // dropped, and the next rebuild reads these positions fresh. Bumping
      // would only repaint what is already correct.
      for (const x of movedPiles) store[x.id] = x.position;
      // the only committed move gesture in these views: mark it like every
      // other commit, or dragging by feel gets no confirmation
      earcon.settle();
      announce(`Moved ${movedPiles.length === 1 ? "a group" : `${movedPiles.length} groups`}`);
      return;
    }
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
  // Clicking a group takes its codes with it — the one gesture that says
  // "this group" and nothing else. Doing it here rather than in the selection
  // sync keeps a marquee that merely grazes a capsule from adopting anything.
  const onNodeClick = useCallback((_: unknown, n: Node) => {
    if (n.type !== "island" && n.type !== "halo") return;
    rfSetNodes((ns) => {
      const mine = new Set(ns.filter((x) => x.parentId === n.id && x.type === "chip").map((x) => x.id));
      if (!mine.size) return ns;
      if ([...mine].every((id) => ns.find((x) => x.id === id)?.selected)) return ns;
      return ns.map((x) => (mine.has(x.id) && !x.selected ? { ...x, selected: true } : x));
    });
  }, [rfSetNodes]);
  const onNodeDoubleClick = useCallback((_: unknown, n: Node) => {
    if (n.type === "chip") openInCodebook([n.id]);
    if (n.type === "halo") toggleCard((n.data as HaloData).ci);
  }, []);
  const selectionAt = useCallback((): string[] =>
    getNodes().filter((n) => n.selected && n.type === "chip").map((n) => n.id), [getNodes]);
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: Node) => {
    // the definition branch is a reading surface: its id is no code, so the
    // chip menu would act on garbage — and right-click there means "Copy"
    if (n.type === "defcard") return;
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
  // the shared code menu, opened FROM the map menu — see the row that sets it
  const [codeActions, setCodeActions] = useState<{ code: string; x: number; y: number } | null>(null);
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
  // A container and its codes are ONE selection, in both directions:
  //   every code picked   → the container is picked too, so React Flow drags
  //                         the whole capsule and nothing is filed as having
  //                         left it (see onNodeDragStop's `carried`)
  //   the container picked→ its codes come with it, which is what clicking a
  //                         group's body or caption is asking for
  //   some codes picked   → the container is NOT picked; a marquee that clips
  //                         two of five chips must still take only those two
  // Chips win, always. Taking a group's codes BECAUSE you picked the group is
  // not decided here but in onNodeClick, where the gesture is unambiguous — a
  // marquee also lands a container with none of its codes the moment its rect
  // grazes the capsule's padding, and inferring "you meant the whole group"
  // from that would balloon a sweep past an edge into five codes you never
  // touched. So: a container the marquee caught chip-less is let go of, and
  // only a click adopts.
  const syncGroupSelection = useCallback(() => {
    rfSetNodes((ns) => {
      const members = new Map<string, string[]>();
      for (const n of ns) if (n.type === "chip" && n.parentId) {
        const list = members.get(n.parentId) ?? [];
        list.push(n.id);
        members.set(n.parentId, list);
      }
      const picked = new Set(ns.filter((n) => n.type === "chip" && n.selected).map((n) => n.id));
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
    menuSel.filter((c) => c !== into).forEach((c) => mergeCode(c, into, "Merged by hand on the map", "you"));
    setMenu(null);
  };

  // menu dismissal: any outside press or Escape
  useEffect(() => {
    if (!menu && !confirmAi && !confirmRelayout && !helpOpen && !similar && !confirmFocus && !confirmArea && !layoutMenu && !mapSetMenu && !compareMenu) return;
    const close = () => { setMenu(null); setConfirmAi(null); setConfirmRelayout(null); setHelpOpen(false); setConfirmFocus(null); setConfirmArea(null); setLayoutMenu(null); setMapSetMenu(null); setCompareMenu(null); };
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest(".mapMenu")) return;
      // the bar's toggles manage their own menus in onClick (a mousedown-close
      // here would fire a moment before the click reopens) — but pressing one
      // must still dismiss the canvas popovers, or a bar menu opens over a
      // still-open node menu or confirm
      if (t.closest(".mapHelpBtn") || t.closest(".mapBar button[aria-haspopup]")) {
        setMenu(null); setConfirmAi(null); setConfirmRelayout(null);
        setConfirmFocus(null); setConfirmArea(null);
        return;
      }
      close();
      // the similar results are a NODE on the canvas, not a menu: panning and
      // clicking around the map must not dismiss them. Escape and its own ×
      // close it, like the halo's card.
    };
    const key = (e: KeyboardEvent) => {
      // A consent modal owns Escape while it is in front; closing the map panel
      // underneath it would also throw away the result the approved run lands in.
      if ((e.target as Element | null)?.closest?.(".about-backdrop")) return;
      if (e.key === "Escape") { e.stopPropagation(); close(); setSimilar(null); }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [menu, confirmAi, confirmRelayout, helpOpen, similar, confirmFocus, confirmArea, layoutMenu, mapSetMenu, compareMenu]);

  return (
    <div id="codemap" className={"view-" + view} style={{ fontSize: MAP_FS }}>
      {/* One floating pill: chrome first (help, settings, layout — the same in
          every view), then THIS view's actions, icon+name so they read without
          a hover. Which view this is lives on the Map tab's menu now. */}
      <div className="mapBar" role="toolbar" aria-label="Map controls">
        {/* Which view you are in, said out loud. The Map tab's menu is still the
            way to CHANGE it, but the answer to "what am I looking at" belongs
            on the thing itself — every action to the right reads differently
            depending on it. */}
        <span className="mapMode" title={spec.label + " — " + spec.hint + ". Switch view from the Map tab."}>
          {spec.label}
        </span>
        <span className="mapBarDivider" role="separator" aria-orientation="vertical" />
        <button className="btn iconbtn mapHelpBtn" aria-expanded={helpOpen}
          aria-label={helpOpen ? "Hide how to use the map" : "How to use the map"}
          onClick={() => {
            // find shares this exact spot under the bar (left:12 / top:56) —
            // the two are exclusive both ways (Ctrl+F closes help likewise)
            setLayoutMenu(null); setMapSetMenu(null); setCompareMenu(null); setFind(null); setHelpOpen((v) => !v);
          }}
          title="How to use the map">
          <Icon name="help" size={16} />
        </button>
        <button className="btn iconbtn" aria-expanded={!!find}
          aria-label={find ? "Close find on the map" : "Find a code on the map"}
          onClick={() => {
            setHelpOpen(false); setLayoutMenu(null); setMapSetMenu(null); setCompareMenu(null);
            find ? closeFind() : setFind({ q: "", i: 0 });
          }}
          title="Find a code on the map (Ctrl+F)">
          <Icon name="search" size={16} />
        </button>
        <button className="btn iconbtn" aria-haspopup="menu" aria-expanded={!!mapSetMenu}
          ref={mapSetBtn} aria-label="Map settings"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setLayoutMenu(null); setHelpOpen(false); setCompareMenu(null);
            setMapSetMenu(mapSetMenu ? null : { left: r.left, y: r.bottom + 8 });
          }}
          title="Map settings: selection ring, minimap">
          <Icon name="settings" size={16} />
        </button>
        <button className="btn iconlabel" aria-haspopup="menu" aria-expanded={!!layoutMenu}
          ref={layoutBtn} onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMapSetMenu(null); setHelpOpen(false); setCompareMenu(null);
            setLayoutMenu(layoutMenu ? null : { left: r.left, y: r.bottom + 8 });
          }}
          title="Reset or clean up the arrangement you are looking at">
          <Icon name="refresh" size={16} /> <span className="blabel">Layout</span>
          <Icon name={layoutMenu ? "chevron-up" : "chevron-down"} size={13} />
        </button>
        {/* the current view's own actions; the derived views have none */}
        {(view === "reconcile" || view === "themes" || view === "segs" || view === "areas"
          || (view === "compare" && allDims.length > 0)) && (
          <span className="mapBarDivider" role="separator" aria-orientation="vertical" />
        )}
        {view === "reconcile" && (
          <button className="btn iconlabel" onClick={runSweep}
            title="Find codes whose names share wording — on this machine, free, no key. Proposals only.">
            {/* two sheets, not a magnifier: this is about finding the code you
                wrote twice, and the search icon reads as "filter the map" */}
            <Icon name="copy" size={16} /> <span className="blabel">Match on wording</span>
          </button>
        )}
        {view === "reconcile" && (
          <button className="btn iconlabel"
            onClick={() => {
              // the selection IS the scope when there is one: you picked those
              // codes for a reason, and the modal still offers the whole book
              const sel = [...remembered.selected].filter((c) => c in codebook);
              setAiOpen({ scope: sel.length ? { focus: sel } : "all", selected: sel });
            }}
            title="The same question asked of a model: merge groups and per-code revisions, for your review">
            <Icon name="sparkle" size={16} /> <span className="blabel">Match with AI</span>
          </button>
        )}
        {view === "themes" && (
          <button className="btn iconlabel" onClick={() => setThemeAiOpen(true)}
            title="AI theme islands for you to reshape (nothing is applied until you accept)">
            <Icon name="sparkle" size={16} /> <span className="blabel">Group with AI</span>
          </button>
        )}
        {/* the count view is where you SEE the tail; this is the way into
            reading it, with the size you are looking at carried across */}
        {view === "segs" && (
          <button className="btn iconlabel" onClick={() => openTailQueue(1)}
            title="Read the codes resting on one excerpt, one at a time, in Assist">
            <Icon name="list" size={16} /> <span className="blabel">Work the thin tail</span>
          </button>
        )}
        {view === "compare" && allDims.length > 0 && (
          <button className="btn iconlabel" aria-haspopup="menu" aria-expanded={!!compareMenu}
            ref={compareBtn} onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setLayoutMenu(null); setMapSetMenu(null); setHelpOpen(false);
              setCompareMenu(compareMenu ? null : { left: r.left, y: r.bottom + 8 });
            }}
            title="Tick the dimensions the piles divide by — several combine (condition · phase)">
            <Icon name="eye" size={16} /> <span className="blabel">Divide by {activeDims.join(" · ")}</span>
            <Icon name={compareMenu ? "chevron-up" : "chevron-down"} size={13} />
          </button>
        )}
        {view === "areas" && (
          // stale is a colour on the button, explained by its tooltip
          <button className={"btn iconlabel" + (topicsStale && topicGroups.length > 0 ? " stale" : "")}
            onClick={() => setTopicAiOpen(true)}
            title={topicGroups.length === 0
              ? "Ask the AI to sort the whole map into broad areas — or make areas yourself: select codes and right-click"
              : topicsStale
                ? "The codebook changed since these areas were worked out — re-run to refresh them"
                : "Ask the AI to work the areas out again"}>
            <Icon name="sparkle" size={16} />
            <span className="blabel">{topicGroups.length === 0 ? "Sort into areas"
              : topicsStale ? "Re-run areas (stale)" : "Re-run areas"}</span>
          </button>
        )}
      </div>
      <div className="mapCanvas" ref={canvasRef} tabIndex={-1}
        aria-label={`${spec.label} view. ${spec.drag}.`}>
        {codes.length === 0
          ? <div className="empty">No codes yet — the map draws itself as you code.</div>
          : (
          <ReactFlow<MapNode>
            defaultNodes={initialNodes} nodeTypes={nodeTypes}
            colorMode={dark ? "dark" : "light"}
            fitView={!initialViewport} fitViewOptions={{ padding: 0.15 }}
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
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}>
            <Controls showInteractive={false} />
            {/* the MiniMap re-scans the store on every write; unmounting it for
                the duration of a box-drag costs one render at gesture start/end
                instead of aggregate scans per membership change (codex consult) */}
            {/* key: a corner change REMOUNTS the minimap rather than restyling it in
                place — Firefox painted the in-place move as two steps (side, then
                down), and a node created at its final spot has no way to travel */}
            {!selecting && <MiniMap key={mapMinimap} pannable zoomable position={mapMinimap} nodeColor={nodeColor} />}
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
            <SelectionRingScale />
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
      {similarGate && (
        <SimilarModal focus={similarGate.focus} book={similarGate.book}
          onClose={() => setSimilarGate(null)}
          onMatches={(matches, cost) => landSimilarAi(similarGate.source, matches, cost)} />
      )}
      {topicAiOpen && (
        <GroupModal transient
          onClose={() => setTopicAiOpen(false)}
          onReconcileInstead={() => { setTopicAiOpen(false); switchView("reconcile"); }}
          onGroups={(groups) => {
            useStore.getState().setCodeAreas(groups.map((g) => ({ name: g.name, codes: g.codes })), codebookFp);
            setViewOverride("areas");
            // wait for the AREAS layout to land in React Flow — one frame
            // framed whatever view was on screen before
            let tries = 0;
            const frameIt = () => {
              if (committedView.current !== "areas") { if (tries++ < 12) requestAnimationFrame(frameIt); return; }
              void fitView({ duration: 200 });
            };
            requestAnimationFrame(frameIt);
          }} />
      )}
      {themeAiOpen && (
        <GroupModal
          onClose={() => setThemeAiOpen(false)}
          onReconcileInstead={() => { setThemeAiOpen(false); switchView("reconcile"); }}
          onGroups={(groups) => { useStore.getState().applyThemeGroups(groups); }} />
      )}
      {describeFor && <DescribeModal initial={describeFor} onClose={() => setDescribeFor(null)} />}
      {apart && (
        <TellApartModal codes={apart.codes} survivor={apart.survivor} newName={apart.newName}
          source={apart.source} model={apart.model}
          onClose={() => setApart(null)}
          onDecided={() => {
            // either answer settles the proposal, so the capsule goes. Not
            // through dismissCluster: the ledger already carries the decision
            // that was actually made, and a "turned down" row beside it would
            // describe a refusal nobody performed. By id, never by index: the
            // merge answer already pruned the capsule itself (mergeInto), and
            // a stale index would name whatever proposal slid into its place —
            // so only a capsule still standing under its own id is dropped.
            // Silently (setState, not setCodeClusters): the decision that
            // settled it already pushed the gesture's one undo entry, with
            // the capsule still in that snapshot — a second entry made one
            // Ctrl+Z resurrect the capsule while the definitions stood.
            const st = useStore.getState();
            if (apart.cid !== undefined && st.codeClusters.some((c) => c.cid === apart.cid))
              useStore.setState({ codeClusters: st.codeClusters.filter((c) => c.cid !== apart.cid) });
          }} />
      )}
      {aiOpen && (
        <ReconcileModal groups={codeGroups} initialScope={aiOpen.scope} selected={aiOpen.selected}
          onClose={() => setAiOpen(false)}
          onPlan={(p: ReconcilePlan, scope, meta) => {
            const st = useStore.getState();
            const model = meta?.model;
            if (scope === "all") {
              st.applyReconcilePlan(p.clusters, p.actions, true, "ai", model);
            } else if (typeof scope === "object") {
              // focus run: the modal already merged into the pending state
              // (replace-intersecting incl. fresh context targets)
              st.applyReconcilePlan(p.clusters, p.actions, false, "ai", model);
            } else {
              // island-scoped refinement merges into the pending state: pending
              // clusters intersecting the subset are replaced (doc rule)
              const subset = new Set<string>(codeGroups[scope]?.codes ?? []);
              st.applyReconcilePlan(
                mergeScopedClusters(st.codeClusters, subset, p.clusters),
                [...st.codePlan.filter((a) => !subset.has(a.code)), ...p.actions],
                false, "ai", model);
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
              {n === 1 ? " its" : " their"} excerpts <b>plus your other {context.length} codes</b> as possible homes —
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
      {confirmArea && (() => {
        const st = useStore.getState();
        const codes = focusInputs(confirmArea.codes).focus;
        const red = redactor(st.ai.redactTerms);
        const inTok = estimateNameAreaTokens(codes, red);
        const model = modelOf(st.ai.model);
        const cost = costOf(model, inTok, estimateTokens(" ".repeat(80)));
        const n = codes.length;
        return (
          <div ref={areaConfirmRef} className="ctxmenu mapMenu mapAiConfirm" role="alertdialog"
            aria-label="Confirm AI request" aria-describedby="area-confirm-text"
            style={{ left: confirmArea.x, top: confirmArea.y, fontSize: sidebarFontSize }}>
            <div className="mapAiConfirmText" id="area-confirm-text">
              Name this area? The grouping stays yours — the AI writes only the label.
              Sends {n} code{n === 1 ? "" : "s"} with {n === 1 ? "its" : "their"} excerpts —
              <b> ≈{inTok.toLocaleString()} tokens · ≈${cost.toFixed(4)}</b> to OpenAI ({model.id}).
              Excerpts are participant data.
            </div>
            <div className="mapCardActions">
              <button className="btn primary" autoFocus disabled={areaBusy}
                onClick={() => { const c = confirmArea.codes; setConfirmArea(null); void runNameArea(c); }}>
                {areaBusy ? "Asking…" : "Send"}
              </button>
              <button className="btn" onClick={() => setConfirmArea(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {find && <FindMarks canvas={canvasRef} hits={hits} cur={hits[at]} />}
      {find && (
        // its own strip under the bar, not a field inside it: the bar is a row
        // of controls that never changes width, and a text field that grows
        // with the query would push every action along it.
        <div className="mapFind" role="search"
          // Escape from ANY of it — the steppers are buttons a keyboard user
          // lands on, and Escape there must not fall through to the map's own
          // Escape (clear the selection) instead of closing what is in front.
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault(); e.stopPropagation();
            closeFind();
          }}>
          <input ref={findRef} className="mapFindInput" value={find.q}
            placeholder="Find a code…" aria-label="Find a code on the map"
            onChange={(e) => setFind({ q: e.target.value, i: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
            }} />
          {/* role=status: the position announces as you type and as you step */}
          <span className="mapFindCount" role="status">
            {find.q.trim() ? `${hits.length ? at + 1 : 0}/${hits.length}` : ""}
          </span>
          <button className="btn iconbtn" onClick={() => stepFind(-1)} disabled={!hits.length}
            aria-label="Previous match" title="Previous (Shift+Enter)">
            <Icon name="chevron-up" size={16} />
          </button>
          <button className="btn iconbtn" onClick={() => stepFind(1)} disabled={!hits.length}
            aria-label="Next match" title="Next (Enter)">
            <Icon name="chevron-down" size={16} />
          </button>
          <button className="btn iconbtn" onClick={closeFind} aria-label="Close find" title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {helpOpen && (
        <div className="mapMenu mapHelp" role="dialog" aria-label="How to use the map"
          style={{ fontSize: sidebarFontSize }}>
          <div className="mapHelpHead"><b>The whole codebook at once</b></div>
          {/* the minimum to operate: gestures that have no on-screen hint, and
              the one concept the map cannot show — merge vs group. Everything
              else is said where it happens (the drag line above, the
              Layout menu's own notes). */}
          <dl className="mapHelpList">
            <dt>Drag here</dt><dd>{spec.drag}</dd>
            <dt>Select</dt><dd>Drag a box. Ctrl adds to it.</dd>
            <dt>Move</dt><dd>Space, middle or right-drag pans; wheel zooms.</dd>
            <dt>Act</dt><dd>Right-click a selection. Double-click reads a code.</dd>
            <dt>Capsules</dt><dd>A proposed merge — drag chips in or out.</dd>
            <dt>Whole groups</dt><dd>Click one anywhere to take it and its codes; drag from inside it to move all you have picked.</dd>
            <dt>Whose idea</dt><dd>Solid and tinted came from the AI, dashed from the wording pass, plain from you.</dd>
            <dt>Merge vs group</dt><dd>A merge folds codes into one; a group keeps separate codes together.</dd>
          </dl>
        </div>
      )}
      {compareMenu && (
        <div ref={compareRef} className="ctxmenu mapMenu" role="menu" aria-label="Divide the piles by"
          onKeyDown={compareArrows}
          style={{ left: compareMenu.left, top: compareMenu.y, fontSize: sidebarFontSize }}>
          <div className="ctxhead">Divide by</div>
          {allDims.map((d) => {
            const on = activeDims.includes(d);
            return (
              <button key={d} role="menuitemcheckbox" aria-checked={on}
                className={"mapCmpDim" + (on ? " on" : "")}
                title={on && activeDims.length === 1 ? "At least one axis stays on" : undefined}
                onClick={() => toggleCompareDim(d)}>
                <span className="mapCmpTick">{on ? "✓" : ""}</span>{d}
              </button>
            );
          })}
        </div>
      )}
      {mapSetMenu && (
        /* the Settings modal's own furniture — .set-h, .srow, .settings-note —
           so the map's settings read like settings, not like a context menu
           that grew form controls */
        <div ref={mapSetRef} className="ctxmenu mapMenu mapSetMenu" role="dialog" aria-label="Map settings"
          onKeyDown={mapSetArrows}
          style={{ left: mapSetMenu.left, top: mapSetMenu.y, fontSize: sidebarFontSize }}>
          <div className="set-h">Map</div>
          <div className="srow">
            <span id="mapring-h">Selection ring</span>
            <div className="segmented" role="radiogroup" aria-labelledby="mapring-h">
              {RING_SIZES.map((sz) => (
                <button key={sz} className={"seg" + (mapRing === sz ? " on" : "")}
                  role="radio" aria-checked={mapRing === sz}
                  onClick={() => setUi({ mapRing: sz })}
                  title={`${MAP_RING_PX[sz]}px around every selected code`}>{sz}</button>
              ))}
            </div>
          </div>
          <div className="settings-note">
            {MAP_RING_PX[mapRing]}px at every zoom — a selection stays findable zoomed out.
          </div>
          <div className="srow">
            <span id="mapmini-h">Minimap</span>
            <div className="segmented mapCornerPick" role="radiogroup" aria-labelledby="mapmini-h">
              {CORNERS.map(([c, label]) => (
                <button key={c} className={"seg" + (mapMinimap === c ? " on" : "")}
                  role="radio" aria-checked={mapMinimap === c} aria-label={label}
                  data-corner={c} onClick={() => setUi({ mapMinimap: c })}
                  title={`Put the minimap in the ${label.toLowerCase()}`}>
                  <Icon name="box-align-corner" size={18} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {layoutMenu && (
        <div ref={layoutRef} className="ctxmenu mapMenu mapLayoutMenu" role="menu" aria-label="Layout"
          onKeyDown={layoutArrows}
          style={{ left: layoutMenu.left, top: layoutMenu.y, fontSize: sidebarFontSize }}>
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
        <div ref={relayoutRef} className="ctxmenu mapMenu mapAiConfirm" role="alertdialog" aria-label="Confirm re-layout"
          aria-describedby="relayout-confirm-text"
          style={{ left: confirmRelayout.left, top: confirmRelayout.y, fontSize: sidebarFontSize }}>
          {/* the promise has to match the route: a grouping view's pile
              positions live in the session, outside the undo history, so
              "undo brings it back" there would send Ctrl+Z at a real edit */}
          <div className="mapAiConfirmText" id="relayout-confirm-text">
            {slot ? <>
              Lay the map out fresh? Every chip and group you placed by hand returns to the
              packed layout. <b>One undo step brings it all back.</b>
            </> : <>
              Lay the groups out fresh? Every group you moved by hand returns to the packed
              layout. <b>This one cannot be undone</b> — these positions last for the session
              and are not part of the undo history.
            </>}
          </div>
          <div className="mapCardActions">
            <button className="btn primary" autoFocus
              onClick={() => {
                setConfirmRelayout(null);
                // a grouping view's pile moves live in the session, not the store
                // a grouping view: say it out loud like the store path does —
                // a confirmed action that answers only in sound is no answer
                // with Sounds off, and the already-packed case must answer too
                if (!slot) {
                  if (!remembered.bucketPos[view]) {
                    announce("The map is already in its packed layout");
                    return;
                  }
                  delete remembered.bucketPos[view];
                  setBucketRev((r) => r + 1);
                  earcon.settle();
                  announce("Map laid out fresh");
                  requestAnimationFrame(() => fitView({ duration: 200 }));
                  return;
                }
                if (slot && useStore.getState().resetMapLayout(slot)) {
                  earcon.settle();
                  requestAnimationFrame(() => fitView({ duration: 200 }));
                }
              }}>Re-layout</button>
            <button className="btn" onClick={() => setConfirmRelayout(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirmAi && (() => {
        const st = useStore.getState();
        const red = redactor(st.ai.redactTerms);
        const inputs = glimpseInputs(confirmAi.ci);
        const inTok = confirmAi.ask === "against"
          ? estimateAgainstTokens(inputs, red) : estimateGlimpseTokens(inputs, red);
        const model = modelOf(st.ai.model);
        const cost = costOf(model, inTok, estimateTokens(" ".repeat(80)));
        return (
          <div ref={aiConfirmRef} className="ctxmenu mapMenu mapAiConfirm" role="alertdialog" aria-label="Confirm AI request"
            aria-describedby="ai-confirm-text"
            style={{ left: confirmAi.x, top: confirmAi.y, fontSize: sidebarFontSize }}>
            <div className="mapAiConfirmText" id="ai-confirm-text">
              {confirmAi.ask === "against" ? "Argue against this merge" : "Describe with AI"} — sends
              {" "}<b>{inputs.length} codes with their excerpts · ≈{inTok.toLocaleString()} tokens
              · ≈${cost.toFixed(4)}</b> to OpenAI ({model.id}).
              Excerpts are participant data.
            </div>
            <div className="mapCardActions">
              <button className="btn primary" autoFocus
                onClick={() => {
                  const { ci, ask } = confirmAi;
                  setConfirmAi(null);
                  void (ask === "against" ? runAgainst(ci) : runGlimpse(ci));
                }}>Send</button>
              <button className="btn" onClick={() => setConfirmAi(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {menu && menu.halo && (
        <div ref={menuRef} className="ctxmenu mapMenu" onKeyDown={menuArrows} style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => {
            const list = clusters[menu.halo!.ci]?.codes.filter((c) => c in codebook) ?? [];
            openInCodebook(list); setMenu(null);
          }}>
            Open these codes in Codebook
          </button>
          {/* the sparkle IS the "this asks the AI" mark, app-wide — saying it
              in words too made every such row read as a category, not an act */}
          {/* the sparkle carries "this asks the AI" for the eye; the icon is
              aria-hidden, so the accessible name has to carry it in words —
              an off-device, paid action must not read like a local one */}
          <button role="menuitem" aria-label="Describe this group with AI"
            onClick={() => { setConfirmAi({ ci: menu.halo!.ci, x: menu.x, y: menu.y, ask: "describe" }); setMenu(null); }}>
            <Icon name="sparkle" size={16} /> Describe this group…
          </button>
          {/* the same model, the opposite job: the researcher proposed this
              merge and is asking for the strongest case that they are wrong */}
          <button role="menuitem" aria-label="Ask the AI to argue against this merge"
            onClick={() => { setConfirmAi({ ci: menu.halo!.ci, x: menu.x, y: menu.y, ask: "against" }); setMenu(null); }}>
            <Icon name="sparkle" size={16} /> Argue against this merge…
          </button>
        </div>
      )}
      {menu && menu.island && (
        <div ref={menuRef} className="ctxmenu mapMenu" onKeyDown={menuArrows} style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
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
      {codeActions && (
        <CodeMenu code={codeActions.code} x={codeActions.x} y={codeActions.y}
          onClose={() => setCodeActions(null)} />
      )}
      {menu && !menu.island && !menu.halo && menu.sel.length > 0 && (
        <div ref={menuRef} className="ctxmenu mapMenu" onKeyDown={menuArrows} style={{ left: menu.x, top: menu.y, fontSize: sidebarFontSize }} role="menu">
          <button role="menuitem" onClick={() => { openInCodebook(menu.sel); setMenu(null); }}>
            Open {menu.sel.length === 1 ? menu.sel[0] : `${menu.sel.length} codes`} in Codebook
          </button>
          {/* only where its actions (merge, capsule) can land — the derived
              grouping views are read-only piles, so the panel would be a
              list of buttons that do nothing there */}
          {menu.sel.length === 1 && VIEWS[view].layout && (
            <button role="menuitem" onClick={() => { const c = menu.sel[0]; setMenu(null); openSimilar(c); }}>
              Find similar codes…
            </button>
          )}
          {view === "reconcile" && (
            <button role="menuitem"
              aria-label={`Ask the AI where ${menu.sel.length === 1 ? "this code belongs" : "these codes belong"}`}
              onClick={() => {
              setConfirmFocus({ codes: menu.sel, x: menu.x, y: menu.y }); setMenu(null);
            }}>
              <Icon name="sparkle" size={16} /> Where {menu.sel.length === 1 ? "does this code" : "do these codes"} belong…
            </button>
          )}
          {/* each view offers only the structural edit it can show */}
          {view === "defs" && (
            <button role="menuitem"
              onClick={() => { const sel = menu.sel; setMenu(null); setDescribeFor(sel); }}
              title="Draft definitions for the selected codes from how you used them — reviewed before anything is sent">
              <Icon name="sparkle" size={16} /> Define {menu.sel.length === 1 ? "this code" : `these ${menu.sel.length} codes`} with AI…
            </button>
          )}
          {view === "areas" && (
            <button role="menuitem" onClick={() => { const sel = menu.sel; setMenu(null); makeArea(sel); }}>
              {menu.sel.length === 1 ? "New area with this code" : `New area from these ${menu.sel.length} codes`}
            </button>
          )}
          {view === "areas" && (
            <button role="menuitem"
              onClick={() => { setConfirmArea({ codes: menu.sel, x: menu.x, y: menu.y }); setMenu(null); }}
              title="The grouping is yours — the AI only writes the label">
              <Icon name="sparkle" size={16} /> New area, named by AI…
            </button>
          )}
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
          {/* Last, under a rule: everything above is about the MAP — where a
              code sits, what it groups with, what it might merge into — and this
              leaves for the code's own menu, the one the sidebar row and a
              transcript's lane bar open. A door out of this menu belongs at the
              end of it, not among the things it does itself.
              One code only: every item behind it acts on a single code. */}
          {menu.sel.length === 1 && <>
            <div className="ctxdiv" />
            <button role="menuitem" onClick={() => {
              const c = menu.sel[0], { x, y } = menu;
              setMenu(null); setCodeActions({ code: c, x, y });
            }}>
              <Icon name="dots" size={16} /> Other actions…
            </button>
          </>}
        </div>
      )}
    </div>
  );
}

export function CodeMapView() {
  return <ReactFlowProvider><MapInner /></ReactFlowProvider>;
}
