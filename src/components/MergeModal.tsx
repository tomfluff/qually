// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the merge-duplicates run (F2 of AI-ASSIST.md) — same contract
// as the scan/ground modals: see exactly what leaves the device before sending.
// Scope: every code that has at least one accepted segment, with up to
// MERGE_EXEMPLARS sample excerpts each. Proposes pairs; applies nothing.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { dedupeCodes, renderMergePayload, estimateMergeTokens, MERGE_EXEMPLARS,
  type MergeCodeInput, type MergeProposal } from "../ai/dedupe";
import { gatherCodeEvidence } from "../codeEvidence";
import { viewTranscripts } from "../lineText";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

export function MergeModal({ onProposals, onClose }: {
  onProposals: (p: MergeProposal[]) => void;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const codebook = useStore((s) => s.codebook);
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
    gatherCodeEvidence(segments, viewTranscripts(transcripts, lang), codebook, MERGE_EXEMPLARS),
  [segments, transcripts, lang, codebook]);

  const exCount = codes.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => estimateMergeTokens(codes, red), [codes, red]);
  const redactions = useMemo(() => codes.reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [codes, red]);
  // pairs + rationales, plus low-effort reasoning billed at the OUTPUT rate
  // (see DescribeModal). Overshoot: this sits next to the Send button.
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(codes.length * 60)) + 400);
  const preview = renderMergePayload(codes, red);
  const enough = codes.length >= 2;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Looking for near-duplicate codes across ${codes.length} codes…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      const { proposals, usage } = await dedupeCodes({
        key, model: model.id, codes, redaction: red, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "merge", pid: "(codebook)",
        lines: codes.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
      });
      onProposals(proposals.map((x) => ({ ...x, model: model.id })));
      setDone({ found: proposals.length, cost: usage.costUsd });
      earcon.aiDone();
      announce(proposals.length
        ? `${proposals.length} possible duplicate${proposals.length === 1 ? "" : "s"} to review.`
        : "No near-duplicate codes found.");
    } catch (e) {
      // the request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete)
      useStore.getState().logAiIncomplete(e, { model: model.id, task: "merge", pid: "(codebook)", lines: codes.length, redactions });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Merge check failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Merge duplicate codes" busy={busy} onClose={onClose}>

        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                {done.found === 0
                  ? <>No near-duplicates stood out — the codebook reads as distinct codes.</>
                  : <>Proposed <b>{done.found} merge{done.found === 1 ? "" : "s"}</b> for your review —
                    accept or skip each one in the list. Nothing has changed yet.</>}
              </p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                Proposes pairs that look like one concept under two labels. You accept
                each merge yourself.
              </p>
              {/* above the controls, not below them: at a normal window size this box
                  scrolled out of the scrolling body while Send stayed visible and
                  enabled -- backwards for the one sentence naming participant data */}
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
                  Merge needs at least two codes that have coded segments. Code a bit
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
                    <LangFact />
                  </div>
                  {model.id.includes("luna") && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      <b>Terra</b> usually judges code overlap better than Luna. Pick it above.
                    </div>
                  )}
                </>
              )}
            </div>

            {err && <div className="ai-err">{err}</div>}

            {!enough ? (
              <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? "Checking…" : "Send 1 request to OpenAI"}
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
