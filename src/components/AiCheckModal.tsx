import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { chunksOf, renderChunk, estimateChunkTokens, flagChunk, hashLine } from "../ai/flag";
import { Icon } from "./Icon";

// The consent gate. Shows the ACTUAL lines that will leave the device — redacted,
// exactly as the model will see them — before a single byte is sent. A privacy
// policy is unreadable; four lines of your own transcript are not.
export function AiCheckModal({ onClose }: { onClose: () => void }) {
  const pid = useStore((s) => s.active);
  const lines = useStore((s) => s.transcripts[s.active]?.lines ?? []);
  const ai = useStore((s) => s.ai);
  const aiFlags = useStore((s) => s.aiFlags);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ found: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const model = modelOf(ai.model);

  // Only send lines we haven't already checked at their current text: an unchanged
  // line costs nothing to re-check, and an edited one invalidates itself by hash.
  const todo = useMemo(
    () => lines.filter((l) => aiFlags[`${pid}:${l.id}`]?.hash !== hashLine(l.text)),
    [lines, aiFlags, pid]
  );
  const chunks = useMemo(() => chunksOf(todo), [todo]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateChunkTokens(c, red), 0), [chunks, red]);
  const redactions = useMemo(() => todo.reduce((n, l) => n + red.count(l.text), 0), [todo, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(todo.length * 40))); // output is small
  const preview = chunks.length ? renderChunk(chunks[0].slice(0, 6), red) : "";

  const run = async () => {
    const key = getKey();
    if (!key) { setErr("No API key set. Add one in Settings → AI assistance."); return; }
    setBusy(true); setErr(null);
    abort.current = new AbortController();
    const st = useStore.getState();
    let found = 0, cost = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { flags, usage } = await flagChunk({
          key, model: ai.model, lines: chunks[i], redaction: red, signal: abort.current.signal,
        });
        st.addFlags(pid, flags, chunks[i]);
        st.logAiCall({
          at: new Date().toISOString(), model: ai.model, task: "flag-transcription", pid,
          lines: chunks[i].length, redactions: chunks[i].reduce((n, l) => n + red.count(l.text), 0),
          inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
        });
        found += Object.keys(flags).length;
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ found, cost });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr(e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="about-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="about imp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2>Check “{pid}” for transcription errors</h2>
          <button className="btn iconbtn" onClick={onClose} disabled={busy} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {done ? (
          <>
            <p className="about-lede">
              {done.found === 0
                ? "No likely transcription errors found. That's a good result — the transcript reads clean."
                : <>Flagged <b>{done.found} line{done.found === 1 ? "" : "s"}</b>. They're underlined in the transcript — double-click one to fix it against the audio.</>}
            </p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : todo.length === 0 ? (
          <>
            <p className="about-lede">Every line in this transcript has already been checked at its current text. Edit a line and it'll be re-checked automatically.</p>
            <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            <div className="ai-warn">
              <b>This sends {todo.length} lines of “{pid}” to OpenAI.</b> Interview transcripts are
              participant data — make sure this is allowed by your consent form and ethics approval.
            </div>

            <div className="ai-payload">
              <div className="ai-payload-head">
                <span className="eyebrow">Exactly what leaves your device</span>
                <span className="ai-model">{model.id}</span>
              </div>
              <pre className="nicescroll">{preview}{chunks[0].length > 6 ? "\n…" : ""}</pre>
            </div>

            <div className="ai-facts">
              <span>lines <b>{todo.length}</b></span>
              <span>requests <b>{chunks.length}</b></span>
              <span>redacted <b>{redactions}</b></span>
              <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
              <span>≈ <b>${estCost.toFixed(4)}</b></span>
            </div>
            {redactions === 0 && ai.redactTerms.length === 0 && (
              <div className="settings-note" style={{ marginTop: 6 }}>
                No redaction terms set. Add participant names, places, and organisations in
                Settings → AI so they're replaced before sending.
              </div>
            )}

            <div className="imp-actions">
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? `Checking… ${progress}/${chunks.length}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
              </button>
              <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                {busy ? "Stop" : "Cancel — send nothing"}
              </button>
            </div>
            {err && <div className="ai-err">{err}</div>}
          </>
        )}
      </div>
    </div>
  );
}
