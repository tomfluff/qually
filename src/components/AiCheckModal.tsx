import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { LENSES, chunksOf, renderChunk, estimateChunkTokens, scanChunk, hashLine } from "../ai/flag";
import { Icon } from "./Icon";

// The consent gate. Choose what to look for (lenses) and whose speech to scan
// (speakers — no naming convention assumed), then see the ACTUAL redacted lines
// before a single byte is sent. A privacy policy is unreadable; four lines of
// your own transcript are not.
export function AiCheckModal({ onClose }: { onClose: () => void }) {
  const pid = useStore((s) => s.active);
  const lines = useStore((s) => s.transcripts[s.active]?.lines ?? []);
  const ai = useStore((s) => s.ai);
  const setAi = useStore((s) => s.setAi);
  const aiFlags = useStore((s) => s.aiFlags);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ errors: number; notices: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const lenses = ai.lenses; // persisted: the ticked scans are remembered across runs
  const toggleLens = (id: string) =>
    setAi({ lenses: lenses.includes(id) ? lenses.filter((x) => x !== id) : [...lenses, id] });

  // Speakers come from the transcript itself — multi-speaker sessions and any
  // labelling convention work the same. All ticked by default, per run.
  const speakers = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    return [...m.entries()];
  }, [lines]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggleSpeaker = (sp: string) =>
    setExcluded((prev) => {
      const n = new Set(prev);
      n.has(sp) ? n.delete(sp) : n.add(sp);
      return n;
    });

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const model = modelOf(ai.model);

  // Send only lines that need it: right speaker, and not already scanned under
  // every requested lens at their current text (edits invalidate by hash).
  const todo = useMemo(() => lines.filter((l) => {
    if (excluded.has(l.speaker.trim())) return false;
    const f = aiFlags[`${pid}:${l.id}`];
    if (!f || f.hash !== hashLine(l.text)) return true;
    const scanned = f.lenses ?? ["transcription"];
    return !lenses.every((x) => scanned.includes(x));
  }), [lines, excluded, aiFlags, pid, lenses]);

  const chunks = useMemo(() => chunksOf(todo), [todo]);
  const inTok = useMemo(
    () => chunks.reduce((n, c) => n + estimateChunkTokens(c, red, lenses), 0),
    [chunks, red, lenses]
  );
  const redactions = useMemo(() => todo.reduce((n, l) => n + red.count(l.text), 0), [todo, red]);
  // notices produce more output than error flags; scale the guess with the lens count
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(todo.length * 25 * Math.max(1, lenses.length))));
  const preview = chunks.length ? renderChunk(chunks[0].slice(0, 6), red) : "";

  const run = async () => {
    const key = getKey();
    if (!key) { setErr("No API key set. Add one in Settings → AI assistance."); return; }
    setBusy(true); setErr(null);
    abort.current = new AbortController();
    const st = useStore.getState();
    let errors = 0, notices = 0, cost = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { flags, usage } = await scanChunk({
          key, model: ai.model, lines: chunks[i], lenses, redaction: red, signal: abort.current.signal,
        });
        st.addFlags(pid, flags, chunks[i], lenses);
        st.logAiCall({
          at: new Date().toISOString(), model: ai.model, task: `scan:${[...lenses].sort().join("+")}`, pid,
          lines: chunks[i].length, redactions: chunks[i].reduce((n, l) => n + red.count(l.text), 0),
          inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
        });
        for (const spans of Object.values(flags))
          for (const sp of spans) sp.lens === "transcription" ? errors++ : notices++;
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ errors, notices, cost });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr(e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doneMsg = () => {
    if (!done) return null;
    if (done.errors + done.notices === 0)
      return <>Nothing marked. That's a fine result — the scans only mark what's clearly there.</>;
    return <>
      {done.errors > 0 && <>Flagged <b>{done.errors} possible transcription error{done.errors === 1 ? "" : "s"}</b> (amber, dotted) — double-click a line to fix it against the audio. </>}
      {done.notices > 0 && <>Highlighted <b>{done.notices} instance{done.notices === 1 ? "" : "s"}</b> for your review — hover for the lens, Alt-click to dismiss, or hide them all with the eye button to read blind.</>}
    </>;
  };

  return (
    <div className="about-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="about imp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2>Scan “{pid}” with AI</h2>
          <button className="btn iconbtn" onClick={onClose} disabled={busy} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {done ? (
          <>
            <p className="about-lede">{doneMsg()}</p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-sec">Look for <span className="ai-sec-hint">marks instances only — coding stays yours</span></div>
            <div className="ai-lenses">
              {LENSES.map((l) => (
                <label key={l.id} className="ai-lens">
                  <input type="checkbox" checked={lenses.includes(l.id)} onChange={() => toggleLens(l.id)} />
                  <span className="ai-lens-dot" style={{ background: l.color }} />
                  <span>{l.label} <em>{l.method}</em></span>
                </label>
              ))}
            </div>

            <div className="ai-sec">Whose speech</div>
            <div className="ai-spks">
              {speakers.map(([sp, n]) => (
                <label key={sp} className="ai-spk">
                  <input type="checkbox" checked={!excluded.has(sp)} onChange={() => toggleSpeaker(sp)} />
                  <span>{sp} <em>{n}</em></span>
                </label>
              ))}
            </div>

            {todo.length === 0 ? (
              <>
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {lenses.length === 0
                    ? "Tick at least one scan."
                    : "Every included line has already been scanned with these lenses at its current text. Edit a line, add a lens, or include another speaker to scan more."}
                </p>
                <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
              </>
            ) : (
              <>
                <div className="ai-warn">
                  <b>This sends {todo.length} line{todo.length === 1 ? "" : "s"} of “{pid}” to OpenAI.</b> Interview
                  transcripts are participant data — make sure this is allowed by your consent form and ethics approval.
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
                    {busy ? `Scanning… ${progress}/${chunks.length}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
                  </button>
                  <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                    {busy ? "Stop" : "Cancel — send nothing"}
                  </button>
                </div>
                {err && <div className="ai-err">{err}</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
