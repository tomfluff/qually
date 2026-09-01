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

export function CodePickBar({ sortBy, onSort, onPick, children }: {
  sortBy: SortBy;
  onSort: (s: SortBy) => void;
  /** bulk selections this dialog offers; each gets a button */
  onPick?: { label: string; run: () => void }[];
  children?: React.ReactNode;
}) {
  return (
    <div className="cpickBar">
      {onPick?.map((p) => (
        <button key={p.label} className="btn" onClick={p.run}>{p.label}</button>
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

export function CodePickRow({ code, color, on, onToggle }: {
  code: CodePick; color: string; on: boolean; onToggle: () => void;
}) {
  const n = `${code.segs} excerpt${code.segs === 1 ? "" : "s"} in ${code.pids} transcript${code.pids === 1 ? "" : "s"}`;
  return (
    <label className={"cpickRow" + (on ? " on" : "")}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span className="mSw" style={{ background: color || "#999" }} />
      <span className="cpickName">{code.name}</span>
      {code.def
        ? <span className="cpickDef" title={code.def}>{code.def}</span>
        : <span className="cpickDef none">no definition yet</span>}
      {/* the two numbers a researcher picks on: how much evidence, spread over
          how many people. Title spells them out — "9·5" is compact, not obvious. */}
      <span className="cpickN" title={n} aria-label={n}>{code.segs}·{code.pids}</span>
    </label>
  );
}
