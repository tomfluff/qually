// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the code-suggestion run (F3 of AI-ASSIST.md) — same contract
// as the scan/ground/merge modals. Scope: the ACTIVE transcript, chunked into
// windows, each sent with the codebook (name + def + a couple of exemplars).
// Applies proposals as CANDIDATE segments (proposedBy "AI · <model>") for review;
// skips any range already carrying that code (accepted or rejected).
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { MODELS, modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { excerptOf } from "../contract/excerpt";
import { chunksOf, renderSuggestChunk, estimateSuggestTokens, suggestChunk, overlapsExisting,
  SUGGEST_EXEMPLARS, type SuggestCode } from "../ai/suggest";
import { announce } from "../announce";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

export function SuggestModal({ onClose }: { onClose: () => void }) {
  const pid = useStore((s) => s.active);
  const transcripts = useStore((s) => s.transcripts);
  const lines = transcripts[pid]?.lines ?? [];
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; skipped: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useDialogFocus();
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // the codebook as the model sees it: name + def + up to N exemplar excerpts (from
  // this study's accepted segments), which anchor what each code actually means
  const codes = useMemo<SuggestCode[]>(() => {
    return Object.keys(codebook).map((name) => {
      const excerpts: string[] = [];
      for (const s of segments) {
        if (excerpts.length >= SUGGEST_EXEMPLARS) break;
        if (s.status !== "accepted" || s.code !== name || !transcripts[s.pid]) continue;
        const ex = excerptOf(transcripts[s.pid].lines
          .filter((l) => l.id >= s.start && l.id <= s.end)
          .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
        if (ex) excerpts.push(ex);
      }
      return { name, def: codebook[name]?.def ?? "", excerpts };
    });
  }, [codebook, segments, transcripts]);

  const chunks = useMemo(() => chunksOf(lines), [lines]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateSuggestTokens(c, codes, red), 0), [chunks, codes, red]);
  const redactions = useMemo(() => {
    const book = codes.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0);
    const win = lines.reduce((n, l) => n + red.count(l.text), 0);
    return book * chunks.length + win; // the codebook rides every chunk
  }, [codes, lines, red, chunks.length]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(lines.length * 6)));
  const preview = chunks.length ? renderSuggestChunk(chunks[0].slice(0, 8), codes, red) : "";
  const ready = codes.length > 0 && lines.length > 0;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Suggesting codes for ${pid} across ${chunks.length} window${chunks.length === 1 ? "" : "s"}…`);
    abort.current = new AbortController();
    const by = `AI · ${model.name}`;
    let added = 0, skipped = 0, cost = 0, pushed = false;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { proposals, usage } = await suggestChunk({
          key, model: model.id, lines: chunks[i], codes, redaction: red, signal: abort.current.signal,
        });
        for (const p of proposals) {
          // read live each time: catches candidates added earlier in THIS run and
          // any the user accepted/added in another view during the async run
          const st = useStore.getState();
          if (!st.codebook[p.code]) { skipped++; continue; }              // code renamed/deleted mid-run
          if (overlapsExisting(st.segments, pid, p)) { skipped++; continue; }
          if (!pushed) { st.pushUndo(); pushed = true; }                  // one undo entry for the whole run
          st.addSegment(pid, p.startLine, p.endLine, p.code, by, "candidate");
          added++;
        }
        useStore.getState().logAiCall({
          at: new Date().toISOString(), model: model.id, task: "suggest", pid,
          lines: chunks[i].length, redactions: chunks[i].reduce((n, l) => n + red.count(l.text), 0),
          inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
        });
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ added, skipped, cost });
      announce(`Suggestions complete: ${added} candidate coding${added === 1 ? "" : "s"} added.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      announce(`Suggestion run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="about-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="about imp ai-check" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="suggest-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="suggest-title">Suggest codes for “{pid}”</h2>
          <button className="btn iconbtn" onClick={onClose} disabled={busy} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                {done.added === 0
                  ? <>No new codings proposed{done.skipped > 0 && <> ({done.skipped} skipped — those ranges already carry the code)</>}.</>
                  : <>Added <b>{done.added} candidate coding{done.added === 1 ? "" : "s"}</b>
                    {done.skipped > 0 && <> ({done.skipped} skipped as already coded)</>} — review them in the{" "}
                    <b>Assist</b> tab's <b>Suggest codes</b> panel, or striped in the transcript.</>}
              </p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                The AI reads <b>{pid}</b> against your codebook and proposes where each
                existing code might apply. They arrive as <b>candidate codings</b> for you
                to accept or reject — it never invents a code.
              </p>
              <div className="ai-sec">Model <span className="ai-sec-hint">this run only — the default lives in Settings → AI</span></div>
              <div className="ai-models">
                {MODELS.map((m) => (
                  <button key={m.id} className={modelId === m.id ? "on" : ""}
                    title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
                    onClick={() => setModelId(m.id)}>{m.name}</button>
                ))}
              </div>
              {!ready ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {codes.length === 0
                    ? "Your codebook is empty — add some codes first, and the AI can suggest where they apply."
                    : "This transcript has no lines to scan."}
                </p>
              ) : (
                <>
                  <div className="ai-warn">
                    <b>This sends {lines.length} line{lines.length === 1 ? "" : "s"} of “{pid}” plus your{" "}
                    {codes.length}-code codebook (once per window) to OpenAI.</b> Interview transcripts
                    are participant data — make sure this is allowed by your consent form and ethics approval.
                  </div>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}{chunks[0].length > 8 ? "\n…" : ""}</pre>
                  </div>
                  <div className="ai-facts">
                    <span>lines <b>{lines.length}</b></span>
                    <span>codes <b>{codes.length}</b></span>
                    <span>windows <b>{chunks.length}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                  </div>
                  {model.id.includes("luna") && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      Applying a codebook is interpretive and this is the priciest run —
                      <b> Terra</b> usually codes better than Luna. Pick it above for this run.
                    </div>
                  )}
                </>
              )}
            </div>

            {err && <div className="ai-err">{err}</div>}

            {!ready ? (
              <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? `Suggesting… ${progress}/${chunks.length}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
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
