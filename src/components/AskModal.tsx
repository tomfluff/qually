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
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";

// Beyond this the payload is too big to answer well, whatever the context window
// allows: past it the ask is really "read my study", and the honest move is to
// say so and let the researcher narrow rather than quietly send it anyway.
const MAX_TOK = 120_000;

export function AskModal({ question, scope, onAsked, onClose }: {
  question: string; scope: AskScope;
  // told only when an answer was actually WRITTEN — the question has moved into
  // the record then, so the box is free. On a failure or a cancel it stays put:
  // nothing was saved, and retyping it is the last thing anyone wants to do.
  onAsked: () => void;
  onClose: () => void;
}) {
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // `busy` is state, so it can't gate a second click landing in the same tick —
  // and this click spends money. The ref is the real guard; `busy` is the label.
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; abort.current?.abort(); }, []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // built from the store ONCE, and the same object feeds the preview, the
  // estimate, the request and the citation check — a corpus that differed
  // between the preview and the send would make the gate a lie
  const corpus = useMemo(() => buildCorpus(useStore.getState(), scope), [scope]);
  const preview = useMemo(() => renderAskPayload(question, corpus, red), [question, corpus, red]);
  // measured off the preview, not built a second time: the corpus can run to tens
  // of thousands of tokens and rendering it twice per change is real work
  const inTok = useMemo(() => estimateAskTokens(preview), [preview]);
  // every field the renderer redacts is counted — ref, speaker and time
  // included, or the facts row under-reports what actually got replaced
  const redactions = useMemo(() =>
    corpus.excerpts.reduce((n, x) => n + red.count(x.text) + red.count(x.ref)
      + red.count(x.speaker ?? "") + red.count(x.time ?? ""), 0)
    + corpus.events.reduce((n, x) => n + red.count(x.text) + red.count(x.type) + red.count(x.ref), 0)
    + corpus.codes.reduce((n, c) => n + red.count(c.def), 0)
    + red.count(question), [corpus, red, question]);
  // an answer runs a handful of points with refs; reasoning bills at the output
  // rate on top, so the estimate errs high rather than low (see DescribeModal)
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(3000)) + 400);
  const items = corpus.excerpts.length + corpus.events.length;
  const tooBig = inTok > MAX_TOK;

  const run = async () => {
    if (inFlight.current) return;
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    inFlight.current = true;
    setBusy(true); setErr(null);
    announce("Asking your coded material…");
    earcon.aiStart();
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const { reply, usage } = await askQuestion({
        key, model: model.id, question, corpus, redaction: red, signal: ctl.signal,
      });
      // Stop (or a close) can land while the reply is in transit or being parsed:
      // an answer written after the researcher cancelled is one they never agreed
      // to keep, and it would sit in the project as if they had.
      if (ctl.signal.aborted || !alive.current) return;
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "ask", pid: "(corpus)",
        lines: items, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      useStore.getState().addAnswer({
        question, points: reply.points, unsupported: reply.unsupported,
        scope, model: model.id, costUsd: usage.costUsd,
      });
      earcon.aiDone();
      announce(reply.points.length
        ? `${reply.points.length} point${reply.points.length === 1 ? "" : "s"}, grounded in your material.`
        : "Nothing in the material in scope answers that.");
      onAsked();
      onClose();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Ask failed: ${msg}`, { assertive: true });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
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
