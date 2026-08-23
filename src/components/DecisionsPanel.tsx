// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Assist tab's Decisions panel: what you decided about the codebook, why,
// and whose idea it was. The AI log next door records what was ASKED of the
// model; this records what you did with the answer — the half a reader of the
// paper actually asks about.
//
// Nothing here is a control. You cannot undo from this list (the history stack
// owns that, and a decision reversed weeks later is a new decision anyway) and
// nothing can be edited away: a reversed decision stays, marked. The panel's
// whole job is to be readable and exportable.
import { useMemo, useState } from "react";
import { useStore, type Decision, type DecisionKind } from "../state/store";
import { originCounts, methodsParagraph, type OriginCounts } from "../provenance";
import { preselectBrowse } from "./BrowseView";
import { Icon } from "./Icon";

const KIND_LABEL: Record<Decision["kind"], string> = {
  merge: "merged", rename: "renamed", remove: "withdrew", delete: "deleted",
  keep: "kept", park: "set aside", unpark: "brought back", promote: "to code more", dismiss: "turned down",
};
// where the idea came from — never who performed it. Every row is your decision.
const SOURCE_LABEL: Record<Decision["source"], string> = {
  you: "your call", wording: "matched on wording", ai: "AI proposal",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export type DecisionFilter = { kinds: Set<DecisionKind>; source: "all" | "you" | "ai" };
export const NO_FILTER: DecisionFilter = { kinds: new Set(), source: "all" };
// grouped the way a reader reads them, not the way the store writes them
const KIND_GROUPS: { label: string; kinds: DecisionKind[] }[] = [
  { label: "Merges", kinds: ["merge"] },
  { label: "Renames", kinds: ["rename"] },
  { label: "Withdrawn", kinds: ["remove", "delete"] },
  { label: "Set aside", kinds: ["park", "unpark"] },
  { label: "Turned down", kinds: ["dismiss"] },
  { label: "Tail queue", kinds: ["keep", "promote"] },
];

/** the left rail: how the book got to be the way it is, in three numbers */
export function DecisionsSide({ hideUndone, setHideUndone, filter, setFilter }: {
  hideUndone: boolean; setHideUndone: (v: boolean) => void;
  filter: DecisionFilter; setFilter: (f: DecisionFilter) => void;
}) {
  const ledger = useStore((s) => s.ledger);
  const codebook = useStore((s) => s.codebook);
  const counts = useMemo(() => originCounts(ledger, Object.keys(codebook)), [ledger, codebook]);
  const undone = ledger.filter((d) => d.undone).length;
  const pct = (n: number) => (counts.total ? Math.round((n / counts.total) * 100) : 0);
  const bar = (k: keyof OriginCounts & ("untouched" | "you" | "ai")) =>
    counts[k] > 0 && <span className={"dvSeg " + k} style={{ width: `${pct(counts[k])}%` }} />;
  return (
    <>
      <div className="dvWho">
        <div className="dvBar" role="img"
          aria-label={`${counts.untouched} codes as first written, ${counts.you} revised by you, ${counts.ai} from a proposal you accepted`}>
          {bar("untouched")}{bar("you")}{bar("ai")}
        </div>
        <ul className="dvKeys">
          <li><span className="dvDot untouched" /><b>{counts.untouched}</b> as you first wrote them</li>
          <li><span className="dvDot you" /><b>{counts.you}</b> you revised</li>
          <li><span className="dvDot ai" /><b>{counts.ai}</b> from a proposal you accepted</li>
        </ul>
        {/* stated, never scored: the number is the whole intervention */}
        <p className="dvNote">
          {counts.ai === 0
            ? "No proposal has shaped a code in this book."
            : `A model's proposal shaped ${pct(counts.ai)}% of the codes you have now.`}
        </p>
      </div>
      {undone > 0 && (
        <label className="dvToggle">
          <input type="checkbox" checked={hideUndone} onChange={(e) => setHideUndone(e.target.checked)} />
          Hide the {undone} reversed
        </label>
      )}
      {ledger.length > 0 && (
        <>
          <div className="aByLabel" id="dvWhoseLabel">Whose idea</div>
          <div className="segmented" role="group" aria-labelledby="dvWhoseLabel">
            {([["all", "All"], ["you", "Mine"], ["ai", "Proposed"]] as const).map(([id, label]) => (
              <button key={id} className={"seg" + (filter.source === id ? " on" : "")}
                aria-pressed={filter.source === id}
                onClick={() => setFilter({ ...filter, source: id })}>{label}</button>
            ))}
          </div>
          <div className="aByLabel" id="dvKindLabel">Kind</div>
          <div className="dvKinds" role="group" aria-labelledby="dvKindLabel">
            {KIND_GROUPS.map((g) => {
              const n = ledger.filter((d) => g.kinds.includes(d.kind)).length;
              if (!n) return null;
              const on = g.kinds.some((k) => filter.kinds.has(k));
              return (
                <button key={g.label} className={"dvKindBtn" + (on ? " on" : "")} aria-pressed={on}
                  onClick={() => {
                    const kinds = new Set(filter.kinds);
                    g.kinds.forEach((k) => (on ? kinds.delete(k) : kinds.add(k)));
                    setFilter({ ...filter, kinds });
                  }}>{g.label}<span className="cnt">{n}</span></button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export function DecisionsList({ hideUndone, filter }: { hideUndone: boolean; filter: DecisionFilter }) {
  const ledger = useStore((s) => s.ledger);
  const codebook = useStore((s) => s.codebook);
  const setActive = useStore((s) => s.setActive);
  const [copied, setCopied] = useState(false);
  const para = useMemo(() => methodsParagraph(ledger, Object.keys(codebook)), [ledger, codebook]);
  const rows = useMemo(
    () => ledger.map((d, i) => ({ d, i }))
      .filter(({ d }) => !(hideUndone && d.undone))
      .filter(({ d }) => !filter.kinds.size || filter.kinds.has(d.kind))
      // "mine" is everything the model did not propose — an offline wording
      // match is a computation you ran, not a suggestion you were given
      .filter(({ d }) => filter.source === "all" || (filter.source === "ai" ? d.source === "ai" : d.source !== "ai"))
      .reverse(),
    [ledger, hideUndone, filter]);
  // a decision names codes; the excerpts behind them are one click away, and
  // for a code that still exists that is where the reasoning can be checked
  const openCode = (c: string) => { preselectBrowse([c]); setActive("browse"); };

  if (!ledger.length) {
    return (
      <div className="empty">
        Nothing decided yet. Merge, rename or withdraw a code — from the sidebar, the
        Code map or a proposal — and every one of those lands here with its reason,
        ready to export as the appendix your methods section needs.
      </div>
    );
  }
  return (
    <div className="dvWrap">
      <div className="dvPara">
        <div className="dvParaHead">
          <h3>For your methods section</h3>
          <button className="nBtn" onClick={() => {
            navigator.clipboard?.writeText(para).then(() => setCopied(true), () => setCopied(false));
          }}>{copied ? "Copied" : "Copy"}</button>
        </div>
        {/* counted from the ledger, never written by a model: this is a claim
            about your own conduct, so nothing else may author it */}
        <p>{para}</p>
      </div>
      {rows.length === 0 && (
        <div className="empty">Nothing matches that filter.</div>
      )}
      <ol className="dvList">
        {rows.map(({ d, i }) => (
          <li key={i} className={"dvRow" + (d.undone ? " undone" : "")}>
            <span className={"dvKind " + d.kind}>{KIND_LABEL[d.kind] ?? d.kind}</span>
            <div className="dvBody">
              <div className="dvCodes">
                {d.codes.map((c, n) => (
                  // gone codes (everything a merge folded in) are not links —
                  // there is nothing to open, and a dead link reads as a bug
                  c in codebook ? (
                    <button key={c + n} className={"dvCode link" + (n === 0 ? " first" : "")}
                      title={`Read the excerpts of “${c}” in the Codebook`}
                      onClick={() => openCode(c)}>{c}</button>
                  ) : (
                    <span key={c + n} className={"dvCode" + (n === 0 ? " first" : "")}>{c}</span>
                  )
                ))}
              </div>
              {d.why && <div className="dvWhy">{d.why}</div>}
              <div className="dvMeta">
                {/* how big the decision was, counted when it happened — the
                    codes it counted may not exist any more */}
                {d.moved !== undefined && d.moved > 0 && (
                  <span className="dvSize">{d.moved} excerpt{d.moved === 1 ? "" : "s"} {d.kind === "merge" ? "moved" : d.kind === "remove" ? "rejected" : "gone"}</span>
                )}
                {d.now !== undefined && (d.kind === "merge" || d.kind === "rename") && (
                  <span className="dvSize">{d.now} after</span>
                )}
                <span className={"dvSrc " + d.source}>{SOURCE_LABEL[d.source] ?? d.source}</span>
                {d.model && <span className="dvModel">{d.model}</span>}
                <span className="dvWhen">{when(d.at)}</span>
                {d.undone && <span className="dvUndone"><Icon name="undo" size={13} /> reversed</span>}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
