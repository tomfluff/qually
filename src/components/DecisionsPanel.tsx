// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Assist tab's Decisions panel: what you decided about the codebook and the
// model's proposed evidence structure, why, and whose idea it was. The AI log
// next door records what was ASKED of the model; this records what you did with
// the answer — the half a reader of the paper actually asks about.
//
// Nothing here is a control. You cannot undo from this list (the history stack
// owns that, and a decision reversed weeks later is a new decision anyway) and
// nothing can be edited away: a reversed decision stays, marked. The panel's
// whole job is to be readable and exportable.
import { useMemo, useState } from "react";
import { useStore, liveCodes, type Decision } from "../state/store";
import { aiSpend, foldDecisions, originCounts, methodsParagraph, proposalCounts,
  type AiSpend, type OriginCounts, type ProposalCounts } from "../provenance";
import { preselectBrowse } from "./BrowseView";
import { Icon } from "./Icon";

const KIND_LABEL: Record<Decision["kind"], string> = {
  merge: "merged", rename: "renamed", remove: "withdrew", delete: "deleted",
  keep: "kept", define: "kept apart", park: "set aside", unpark: "brought back", dismiss: "turned down",
  "accept-coding": "accepted", "reject-coding": "turned down", "discard-coding": "discarded",
  "accept-section": "accepted", "reject-section": "turned down", "discard-section": "discarded",
};
export const decisionKindLabel = (d: Decision) => KIND_LABEL[d.kind] ?? d.kind;
export const decisionRowKey = (d: Decision) => `${d.at}:${d.kind}`;
// where the idea came from — never who performed it. Every row is your decision.
const SOURCE_LABEL: Record<Decision["source"], string> = {
  you: "your call", wording: "matched on wording", ai: "AI proposal",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const decisionMovedLabel = (d: Decision) => {
  const n = d.moved ?? 0;
  if (d.kind === "accept-coding" || d.kind === "reject-coding" || d.kind === "discard-coding") {
    if (d.kind === "discard-coding") return `${n} coding${n === 1 ? "" : "s"} cleared without a verdict`;
    const disposition = d.kind === "accept-coding" ? "accepted"
      : "rejected";
    return `${n} coding${n === 1 ? "" : "s"} ${disposition}`;
  }
  if (d.kind === "accept-section" || d.kind === "reject-section" || d.kind === "discard-section") {
    if (d.kind === "discard-section") return `${n} section${n === 1 ? "" : "s"} cleared without a verdict`;
    const disposition = d.kind === "accept-section" ? "accepted"
      : "rejected";
    return `${n} section${n === 1 ? "" : "s"} ${disposition}`;
  }
  return `${n} excerpt${n === 1 ? "" : "s"} ${d.kind === "merge" ? "moved" : d.kind === "remove" ? "rejected" : "gone"}`;
};

// The "a ← b" separator says b was FOLDED INTO a — true of a merge, and of a
// rename read as "the name now ← the name before". A verdict or discard row
// carries an unordered LIST of what one gesture touched, and drawing the arrow
// there claims a merge that never happened.
export const decisionCodesAreAFold = (d: Decision) => d.kind === "merge" || d.kind === "rename";

export const decisionCodeCanLink = (d: Decision, codebook: Record<string, unknown>, code: string) =>
  !(d.kind === "accept-section" || d.kind === "reject-section" || d.kind === "discard-section")
  && code in codebook;

/** the left rail: how the book got to be the way it is, in three numbers.
    No filters: the ledger is a record, and a record shows every row — what a
    reversed decision needs is a LOOK, not a hiding place (see .dvRow.undone). */
export function DecisionsSide() {
  const ledger = useStore((s) => s.ledger);
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const stretches = useStore((s) => s.stretches);
  const aiLog = useStore((s) => s.aiLog);
  const counts = useMemo(() => originCounts(ledger, Object.keys(codebook)), [ledger, codebook]);
  const codings = useMemo(() => proposalCounts(ledger, segments, "discard-coding"), [ledger, segments]);
  const sections = useMemo(() => proposalCounts(ledger, stretches, "discard-section"), [ledger, stretches]);
  const spend = useMemo(() => aiSpend(aiLog), [aiLog]);
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
        {/* stated, never scored: the number is the whole intervention.
            Scoped to code IDENTITY on purpose — these three numbers come from
            codeOrigins, which reads renames and merges only. A model that
            proposed excerpts or sections shaped no NAME here, and the sentence
            must not be read as "the model did nothing": the methods paragraph
            beside it counts those verdicts, and an unscoped claim here would
            flatly contradict it. */}
        <p className="dvNote">
          {counts.ai === 0
            ? "No proposal named or merged a code in this book."
            : `A model's proposal shaped the name of ${pct(counts.ai)}% of the codes you have now.`}
        </p>
      </div>
      {undone > 0 && (
        <p className="dvNote">{undone} reversed — struck through below, still counted.</p>
      )}
      {/* What the model proposed and what you did with it. The methods paragraph
          states these same numbers in prose, from the same function — this is
          the version you can read at a glance while you work. */}
      <Proposals what="coding" counts={codings} />
      <Proposals what="section" counts={sections} />
      <Spend spend={spend} />
    </>
  );
}

// The four states a proposal can be in, in the order a researcher works through
// them: settled yes, settled no, still theirs to answer, cleared without an
// answer. Rendered for codings and for sections separately — they are different
// objects, and one total over both would answer neither question.
const PROPOSAL_STATES = [
  { key: "accepted", label: "accepted" },
  { key: "rejected", label: "turned down" },
  { key: "waiting", label: "waiting on you" },
  { key: "discarded", label: "cleared without a verdict" },
] as const;

