// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the code-suggestion run (F3 of AI-ASSIST.md) — same contract
// as the scan/ground/merge modals. Scope: ONE transcript, chunked into windows,
// each sent with the codebook (name + def + a couple of exemplars).
// Applies proposals as CANDIDATE segments (proposedBy "AI · <model>") for review;
// skips any range already carrying that code (accepted or rejected).
// Two callers, two scopes: the transcript's own code sidebar locks the scope to that
// transcript (its menu says "AI for this transcript"), while the Assist tab passes
// `choose` and picks from the corpus in here — Assist has no active transcript.
import { useEffect, useMemo, useRef, useState } from "react";
import { guessQuiet, liveCodes, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { chunksOf, renderSuggestChunk, estimateSuggestTokens, suggestChunk, overlapsExisting,
  SUGGEST_EXEMPLARS, type SuggestCode } from "../ai/suggest";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";

export function SuggestModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const aiLog = useStore((s) => s.aiLog);
  // `choose` shows the picker (Assist); without it the scope is whatever the caller
  // passed and can't be changed here. "" means nothing picked yet.
  const [picked, setPicked] = useState(initial ?? "");
  const pid = picked;
  const allLines = useMemo(() => transcripts[pid]?.lines ?? [], [transcripts, pid]);
  // Lines the researcher had selected on THIS transcript, if any. Scoping a run to
  // a passage is the point of the selection they already made; the toggle lives in
  // the gate so the payload preview, the token count and the price answer to it.
  const selection = useStore((s) => s.selection);
  const selIds = useMemo(
    () => (selection.pid === pid && selection.lines.size ? selection.lines : null),
    [selection, pid]);
  const [onlySel, setOnlySel] = useState(true);
  const scoped = !!selIds && onlySel;
  const lines = useMemo(
    () => (scoped ? allLines.filter((l) => selIds!.has(l.id)) : allLines),
    [allLines, scoped, selIds]);

  // Whose speech may CARRY a code. Every line is still sent (the exchange needs
  // its questions), but unticked speakers ride as [context] — never coded, and a
  // proposal landing only on them is dropped (sanitizeSuggestReply). Defaults to
  // the researcher unticked, by the same whole-label guess the speaker map uses;
  // per transcript, so a change of pid recomputes rather than carrying names over.
  const speakers = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLines) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    return [...m.entries()];
  }, [allLines]);
  const [context, setContext] = useState<Set<string>>(() => new Set(guessQuiet([...new Set(allLines.map((l) => l.speaker.trim()))])));
  const pickPid = (p: string) => {
    setPicked(p);
    const ls = transcripts[p]?.lines ?? [];
    setContext(new Set(guessQuiet([...new Set(ls.map((l) => l.speaker.trim()))])));
  };
  const toggleSpeaker = (sp: string) =>
    setContext((prev) => {
      const n = new Set(prev);
      n.has(sp) ? n.delete(sp) : n.add(sp);
      return n;
    });
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; skipped: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // the codebook as the model sees it: name + def + up to N exemplar excerpts (from
  // this study's accepted segments), which anchor what each code actually means
  const codes = useMemo<SuggestCode[]>(() => {
    // a set-aside code is not offered to the model either — it would come
    // back as candidate codings for a code you took out of the analysis
    return liveCodes(codebook).map((name) => {
      const excerpts: string[] = [];
      for (const s of segments) {
        if (excerpts.length >= SUGGEST_EXEMPLARS) break;
        if (s.status !== "accepted" || s.code !== name || !transcripts[s.pid]) continue;
        const ex = segExcerpt(s, transcripts[s.pid].lines).excerpt;
        if (ex) excerpts.push(ex);
      }
      return { name, def: codebook[name]?.def ?? "", excerpts };
    });
  }, [codebook, segments, transcripts]);

  // What you pick between, when the caller didn't decide: every LOADED transcript
  // (open tabs first, the store's own order for "all transcripts"), each with what
  // decides the pick — its size, whether a run already happened, and what it yielded.
  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => {
      const last = aiLog.filter((c) => c.task === "suggest" && c.pid === p).at(-1);
      return {
        pid: p, n: transcripts[p].lines.length, at: last?.at.slice(0, 10) ?? null,
        cands: segments.filter((s) => s.pid === p && s.status === "candidate").length,
      };
    });
  }, [choose, tabs, transcripts, aiLog, segments]);

  const chunks = useMemo(() => {
    if (!scoped) return chunksOf(lines);
    // a discontiguous ctrl-click selection is SEPARATE windows: packed into
    // one, the model reads the gap as adjacency and can answer with a span
    // bridging lines it never saw — which addSegment would then code
    const pos = new Map(allLines.map((l, i) => [l.id, i]));
    const runs: (typeof lines)[] = [];
    let run: typeof lines = [];
    for (const l of lines) {
      if (run.length && pos.get(l.id) !== pos.get(run[run.length - 1].id)! + 1) { runs.push(run); run = []; }
      run.push(l);
    }
    if (run.length) runs.push(run);
    return runs.flatMap(chunksOf);
  }, [lines, scoped, allLines]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateSuggestTokens(c, codes, red, context), 0), [chunks, codes, red, context]);
  const redactions = useMemo(() => {
    const book = codes.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0);
    const win = lines.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0);
    return book * chunks.length + win; // the codebook rides every chunk
  }, [codes, lines, red, chunks.length]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(lines.length * 6)));
  const preview = chunks.length ? renderSuggestChunk(chunks[0].slice(0, 8), codes, red, context) : "";
  const ready = codes.length > 0 && lines.length > 0;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Suggesting codes for ${pid} across ${chunks.length} window${chunks.length === 1 ? "" : "s"}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    const by = `AI · ${model.name}`;
    let added = 0, skipped = 0, cost = 0, pushed = false;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { proposals, usage } = await suggestChunk({
          key, model: model.id, lines: chunks[i], codes, redaction: red, context, signal: abort.current.signal,
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
          // text AND speaker, plus the codebook that rides every chunk —
          // count what the renderer actually replaces
          lines: chunks[i].length,
          redactions: chunks[i].reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
            + codes.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0),
          inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
        });
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ added, skipped, cost });
      earcon.aiDone();
      announce(`Suggestions complete: ${added} candidate coding${added === 1 ? "" : "s"} added.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Suggestion run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={pid ? <>Suggest codes for “{pid}”</> : <>Suggest codes</>} busy={busy} onClose={onClose}>

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
                The AI reads {pid ? <b>{pid}</b> : "one transcript"} against your codebook and
                proposes where each existing code might apply. They arrive as <b>candidate
                codings</b> for you to accept or reject — it never invents a code.
              </p>
              {/* above the controls, not below them: at a normal window size this box
                  scrolled out of the scrolling body while Send stayed visible and
                  enabled -- backwards for the one sentence naming participant data */}
              {ready && (
                <div className="ai-warn">
                  <b>This sends {lines.length} {scoped ? "selected " : ""}line{lines.length === 1 ? "" : "s"} of “{pid}” plus your{" "}
                  {codes.length}-code codebook (once per window) to OpenAI.</b> Interview transcripts
                  are participant data — make sure this is allowed by your consent form and ethics approval.
                </div>
              )}
              {choose && (
                <>
                  {/* Nothing is preselected when the caller didn't name a transcript: the
                      primary button stays disabled until you pick, so a reflex click can't
                      spend money sending the wrong participant's speech. */}
                  <div className="ai-sec">Transcript <span className="ai-sec-hint">the run reads this one, start to end</span></div>
                  <div className="ai-tlist" role="radiogroup" aria-label="Transcript to suggest codes for">
                    {choices.map((c) => (
                      <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                        <input type="radio" name="suggest-pid" checked={picked === c.pid}
                          onChange={() => pickPid(c.pid)} disabled={busy} />
                        <span className="tName">{c.pid}</span>
                        <em>{c.n} lines
                          {c.at ? ` · run ${c.at}` : " · not run yet"}
                          {c.cands > 0 ? ` · ${c.cands} candidate${c.cands === 1 ? "" : "s"}` : ""}</em>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {selIds && (
                <label className="ai-spk" style={{ margin: "8px 0" }}>
                  <input type="checkbox" checked={onlySel} onChange={() => setOnlySel((v) => !v)} />
                  <span>Only the {selIds.size} line{selIds.size === 1 ? "" : "s"} you selected{" "}
                  <em>suggestions land only there, and the rest of {pid} is not sent</em></span>
                </label>
              )}
              <ModelPicker modelId={modelId} onPick={setModelId} />
              {/* every line still goes (the exchange needs its questions); unticking
                  only stops a speaker's lines from CARRYING a code */}
              {pid && speakers.length > 1 && (
                <>
                  <div className="ai-sec">Whose speech gets coded{" "}
                    <span className="ai-sec-hint">unticked speakers are sent as context, never coded</span></div>
                  <div className="ai-spks">
                    {speakers.map(([sp, n]) => (
                      <label key={sp} className="ai-spk">
                        <input type="checkbox" checked={!context.has(sp)} onChange={() => toggleSpeaker(sp)} disabled={busy} />
                        <span>{sp} <em>{n}</em></span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {!ready ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {codes.length === 0
                    ? "Your codebook is empty — add some codes first, and the AI can suggest where they apply."
                    : !pid
                      ? "Pick a transcript above and the payload, the token count and the price appear here."
                      : "This transcript has no lines to scan."}
                </p>
              ) : (
                <>
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
                      The priciest run. <b>Terra</b> usually codes better than Luna. Pick it above.
                    </div>
                  )}
                </>
              )}
            </div>

            {err && <div className="ai-err">{err}</div>}

            {!ready ? (
              <div className="imp-actions">
                {codes.length > 0 && !pid && <button className="btn primary" disabled>Pick a transcript</button>}
                <button className="btn" onClick={onClose}>Close</button>
              </div>
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
    </AiModal>
  );
}
