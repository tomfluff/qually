// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the grounding run (F1 of AI-ASSIST.md) — same contract as the
// scan modal: see exactly what leaves the device before anything is sent.
// Scope: every ACCEPTED segment of every loaded transcript that doesn't already
// hold a valid grounding (hash — recode/resize/edit invalidates).
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { MODELS, modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { excerptOf } from "../contract/excerpt";
import { chunksOfItems, renderGroundChunk, estimateGroundTokens, groundChunk, groundHash, type GroundItem } from "../ai/ground";
import { announce } from "../announce";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

export function GroundModal({ onClose }: { onClose: () => void }) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const aiGrounds = useStore((s) => s.aiGrounds);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ grounded: number; empty: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useDialogFocus();
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
      const excerpt = excerptOf(transcripts[s.pid].lines
        .filter((l) => l.id >= s.start && l.id <= s.end)
        .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
      return { sid: s.sid, code: s.code, def: codebook[s.code]?.def ?? "", excerpt };
    })
    .filter((it) => !!it.excerpt),
  [segments, transcripts, codebook]);
  const alreadyGrounded = useMemo(
    () => eligible.filter((it) => aiGrounds[it.sid]?.hash === groundHash(it.code, it.excerpt)).length,
    [eligible, aiGrounds]);
  const todo = useMemo<GroundItem[]>(() => reground ? eligible
    : eligible.filter((it) => aiGrounds[it.sid]?.hash !== groundHash(it.code, it.excerpt)),
  [eligible, aiGrounds, reground]);

  const chunks = useMemo(() => chunksOfItems(todo), [todo]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateGroundTokens(c, red), 0), [chunks, red]);
  const redactions = useMemo(() => todo.reduce((n, it) => n + red.count(it.excerpt), 0), [todo, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(todo.length * 30)));
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
    abort.current = new AbortController();
    const st = useStore.getState();
    let grounded = 0, empty = 0, cost = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { recs, usage } = await groundChunk({
          key, model: model.id, items: chunks[i], redaction: red, signal: abort.current.signal,
        });
        st.addGrounds(recs);
        st.logAiCall({
          at: new Date().toISOString(), model: model.id, task: "ground", pid: pids.join("+"),
          lines: chunks[i].length, redactions: chunks[i].reduce((n, it) => n + red.count(it.excerpt), 0),
          inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
        });
        for (const r of Object.values(recs)) r.quotes.length ? grounded++ : empty++;
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ grounded, empty, cost });
      announce(`Grounding complete: ${grounded} segment${grounded === 1 ? "" : "s"} grounded.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      announce(`Grounding failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="about-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="about imp ai-check" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="ground-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="ground-title">Ground assigned codes</h2>
          <button className="btn iconbtn" onClick={onClose} disabled={busy} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

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
                For each coded excerpt, the AI quotes the passages a coder would point to
                as the reason the code applies — the evidence for <b>your</b> coding. It
                proposes nothing.
              </p>
              <div className="ai-sec">Model <span className="ai-sec-hint">this run only — the default lives in Settings → AI</span></div>
              <div className="ai-models">
                {MODELS.map((m) => (
                  <button key={m.id} className={modelId === m.id ? "on" : ""}
                    title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
                    onClick={() => setModelId(m.id)}>{m.name}</button>
                ))}
              </div>
              {alreadyGrounded > 0 && (
                <label className="ai-spk" style={{ marginBottom: 8 }}>
                  <input type="checkbox" checked={reground} onChange={() => setReground((v) => !v)} />
                  <span>Re-ground the {alreadyGrounded} segment{alreadyGrounded === 1 ? "" : "s"} that
                  already {alreadyGrounded === 1 ? "has" : "have"} a grounding{" "}
                  <em>replaces the current quotes</em></span>
                </label>
              )}
              {todo.length === 0 ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  Every accepted segment of the loaded transcripts already has a current
                  grounding. Tick re-ground above to run them again anyway — or recode,
                  resize, or edit a segment to make it eligible.
                </p>
              ) : (
                <>
                  <div className="ai-warn">
                    <b>This sends {todo.length} coded excerpt{todo.length === 1 ? "" : "s"} from{" "}
                    {pids.join(", ")} to OpenAI.</b> Interview transcripts are participant data —
                    make sure this is allowed by your consent form and ethics approval.
                  </div>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}{chunks[0].length > 3 ? "\n…" : ""}</pre>
                  </div>
                  <div className="ai-facts">
                    <span>excerpts <b>{todo.length}</b></span>
                    <span>requests <b>{chunks.length}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                  </div>
                  {model.id.includes("luna") && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      Grounding is interpretive — <b>Terra</b> (Settings → AI) usually reads
                      coded excerpts better than Luna.
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
                  {busy ? `Grounding… ${progress}/${chunks.length}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
                </button>
                <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                  {busy ? "Stop" : "Cancel — send nothing"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