function Proposals({ what, counts }: { what: "coding" | "section"; counts: ProposalCounts }) {
  // A study that has never asked for this kind of proposal has no story here;
  // four zeroes would only take up room the rest of the panel needs.
  if (!counts.total) return null;
  const pct = (n: number) => Math.round((n / counts.total) * 100);
  const plural = (n: number) => `${n} ${what}${n === 1 ? "" : "s"}`;
  return (
    <div className="dvWho dvBlock">
      <h3 className="dvHead">Proposed {what}s</h3>
      <div className="dvBar" role="img"
        aria-label={PROPOSAL_STATES.filter((s) => counts[s.key] > 0)
          .map((s) => `${plural(counts[s.key])} ${s.label}`).join(", ")}>
        {PROPOSAL_STATES.map((s) => counts[s.key] > 0 && (
          <span key={s.key} className={"dvSeg p-" + s.key} style={{ width: `${pct(counts[s.key])}%` }} />
        ))}
      </div>
      <ul className="dvKeys">
        {PROPOSAL_STATES.map((s) => (
          // every state stays listed, zero or not: the list is the bar's key, and
          // a key that appears and disappears cannot be read against it. A zero
          // just stops shouting — quiet by colour, never by hiding.
          <li key={s.key} className={counts[s.key] ? "" : "zero"}>
            <span className={"dvDot p-" + s.key} /><b>{counts[s.key]}</b> {s.label}</li>
        ))}
      </ul>
      {/* "on the record", not "in all": a proposal can leave without a row —
          clearing settled codings logs nothing, deleting a code takes its AI
          codings with it, and unmarking one candidate section writes no
          decision. This total is what the corpus and the ledger between them
          can still show, which is also what the methods paragraph claims. */}
      <p className="dvNote">{counts.total} proposal{counts.total === 1 ? "" : "s"} on the record.</p>
    </div>
  );
}

// The bill, from the AI log — the same rows the exported ai-provenance.csv
// carries, added up. The token counts are what the API reported; the money is
// NOT, and cannot be: costOf prices them from a table baked into this build
// (ai/openai.ts), which knows nothing about cached-input discounts or any price
// change since it shipped. An offline app cannot know today's rates, so the
// figure is named an estimate rather than quietly presented as an invoice.
function Spend({ spend }: { spend: AiSpend }) {
  if (!spend.calls) return null;
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="dvWho dvBlock">
      <h3 className="dvHead">What the model cost</h3>
      <dl className="dvSpend">
        <dt>Requests</dt><dd>{n(spend.calls)}</dd>
        <dt>Tokens in</dt><dd>{n(spend.inTok)}</dd>
        <dt>Tokens out</dt><dd>{n(spend.outTok)}</dd>
        <dt>Est. cost</dt><dd className="dvCost">${spend.costUsd.toFixed(4)}</dd>
      </dl>
      <p className="dvNote">Tokens are what the API reported. The cost is those tokens
        at the rates this build was written with — your invoice is the real number.</p>
      {/* An aborted or failed request was still sent and may still have been
          charged, with nothing reported back to count — so say the total is a
          floor rather than let it read as the whole bill. */}
      {spend.unfinished > 0 && (
        <p className="dvNote">{spend.unfinished} request{spend.unfinished === 1 ? "" : "s"} did
          not finish. {spend.unfinished === 1 ? "It was" : "They were"} still sent, and
          reported no tokens — the total above is a floor.</p>
      )}
    </div>
  );
}

export function DecisionsList() {
  const ledger = useStore((s) => s.ledger);
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const stretches = useStore((s) => s.stretches);
  const setActive = useStore((s) => s.setActive);
  const [copied, setCopied] = useState(false);
  // liveCodes, not Object.keys: the paragraph says "consolidated to N codes …
  // M set aside" — counting the set-aside ones in N contradicts its own sentence
  const para = useMemo(() => methodsParagraph(ledger, liveCodes(codebook), { segments, stretches }),
    [ledger, codebook, segments, stretches]);
  // The ledger and its undo indices stay exact; only this reader compresses a
  // run of equivalent proposal dispositions into something a person can scan.
  const rows = useMemo(() => foldDecisions(ledger).reverse(), [ledger]);
  // a decision names codes; the excerpts behind them are one click away, and
  // for a code that still exists that is where the reasoning can be checked
  const openCode = (c: string) => { preselectBrowse([c]); setActive("browse"); };

  if (!ledger.length) {
    return (
      <div className="empty">
        Nothing decided yet. Settle a proposed coding or section, or merge, rename or
        withdraw a code — every decision lands here with its reason, ready to export
        as the appendix your methods section needs.
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
        {/* Consolidation and discards come from history; current proposal
            verdicts come from the corpus they describe. None is model-authored:
            this is a claim about your own conduct, so nothing else may author it. */}
        <p>{para}</p>
      </div>
      <ol className="dvList">
        {rows.map((d) => (
          <li key={decisionRowKey(d)} className={"dvRow" + (d.undone ? " undone" : "")}>
            <span className={"dvKind " + d.kind}>{decisionKindLabel(d)}</span>
            <div className="dvBody">
              <div className={"dvCodes" + (decisionCodesAreAFold(d) ? "" : " list")}>
                {d.codes.map((c, n) => (
                  // Gone codes have nothing to open. Section labels are not
                  // codes at all, even if one happens to share their spelling.
                  decisionCodeCanLink(d, codebook, c) ? (
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
                  <span className="dvSize">{decisionMovedLabel(d)}</span>
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
