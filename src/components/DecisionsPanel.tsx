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
import { useStore, type Decision } from "../state/store";
import { originCounts, methodsParagraph, type OriginCounts } from "../provenance";
import { preselectBrowse } from "./BrowseView";
import { Icon } from "./Icon";

const KIND_LABEL: Record<Decision["kind"], string> = {
  merge: "merged", rename: "renamed", remove: "withdrew", delete: "deleted",
  keep: "kept", park: "set aside", unpark: "brought back", dismiss: "turned down",
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

/** the left rail: how the book got to be the way it is, in three numbers.
    No filters: the ledger is a record, and a record shows every row — what a
    reversed decision needs is a LOOK, not a hiding place (see .dvRow.undone). */
export function DecisionsSide() {
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
        <p className="dvNote">{undone} reversed — struck through below, still counted.</p>
      )}
    </>
  );
}

export function DecisionsList() {
  const ledger = useStore((s) => s.ledger);
  const codebook = useStore((s) => s.codebook);
  const setActive = useStore((s) => s.setActive);
  const [copied, setCopied] = useState(false);
  const para = useMemo(() => methodsParagraph(ledger, Object.keys(codebook)), [ledger, codebook]);
  const rows = useMemo(() => ledger.map((d, i) => ({ d, i })).reverse(), [ledger]);
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
