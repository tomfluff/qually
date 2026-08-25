// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the Code map's group-by-similarity run — same contract as
// the merge/scan modals: see exactly what leaves the device before sending.
// Scope: every code with at least one accepted segment (same payload as the
// merge scan). Proposes a grouping; the map is where you reshape it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { MERGE_EXEMPLARS, renderMergePayload, type MergeCodeInput } from "../ai/dedupe";
import { gatherCodeEvidence } from "../codeEvidence";
import { clusterCodes, estimateClusterTokens, type ClusterGroup } from "../ai/cluster";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";

export function GroupModal({ transient = false, onGroups, onReconcileInstead, onClose }: {
  // transient: the result is an arrangement LENS, not saved theme groups
  transient?: boolean;
  onGroups: (g: ClusterGroup[]) => void;
  onReconcileInstead: () => void;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const hasGroups = useStore((s) => s.codeGroups.length > 0);
  // theming an uncleaned codebook bakes redundancy into the themes — warn,
  // never refuse (design decision)
  const pending = useStore((s) => s.codeClusters.length + s.codePlan.length);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ found: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // one input per code that has accepted segments — name + def + up to N excerpts
  const codes = useMemo<MergeCodeInput[]>(() =>
    gatherCodeEvidence(segments, transcripts, codebook, MERGE_EXEMPLARS),
  [segments, transcripts, codebook]);

  const exCount = codes.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => estimateClusterTokens(codes, red, transient ? "areas" : "usage"), [codes, red, transient]);
  const redactions = useMemo(() => codes.reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [codes, red]);
  // group names + memberships + rationales, plus low-effort reasoning billed
  // at the OUTPUT rate (see DescribeModal). Overshoot: this sits next to Send.
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(codes.length * 60)) + 400);
  const preview = renderMergePayload(codes, red);
  const enough = codes.length >= 4;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(transient ? `Sorting ${codes.length} codes into areas…` : `Grouping ${codes.length} codes by similarity…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      const { groups, usage } = await clusterCodes({
        key, model: model.id, codes, redaction: red,
        // the map's view wants a few broad shelves; theming wants usage groups
        kind: transient ? "areas" : "usage",
        signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "group", pid: "(codebook)",
        lines: codes.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      onGroups(groups);
      setDone({ found: groups.length, cost: usage.costUsd });
      earcon.aiDone();
      announce(groups.length
        ? `${groups.length} ${transient ? "area" : "similarity group"}${groups.length === 1 ? "" : "s"} laid out on the map.`
        : `No ${transient ? "areas" : "similarity groups"} stood out.`);
    } catch (e) {
      // the request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete)
      useStore.getState().logAiIncomplete(e, { model: model.id, task: "group", pid: "(codebook)", lines: codes.length, redactions });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Grouping failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={transient ? "Sort the map into areas" : "Group codes by similarity"} busy={busy} onClose={onClose}>
        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                {done.found === 0
                  ? <>No {transient ? "areas" : "similarity groups"} stood out — the codebook reads as distinct usages.</>
                  : transient
                    ? <>Arranged the map into <b>{done.found} area{done.found === 1 ? "" : "s"}</b> — shelves for
                      finding codes worth regrouping. Select codes in one and act on them as usual;
                      switch Arrange back to Free-form for your own layout. Nothing was saved or changed.</>
                    : <>Laid out <b>{done.found} group{done.found === 1 ? "" : "s"}</b> as islands on the map —
                      drag codes between them, rename or dissolve any of them. The codes themselves are untouched.</>}
              </p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                The AI reads your codebook — definitions and a few excerpts per code — and proposes {transient
                  ? <>a handful of broad areas: shelves for finding your way around a long
                    codebook. A way of looking — nothing is renamed, merged, or saved.</>
                  : <>THEME groups: codes that belong together analytically. They land on the
                    map as islands for you to reshape; no code is renamed, merged, or removed.</>}
                {!transient && hasGroups && <> <b>Your current groups are replaced.</b></>}
              </p>
              {pending > 0 && !transient && (
                <div className="ai-warn">
                  <b>{pending} consolidation proposal{pending === 1 ? " is" : "s are"} still pending.</b>{" "}
                  Theming an uncleaned codebook bakes redundancy into the themes — consider finishing
                  the merges first.{" "}
                  <button className="btn" onClick={onReconcileInstead}>Go to Consolidate</button>
                </div>
              )}
              {enough && (
                <div className="ai-warn">
                  <b>This sends {codes.length} code{codes.length === 1 ? "" : "s"} — names, definitions,
                  and up to {MERGE_EXEMPLARS} excerpts each — to OpenAI.</b> Excerpts are participant
                  data; make sure this is allowed by your consent form and ethics approval.
                </div>
              )}
              <ModelPicker modelId={modelId} onPick={setModelId} />
              {!enough ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  Grouping needs at least four codes that have coded segments. Code a bit
                  more, then come back.
                </p>
              ) : (
                <>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}</pre>
                  </div>
                  <div className="ai-facts">
                    <span>codes <b>{codes.length}</b></span>
                    <span>excerpts <b>{exCount}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                  </div>
                </>
              )}
            </div>
            {err && <div className="ai-err">{err}</div>}
            {!enough ? (
              <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? "Grouping…" : "Send 1 request to OpenAI"}
                </button>
                <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                  {busy ? "Stop" : "Cancel — send nothing"}
                </button>
              </div>
            )}
          </>
        )}
    </AiModal>
  );
}
