// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the grounding run (F1 of AI-ASSIST.md) — same contract as the
// scan modal: see exactly what leaves the device before anything is sent.
// Scope: every ACCEPTED segment of every loaded transcript that doesn't already
// hold a valid grounding (hash — recode/resize/edit invalidates).
import { useEffect, useMemo, useRef, useState } from "react";
import { linesOf, useStore } from "../state/store";
import { hasTranslation } from "../lineText";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { chunksOfItems, renderGroundChunk, estimateGroundTokens, groundChunk, groundHash, type GroundItem } from "../ai/ground";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

export function GroundModal({ onClose }: { onClose: () => void }) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const codebook = useStore((s) => s.codebook);
  const aiGrounds = useStore((s) => s.aiGrounds);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ grounded: number; empty: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  // The denominator has to be FROZEN when the run starts. `chunks` is derived
  // from `todo`, which subscribes to the store the run itself writes to, so it
  // shrinks between requests while `progress` counts the run closure's own
  // snapshot: the button, and a screen reader reading it on focus, could say
  // "8/4". A count that goes backwards mid-run is worse than no count.
  const [total, setTotal] = useState(0);

  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  // per-run model override — starts at the Settings default, changes THIS run only
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);
  // re-ground: ignore existing records and run everything again (e.g. after a
  // prompt change — old results don't invalidate by hash, only by content)
  const [reground, setReground] = useState(false);

  const eligible = useMemo<GroundItem[]>(() => segments
    .filter((s) => s.status === "accepted" && transcripts[s.pid])
    .map((s) => {
      const excerpt = segExcerpt(s, linesOf(transcripts, lang, s.pid)).excerpt;
      return { sid: s.sid, code: s.code, def: codebook[s.code]?.def ?? "", excerpt };
    })
    .filter((it) => !!it.excerpt),
  [segments, transcripts, lang, codebook]);
  const alreadyGrounded = useMemo(
    () => eligible.filter((it) => aiGrounds[it.sid]?.hash === groundHash(it.code, it.excerpt)).length,
    [eligible, aiGrounds]);
  // Grounding is keyed to the excerpt it was computed against, and there is one
  // slot per segment: a record whose hash no longer matches will be paid for
  // again and replaced. A reading-language flip is one way to get there — but
  // so is recoding, resizing or editing the segment, and the count cannot tell
  // them apart, so the note says both rather than naming the wrong cause. It is
  // only worth raising at all where a translation exists to have flipped to.
  const anyTranslation = useMemo(
    () => Object.values(transcripts).some((t) => hasTranslation(t.lines)), [transcripts]);
  const staleGrounded = useMemo(
    () => (anyTranslation
      ? eligible.filter((it) => aiGrounds[it.sid]
        && aiGrounds[it.sid].hash !== groundHash(it.code, it.excerpt)).length
      : 0),
    [eligible, aiGrounds, anyTranslation]);
  const todo = useMemo<GroundItem[]>(() => reground ? eligible
    : eligible.filter((it) => aiGrounds[it.sid]?.hash !== groundHash(it.code, it.excerpt)),
  [eligible, aiGrounds, reground]);

  const chunks = useMemo(() => chunksOfItems(todo, red), [todo, red]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateGroundTokens(c, red), 0), [chunks, red]);
  const redactions = useMemo(() => todo.reduce((n, it) => n + red.count(it.excerpt) + red.count(it.def), 0), [todo, red]);
  // verdicts are short but EVERY chunk bills its own low-effort reasoning at
  // the OUTPUT rate (see DescribeModal). Overshoot: this sits next to Send.
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(todo.length * 30)) + chunks.length * 200);
  const preview = chunks.length ? renderGroundChunk(chunks[0].slice(0, 3), red) : "";
  const pids = useMemo(() => [...new Set(todo.map((it) =>
    segments.find((s) => s.sid === it.sid)?.pid ?? ""))].filter(Boolean), [todo, segments]);

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Grounding ${todo.length} coded segment${todo.length === 1 ? "" : "s"} with AI…`);
    earcon.aiStart();
    abort.current = new AbortController();
    setTotal(chunks.length);
    const st = useStore.getState();
    let grounded = 0, empty = 0, cost = 0;
    // hoisted out of the loop so the catch can name the one chunk in flight
    let i = 0;
    try {
      for (; i < chunks.length; i++) {
        // Stop landing between chunks: the next fetch would reject as an
        // AbortError without dispatching, and the catch would then disclose
        // items that never left. Nothing more is sent, so nothing more is logged.
        if (abort.current.signal.aborted) return;
        const { recs, usage } = await groundChunk({
          key, model: model.id, items: chunks[i], redaction: red, signal: abort.current.signal,
        });
        st.addGrounds(recs);
        st.logAiCall({
          at: new Date().toISOString(), model: model.id, task: "ground", pid: pids.join("+"),
          lines: chunks[i].length, redactions: chunks[i].reduce((n, it) => n + red.count(it.excerpt) + red.count(it.def), 0),
          inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
        });
        for (const r of Object.values(recs)) r.quotes.length ? grounded++ : empty++;
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ grounded, empty, cost });
      earcon.aiDone();
      announce(`Grounding complete: ${grounded} segment${grounded === 1 ? "" : "s"} grounded.`);
    } catch (e) {
      // The request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete). Only the
      // chunk in flight: the earlier chunks logged themselves on success, and
      // the later ones never left, so logging the whole run here would count
      // the first twice and disclose the second falsely.
      const c = chunks[i];
      if (c) useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "ground", pid: pids.join("+"),
        lines: c.length, redactions: c.reduce((n, it) => n + red.count(it.excerpt) + red.count(it.def), 0),
      });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Grounding failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Ground assigned codes" busy={busy} onClose={onClose}>
        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                {done.grounded === 0
                  ? <>No spans stood out — the model only marks what clearly carries a code.</>
                  : <>Marked the grounding words in <b>{done.grounded} segment{done.grounded === 1 ? "" : "s"}</b>
                    {done.empty > 0 && <> ({done.empty} had no single span standing out)</>} — they're
                    emphasised in the excerpts here and in each segment's popover.</>}
              </p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                Quotes the passage that earned each code — the evidence for <b>your</b>{" "}
                coding. It proposes nothing.
              </p>
              {/* above the controls, not below them: at a normal window size this box
                  scrolled out of the scrolling body while Send stayed visible and
                  enabled -- backwards for the one sentence naming participant data */}
              {todo.length > 0 && (
                <div className="ai-warn">
                  <b>This sends {todo.length} coded excerpt{todo.length === 1 ? "" : "s"} from{" "}
                  {pids.join(", ")} to OpenAI.</b> Interview transcripts are participant data —
                  make sure this is allowed by your consent form and ethics approval.
                </div>
              )}
              <ModelPicker modelId={modelId} onPick={setModelId} />
              {alreadyGrounded > 0 && (
                <label className="ai-spk" style={{ marginBottom: 8 }}>
                  <input type="checkbox" checked={reground} onChange={() => setReground((v) => !v)} />
                  <span>Re-ground the {alreadyGrounded} segment{alreadyGrounded === 1 ? "" : "s"} that
                  already {alreadyGrounded === 1 ? "has" : "have"} a grounding{" "}
                  <em>replaces the current quotes</em></span>
                </label>
              )}
              {staleGrounded > 0 && (
                <div className="settings-note" style={{ marginBottom: 8 }}>
                  {staleGrounded === 1 ? "1 segment already holds" : `${staleGrounded} segments already hold`} a
                  grounding made in the other reading, or before the excerpt last changed.
                  Grounding is held per segment rather than per reading, so running
                  now pays for {staleGrounded === 1 ? "it" : "them"} again and replaces
                  what {staleGrounded === 1 ? "is" : "are"} there.
                </div>
              )}
              {todo.length === 0 ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  Every accepted segment of the loaded transcripts already has a current
                  grounding. Tick re-ground above to run them again anyway — or recode,
                  resize, or edit a segment to make it eligible.
                </p>
              ) : (
                <>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}{chunks[0].length > 3 || chunks.length > 1 ? "\n…" : ""}</pre>
                    {/* the box is headed "exactly what leaves your device" and shows
                        ONE request; with variable packing two singleton chunks used to
                        render with no ellipsis and no hint that more was going */}
                    {chunks.length > 1 && (
                      <p className="ai-payload-more">First of <b>{chunks.length}</b> requests — the rest carry the same shape.</p>
                    )}
                  </div>
                  <div className="ai-facts">
                    <span>excerpts <b>{todo.length}</b></span>
                    <span>requests <b>{chunks.length}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
                  {model.id.includes("luna") && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      <b>Terra</b> (Settings → AI) usually reads coded excerpts better than Luna.
                    </div>
                  )}
                </>
              )}
            </div>

            {err && <div className="ai-err">{err}</div>}

            {todo.length === 0 ? (
              <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? `Grounding… ${progress}/${total}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
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
