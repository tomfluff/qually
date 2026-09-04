// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useMemo, useRef, useState } from "react";
import { linesOf, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { LENSES, chunksOf, renderChunk, estimateChunkTokens, scanChunk, hashLine, isRepair } from "../ai/flag";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

// The consent gate. Choose what to look for (lenses) and whose speech to scan
// (speakers — no naming convention assumed), then see the ACTUAL redacted lines
// before a single byte is sent. A privacy policy is unreadable; four lines of
// your own transcript are not.
// Two callers, two scopes (same split as SuggestModal): a transcript's own code
// sidebar locks the scope to that transcript, while the Assist tab passes `choose`
// and picks from the corpus in here — Assist has no active transcript.
export function AiCheckModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const aiLog = useStore((s) => s.aiLog);
  const [picked, setPicked] = useState(initial ?? ""); // "" = nothing picked yet
  const pid = picked;
  const lang = useStore((s) => s.ui.lang);
  // the gate below says which language this sends; it has to be true
  const allLines = linesOf(transcripts, lang, pid);
  const ai = useStore((s) => s.ai);
  const setAi = useStore((s) => s.setAi);
  const aiFlags = useStore((s) => s.aiFlags);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ errors: number; notices: number; unusable: number; cost: number } | null>(null);
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

  const lenses = ai.lenses; // persisted: the ticked scans are remembered across runs
  const toggleLens = (id: string) =>
    setAi({ lenses: lenses.includes(id) ? lenses.filter((x) => x !== id) : [...lenses, id] });

  // Speakers come from the transcript itself — multi-speaker sessions and any
  // labelling convention work the same. All ticked by default, per run.
  const speakers = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLines) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    return [...m.entries()];
  }, [allLines]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Speaker names are per-transcript, so an exclusion carried across a change of
  // transcript would silently skip a speaker you never looked at.
  const pick = (p: string) => { setPicked(p); setExcluded(new Set()); };

  // What you pick between when the caller didn't decide: every LOADED transcript
  // (open tabs first), with what decides the pick — size, whether it's been scanned,
  // and how many live observations it already carries.
  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => {
      const last = aiLog.filter((c) => c.task.startsWith("scan") && c.pid === p).at(-1);
      let obs = 0;
      // asked in the reading language, like the transcript and the panel: a
      // count of 0 beside a transcript whose marks are on screen is a lie
      for (const l of linesOf(transcripts, lang, p)) {
        const f = aiFlags[`${p}:${l.id}`];
        if (!f || f.hash !== hashLine(l.text)) continue; // stale marks aren't shown, don't count them
        obs += f.spans.filter((sp) => !isRepair(sp)).length;
      }
      return { pid: p, n: transcripts[p].lines.length, at: last?.at.slice(0, 10) ?? null, obs };
    });
  }, [choose, tabs, transcripts, lang, aiLog, aiFlags]);

  const toggleSpeaker = (sp: string) =>
    setExcluded((prev) => {
      const n = new Set(prev);
      n.has(sp) ? n.delete(sp) : n.add(sp);
      return n;
    });

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  // per-run model override — starts at the Settings default, changes THIS run only
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // Lines the researcher had selected on THIS transcript, if any. Scoping a run to
  // a passage is the point of the selection they already made; the toggle lives in
  // the gate so the payload preview, the token count and the price all answer to it.
  const selection = useStore((s) => s.selection);
  const selIds = useMemo(
    () => (selection.pid === pid && selection.lines.size ? selection.lines : null),
    [selection, pid]);
  const [onlySel, setOnlySel] = useState(true);
  const scoped = !!selIds && onlySel;
  const lines = useMemo(
    () => (scoped ? allLines.filter((l) => selIds!.has(l.id)) : allLines),
    [allLines, scoped, selIds]);

  // Send only lines that need it: right speaker, and not already scanned under
  // every requested lens at their current text (edits invalidate by hash).
  const todo = useMemo(() => lines.filter((l) => {
    if (excluded.has(l.speaker.trim())) return false;
    const f = aiFlags[`${pid}:${l.id}`];
    if (!f || f.hash !== hashLine(l.text)) return true;
    const scanned = f.lenses ?? ["transcription"];
    return !lenses.every((x) => scanned.includes(x));
  }), [lines, excluded, aiFlags, pid, lenses]);

  const chunks = useMemo(() => chunksOf(todo, red), [todo, red]);
  const inTok = useMemo(
    () => chunks.reduce((n, c) => n + estimateChunkTokens(c, red, lenses), 0),
    [chunks, red, lenses]
  );
  const redactions = useMemo(() => todo.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0), [todo, red]);
  // notices produce more output than error flags; scale the guess with the lens count
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(todo.length * 25 * Math.max(1, lenses.length))));
  const preview = chunks.length ? renderChunk(chunks[0].slice(0, 6), red) : "";

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Scanning “${pid}” with AI, ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    setTotal(chunks.length);
    const st = useStore.getState();
    let errors = 0, notices = 0, unusable = 0, cost = 0;
    // hoisted out of the loop so the catch can name the one chunk in flight
    let i = 0;
    try {
      for (; i < chunks.length; i++) {
        // Stop landing between chunks: the next fetch would reject as an
        // AbortError without dispatching, and the catch would then disclose
        // lines that never left. Nothing more is sent, so nothing more is logged.
        if (abort.current.signal.aborted) return;
        const { flags, dropped, usage } = await scanChunk({
          key, model: model.id, lines: chunks[i], lenses, redaction: red, signal: abort.current.signal,
        });
        unusable += dropped;
        st.addFlags(pid, flags, chunks[i], lenses);
        st.logAiCall({
          at: new Date().toISOString(), model: model.id, task: `scan:${[...lenses].sort().join("+")}`, pid,
          lines: chunks[i].length, redactions: chunks[i].reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0),
          inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
        });
        for (const spans of Object.values(flags))
          for (const sp of spans) sp.lens === "transcription" ? errors++ : notices++;
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ errors, notices, unusable, cost });
      earcon.aiDone();
      announce(errors + notices === 0
        ? "AI scan complete. Nothing marked."
        : `AI scan complete: ${errors} possible transcription error${errors === 1 ? "" : "s"}, ${notices} observation${notices === 1 ? "" : "s"}.`);
    } catch (e) {
      // The request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete). Only the
      // chunk in flight: the earlier chunks logged themselves on success, and
      // the later ones never left, so logging the whole run here would count
      // the first twice and disclose the second falsely.
      const c = chunks[i];
      if (c) useStore.getState().logAiIncomplete(e, {
        model: model.id, task: `scan:${[...lenses].sort().join("+")}`, pid,
        lines: c.length, redactions: c.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0),
      });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`AI scan failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  const doneMsg = () => {
    if (!done) return null;
    // `unusable` matters most in exactly the case that used to look like a quiet
    // transcript: the model answered, and the guard could not use a word of it.
    const unusable = done.unusable > 0
      ? <> {done.unusable} unusable answer{done.unusable === 1 ? "" : "s"} discarded.</>
      : null;
    if (done.errors + done.notices === 0)
      return <>Nothing marked. That's a fine result — the scans only mark what's clearly there.{unusable}</>;
    return <>
      {done.errors > 0 && <>Flagged <b>{done.errors} possible transcription error{done.errors === 1 ? "" : "s"}</b> (amber, dotted) — double-click a line to fix it against the audio. </>}
      {done.notices > 0 && <>Marked <b>{done.notices} observation{done.notices === 1 ? "" : "s"}</b> for your review — hover for the lens, Alt-click to dismiss, or hide them all with the eye button to read blind. Go over them together in the <b>Assist</b> tab.</>}
      {unusable}
    </>;
  };

  return (
    <AiModal title={pid ? <>Scan “{pid}” with AI</> : <>AI observation scan</>} busy={busy} onClose={onClose}>
        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">{doneMsg()}</p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              {/* above the controls, not below them: at a normal window size this box
                  scrolled out of the scrolling body while Send stayed visible and
                  enabled -- backwards for the one sentence naming participant data */}
              {todo.length > 0 && (
                <div className="ai-warn">
                  <b>This sends {todo.length} {scoped ? "selected " : ""}line{todo.length === 1 ? "" : "s"} of “{pid}” to OpenAI.</b> Interview
                  transcripts are participant data — make sure this is allowed by your consent form and ethics approval.
                </div>
              )}

              {choose && (
                <>
                  {/* Nothing preselected: the primary stays disabled until you pick, so a
                      reflex click can't scan the wrong participant. */}
                  <div className="ai-sec">Transcript <span className="ai-sec-hint">the scan reads this one, start to end</span></div>
                  <div className="ai-tlist" role="radiogroup" aria-label="Transcript to scan">
                    {choices.map((c) => (
                      <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                        <input type="radio" name="scan-pid" checked={picked === c.pid}
                          onChange={() => pick(c.pid)} disabled={busy} />
                        <span className="tName">{c.pid}</span>
                        <em>{c.n} lines
                          {c.at ? ` · scanned ${c.at}` : " · not scanned yet"}
                          {c.obs > 0 ? ` · ${c.obs} observation${c.obs === 1 ? "" : "s"}` : ""}</em>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {selIds && (
                <label className="ai-spk" style={{ margin: "8px 0" }}>
                  <input type="checkbox" checked={onlySel} onChange={() => setOnlySel((v) => !v)} />
                  <span>Only the {selIds.size} line{selIds.size === 1 ? "" : "s"} you selected{" "}
                  <em>the rest of {pid} is not sent, and is not scanned</em></span>
                </label>
              )}
              <div className="ai-sec">Look for <span className="ai-sec-hint">marks instances only; coding stays yours</span></div>
              <div className="ai-lenses">
                {LENSES.map((l) => (
                  <label key={l.id} className="ai-lens">
                    <input type="checkbox" checked={lenses.includes(l.id)} onChange={() => toggleLens(l.id)} />
                    <span className="ai-lens-dot" style={{ background: l.color }} />
                    <span>{l.label} <em>{l.method}</em></span>
                  </label>
                ))}
              </div>

              <ModelPicker modelId={modelId} onPick={setModelId} />

              {/* the speaker list is this transcript's own — there's nothing to show
                  until one is picked */}
              {pid && (
                <>
                  <div className="ai-sec">Whose speech</div>
                  <div className="ai-spks">
                    {speakers.map(([sp, n]) => (
                      <label key={sp} className="ai-spk">
                        <input type="checkbox" checked={!excluded.has(sp)} onChange={() => toggleSpeaker(sp)} />
                        <span>{sp} <em>{n}</em></span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {todo.length === 0 ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {lenses.length === 0
                    ? "Tick at least one scan."
                    : !pid
                      ? "Pick a transcript above and the payload, the token count and the price appear here."
                      : "Every included line has already been scanned with these lenses at its current text. Edit a line, add a lens, or include another speaker to scan more."}
                </p>
              ) : (
                <>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}{chunks[0].length > 6 || chunks.length > 1 ? "\n…" : ""}</pre>
                    {/* the box is headed "exactly what leaves your device" and shows
                        ONE request; with variable packing two singleton chunks used to
                        render with no ellipsis and no hint that more was going */}
                    {chunks.length > 1 && (
                      <p className="ai-payload-more">First of <b>{chunks.length}</b> requests — the rest carry the same shape.</p>
                    )}
                  </div>

                  <div className="ai-facts">
                    <span>lines <b>{todo.length}</b></span>
                    <span>requests <b>{chunks.length}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
                  {redactions === 0 && ai.redactTerms.length === 0 && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      No redaction terms set. Add names, places and organisations in
                      Settings → AI to replace them before sending.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Pinned above the footer, outside the scrolling body — a run error
                (e.g. no API key) must be visible right where the Send button is,
                not parked at the bottom of a scrolled-away payload preview. */}
            {err && <div className="ai-err">{err}</div>}

            {todo.length === 0 ? (
              <div className="imp-actions">
                {lenses.length > 0 && !pid && <button className="btn primary" disabled>Pick a transcript</button>}
                <button className="btn" onClick={onClose}>Close</button>
              </div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? `Scanning… ${progress}/${total}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
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
