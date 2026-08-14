// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for one question put to the coded material. Same contract as the
// other AI modals: see exactly what leaves the device before it goes. The answer
// is written straight into the project when it lands — it is a study artifact,
// and the citation check has already thrown out anything the corpus didn't carry,
// so there is nothing left for a review step to decide.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { askQuestion, renderAskPayload, estimateAskTokens } from "../ai/ask";
import { buildCorpus, type AskScope } from "../askCorpus";
import { announce } from "../announce";
import { AiModal, ModelPicker } from "./AiModal";

// Beyond this the payload is too big to answer well, whatever the context window
// allows: past it the ask is really "read my study", and the honest move is to
// say so and let the researcher narrow rather than quietly send it anyway.
const MAX_TOK = 120_000;

export function AskModal({ question, scope, onClose }: {
  question: string; scope: AskScope; onClose: () => void;
}) {
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // built from the store ONCE, and the same object feeds the preview, the
  // estimate, the request and the citation check — a corpus that differed
  // between the preview and the send would make the gate a lie
  const corpus = useMemo(() => buildCorpus(useStore.getState(), scope), [scope]);
  const inTok = useMemo(() => estimateAskTokens(question, corpus, red), [question, corpus, red]);
  const redactions = useMemo(() =>
    corpus.excerpts.reduce((n, x) => n + red.count(x.text), 0)
    + corpus.events.reduce((n, x) => n + red.count(x.text) + red.count(x.type), 0)
    + corpus.codes.reduce((n, c) => n + red.count(c.def), 0)
    + red.count(question), [corpus, red, question]);
  // an answer runs a handful of points with refs; reasoning bills at the output
  // rate on top, so the estimate errs high rather than low (see DescribeModal)
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(3000)) + 400);
  const preview = useMemo(() => renderAskPayload(question, corpus, red), [question, corpus, red]);
  const items = corpus.excerpts.length + corpus.events.length;
  const tooBig = inTok > MAX_TOK;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce("Asking your coded material…");
    abort.current = new AbortController();
    try {
      const { reply, usage } = await askQuestion({
        key, model: model.id, question, corpus, redaction: red, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "ask", pid: "(corpus)",
        lines: items, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      useStore.getState().addAnswer({
        question, points: reply.points, unsupported: reply.unsupported,
        scope, model: model.id, costUsd: usage.costUsd,
      });
      announce(reply.points.length
        ? `${reply.points.length} point${reply.points.length === 1 ? "" : "s"}, grounded in your material.`
        : "Nothing in the material in scope answers that.");
      onClose();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      announce(`Ask failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Ask your coded material" busy={busy} onClose={onClose}>
      <div className="ai-body nicescroll">
        <p className="about-lede">
          The AI answers from your codebook, the excerpts you coded and your event log —
          it has not read the transcripts. Each point comes back with the refs it rests on,
          and a ref that wasn't in what you sent is thrown away rather than shown.
        </p>
        <div className="ai-warn">
          <b>This sends {items} item{items === 1 ? "" : "s"} — {corpus.excerpts.length} coded
          excerpt{corpus.excerpts.length === 1 ? "" : "s"}, {corpus.events.length} event
          {corpus.events.length === 1 ? "" : "s"} and your question — to OpenAI.</b> Excerpts
          and notes are participant data; make sure this is allowed by your consent form and
          ethics approval.
        </div>
        {tooBig && (
          <p className="ai-err" style={{ marginTop: 8 }}>
            That's {inTok.toLocaleString()} tokens — more than one question can be answered
            well from. Narrow the scope on the left (fewer transcripts, or fewer codes) and ask again.
          </p>
        )}
        <ModelPicker modelId={modelId} onPick={setModelId} />
        <div className="ai-sec">Your question</div>
        <div className="askQuoted">{question}</div>
        <div className="ai-payload">
          <div className="ai-payload-head">
            <span className="eyebrow">Exactly what leaves your device</span>
            <span className="ai-model">{model.id}</span>
          </div>
          <pre className="nicescroll">{preview}</pre>
        </div>
        <div className="ai-facts">
          <span>excerpts <b>{corpus.excerpts.length}</b></span>
          <span>events <b>{corpus.events.length}</b></span>
          <span>codes <b>{corpus.codes.length}</b></span>
          <span>redacted <b>{redactions}</b></span>
          <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
          <span>≈ <b>${estCost.toFixed(4)}</b></span>
        </div>
      </div>

      {err && <div className="ai-err">{err}</div>}

      <div className="imp-actions">
        <button className="btn primary" onClick={run} disabled={busy || !items || tooBig}
          title={items ? undefined : "Nothing in scope to answer from"}>
          {busy ? "Asking…" : "Send 1 request to OpenAI"}
        </button>
        <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
          {busy ? "Stop" : "Cancel — send nothing"}
        </button>
      </div>
    </AiModal>
  );
}
