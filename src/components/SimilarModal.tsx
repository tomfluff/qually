// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the Code map's semantic-similarity pass. The quick wording
// pass stays local; this second look sends the focus code's evidence and the
// working codebook's definitions, so it carries the same disclosure contract
// as every other off-device AI action.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { AiError, costOf, estimateTokens, modelOf } from "../ai/openai";
import { redactor } from "../ai/redact";
import { estimateSimilarTokens, findSimilarWithAi, similarPayload, type SemanticMatch } from "../ai/similar";
import type { MergeCodeInput } from "../ai/dedupe";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

export function SimilarModal({ focus, book, onMatches, onClose }: {
  focus: MergeCodeInput;
  book: { name: string; def: string }[];
  onMatches: (matches: SemanticMatch[], cost: number) => void;
  onClose: () => void;
}) {
  const ai = useStore((s) => s.ai);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);
  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const payload = useMemo(() => similarPayload(focus, book, red), [focus, book, red]);
  const inTok = useMemo(() => estimateSimilarTokens(focus, book, red), [focus, book, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(240)));
  const definitions = Number(!!focus.def) + book.filter((c) => !!c.def).length;
  const ready = book.length > 0;

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ found: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const run = async () => {
    const key = getKey();
    if (!key) {
      const msg = "No API key set. Add one in Settings → AI.";
      setErr(msg); announce(msg, { assertive: true }); return;
    }
    if (!ready) return;
    setBusy(true); setErr(null);
    announce(`Finding semantic matches for ${focus.name}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    const call = {
      model: model.id, task: "similar", pid: `(similar to: ${focus.name})`,
      lines: book.length + 1, redactions: payload.redactions,
    };
    try {
      const { matches, usage } = await findSimilarWithAi({
        key, model: model.id, focus, book, redaction: red, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), ...call,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      onMatches(matches, usage.costUsd);
      setDone({ found: matches.length, cost: usage.costUsd });
      earcon.aiDone();
      announce(`${matches.length} semantic match${matches.length === 1 ? "" : "es"} for ${focus.name}`);
    } catch (e) {
      // The request was dispatched, so a failed or stopped run belongs in the
      // same provenance record as a completed one.
      useStore.getState().logAiIncomplete(e, call);
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Find similar failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={<>Find semantic matches for “{focus.name}”</>} busy={busy} onClose={onClose}>
      {done ? (
        <>
          <div className="ai-body">
            <p className="about-lede">
              {done.found === 0
                ? <>No semantic relatives stood out. This code may be doing its own work.</>
                : <><b>{done.found} semantic match{done.found === 1 ? "" : "es"}</b> added to the
                  map panel for you to review. Nothing was merged or regrouped.</>}
            </p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button ref={doneRef} className="btn primary" onClick={onClose}>Show matches</button></div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              The local wording pass has already checked for names that overlap. This optional AI pass
              looks for the same idea under different words and adds its ranked suggestions to the
              map panel. Nothing is merged, renamed, or regrouped.
            </p>
            {ready && (
              <div className="ai-warn">
                <b>This sends {book.length + 1} code name{book.length === 0 ? "" : "s"}, {definitions} definition{definitions === 1 ? "" : "s"},
                and {focus.excerpts.length} focus-code excerpt{focus.excerpts.length === 1 ? "" : "s"} to OpenAI in one request.</b>{" "}
                Excerpts are participant data; make sure this is allowed by your consent form and ethics approval.
              </div>
            )}
            <ModelPicker modelId={modelId} onPick={setModelId} disabled={busy} />
            {!ready ? (
              <p className="about-lede" style={{ marginTop: 10 }}>
                There are no other working codes to compare with this one.
              </p>
            ) : (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{payload.text}</pre>
                </div>
                <div className="ai-facts">
                  <span>codes <b>{book.length + 1}</b></span>
                  <span>definitions <b>{definitions}</b></span>
                  <span>excerpts <b>{focus.excerpts.length}</b></span>
                  <span>redacted <b>{payload.redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
              </>
            )}
          </div>
          {err && <div className="ai-err">{err}</div>}
          {!ready ? (
            <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
          ) : (
            <div className="imp-actions">
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? "Finding matches…" : "Send 1 request to OpenAI"}
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
