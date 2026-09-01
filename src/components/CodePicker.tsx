// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The list of codes a dialog asks you to tick, shared by every dialog that asks.
//
// It was written once inside DescribeModal, and the second dialog that needed a
// code list (FindModal) got a bare checkbox list instead — no counts, no
// definitions, no sort — because writing a plain <label> was quicker than
// reading the one already here. That is the same mistake as the second
// segmented control, so this is a component rather than a pattern to copy: a
// row shows what a code IS (its colour, its definition, how much evidence it
// rests on), and the bar above it sorts and bulk-picks the same way everywhere.
import { SORTS, type SortBy } from "../codeStats";

/** What a row needs to describe a code. `def` may be empty. */
export interface CodePick { name: string; def: string; segs: number; pids: number }

export function CodePickBar({ sortBy, onSort, onPick, disabled, children }: {
  sortBy: SortBy;
  onSort: (s: SortBy) => void;
  /** bulk selections this dialog offers; each gets a button */
  onPick?: { label: string; run: () => void }[];
  /** true while a run is in flight — see CodePickRow */
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="cpickBar">
      {onPick?.map((p) => (
        <button key={p.label} className="btn" disabled={disabled} onClick={p.run}>{p.label}</button>
      ))}
      {children}
      {/* ticks survive a re-sort: the order is a view, not the selection */}
      <span className="cpickSort">
        <span className="cpickSortLabel" id="cpickSortLabel">Sort</span>
        <span className="segmented sortseg" role="group" aria-labelledby="cpickSortLabel">
          {SORTS.map((s) => (
            <button key={s.id} className={"seg" + (sortBy === s.id ? " on" : "")}
              aria-pressed={sortBy === s.id} onClick={() => onSort(s.id)}>{s.label}</button>
          ))}
        </span>
      </span>
    </div>
  );
}

export function CodePickRow({ code, color, on, disabled, onToggle }: {
  code: CodePick; color: string; on: boolean; disabled?: boolean; onToggle: () => void;
}) {
  const n = `${code.segs} excerpt${code.segs === 1 ? "" : "s"} in ${code.pids} transcript${code.pids === 1 ? "" : "s"}`;
  return (
    <label className={"cpickRow" + (on ? " on" : "")}>
      {/* disabled while a run is in flight: the request was built from the
          selection as it stood at Send, so a picker that still moves shows a
          consent state the run is not using — and in a multi-window run a
          proposal for a code you had just unticked could still land. */}
      <input type="checkbox" checked={on} disabled={disabled} onChange={onToggle} />
      <span className="mSw" style={{ background: color || "#999" }} />
      <span className="cpickName">{code.name}</span>
      {code.def
        ? <span className="cpickDef" title={code.def}>{code.def}</span>
        : <span className="cpickDef none">no definition yet</span>}
      {/* The two numbers a researcher picks on: how much evidence, spread over
          how many people. "9·5" is compact, not obvious — and aria-label on a
          plain <span> is ignored, because naming is prohibited on a generic
          role, so a screen reader was reading the label as "9·5" and nothing
          more. The sentence goes in the label's own text, hidden visually; the
          digits are hidden FROM the name so it is not read twice. */}
      <span className="cpickN" aria-hidden="true">{code.segs}·{code.pids}</span>
      <span className="sr-only">{n}</span>
    </label>
  );
}
