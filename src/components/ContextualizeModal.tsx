// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the contextualize run (F9 of AI-ASSIST.md): the researcher
// says what the conditions are called and how to tell them apart, chooses
// whose speech may be rewritten, and sees the payload before a byte is sent.
// Same contract as the sections gate — whole transcript, one request, a
// remembered brief with a per-transcript override — plus Find's three-state
// speaker control, because "context only" is exactly what the interviewer's
// lines are here: read to follow the exchange, never rewritten.
import { useEffect, useMemo, useRef, useState } from "react";
import { guessQuiet, linesOf, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { eventRedactions } from "../ai/sections";
import { contextualize, estimateContextTokens, renderContext, briefTerms, proseRedactions,
  CONTEXT_TOKEN_CAP, SUBS_MAX, SUB_OUT_TOKENS } from "../ai/contextualize";
import { SUBST_LENS, hashLine, spanLens } from "../ai/flag";
import { isEvidence } from "../stretches";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

type Voice = "rewrite" | "context" | "exclude";

export function ContextualizeModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const aiLog = useStore((s) => s.aiLog);
  const aiFlags = useStore((s) => s.aiFlags);
  const stretches = useStore((s) => s.stretches);
  const substBrief = useStore((s) => s.substBrief);
  const ai = useStore((s) => s.ai);
  const [picked, setPicked] = useState(initial ?? "");
  const pid = picked;
  // the reading decides which text is rewritten — the translation under an
  // English reading, the spoken line otherwise — exactly as replace and the
  // transcription repair do (see replaceInTranscript)
  const lang = useStore((s) => s.ui.lang);
  const allLines = useMemo(() => linesOf(transcripts, lang, pid), [transcripts, lang, pid]);
  const allMarkers = useStore((s) => s.markers);
  const markers = useMemo(() => allMarkers.filter((m) => m.pid === pid), [allMarkers, pid]);
  const offset = useStore((s) => s.video[pid]?.offset ?? 0);
  // only what the researcher has settled: a candidate section is not evidence
  // of which condition a line is in, and a rejected one is evidence against
  const sections = useMemo(() => stretches.filter((x) => x.pid === pid && isEvidence(x)), [stretches, pid]);

  // Speakers, three ways — and reset with the transcript, since labels are
  // per file. The interviewer defaults to context by the same guess the
  // speaker map makes; a choice already made is never overwritten.
  const speakers = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLines) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [allLines]);
  const [voice, setVoice] = useState<Record<string, Voice>>({});
  useEffect(() => {
    const quiet = new Set(guessQuiet(speakers.map(([s]) => s)));
    setVoice((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const [s] of speakers) {
        if (next[s]) continue;
        next[s] = quiet.has(s) ? "context" : "rewrite";
        changed = true;
      }
      return changed ? next : cur;
    });
  }, [speakers]);
  const pick = (p: string) => { setPicked(p); setVoice({}); };
  const context = useMemo(
    () => new Set(Object.entries(voice).filter(([, v]) => v === "context").map(([s]) => s)), [voice]);
  const excluded = useMemo(
    () => new Set(Object.entries(voice).filter(([, v]) => v === "exclude").map(([s]) => s)), [voice]);
  const lines = useMemo(() => allLines.filter((l) => !excluded.has(l.speaker.trim())), [allLines, excluded]);
  const rewritable = useMemo(() => lines.filter((l) => !context.has(l.speaker.trim())).length, [lines, context]);

  // The brief: this transcript's override, else the default. Edits apply to
  // THIS RUN only; the Save buttons are the only things that persist them.
  const saved = substBrief[pid] ?? substBrief[""] ?? "";
  const [brief, setBrief] = useState(saved);
  const [briefFor, setBriefFor] = useState(pid);
  useEffect(() => {
    if (briefFor === pid) return;
    if (brief === (substBrief[briefFor] ?? substBrief[""] ?? ""))
      setBrief(substBrief[pid] ?? substBrief[""] ?? "");
    setBriefFor(pid);
  }, [pid, briefFor, brief, substBrief]);
  const dirty = brief !== saved;
  const hasOwn = !!pid && pid in substBrief;
  // no vocabulary, no run: a brief that names no [term] gives the model
  // nothing it is allowed to write, and the sanitizer would drop every reply
  const terms = useMemo(() => briefTerms(brief), [brief]);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; unusable: number; cost: number } | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);
  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);

  const inTok = useMemo(
    () => (lines.length && terms.length ? estimateContextTokens(lines, brief, red, context, sections, markers, offset) : 0),
    [lines, brief, red, context, sections, markers, offset, terms.length]);
  const tooBig = inTok > CONTEXT_TOKEN_CAP;
  const redactions = useMemo(
    () => lines.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
      + proseRedactions(brief, red) // the [terms] go plain — see redactProse
      + markers.reduce((n, m) => n + eventRedactions(m, red), 0),
    [lines, red, brief, markers]);
  // Priced against a true ceiling, not a guess: proposals on one line cannot
  // overlap (sanitizeSubs) and each takes at least a word, so a run can yield
  // at most as many as the rewritable lines have words — or the schema cap,
  // whichever is smaller. Overstates for a five-line test, never understates.
  const most = useMemo(() => Math.min(SUBS_MAX, lines.reduce((n, l) =>
    n + (context.has(l.speaker.trim()) ? 0 : l.text.split(/\s+/).filter(Boolean).length), 0)), [lines, context]);
  const estCost = costOf(model, inTok, most * SUB_OUT_TOKENS);
  const preview = lines.length && terms.length
    ? renderContext(lines, brief, red, context, sections, markers, offset, 6) : "";

  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => {
      const last = aiLog.filter((c) => c.task === "contextualize" && c.pid === p).at(-1);
      let pending = 0;
      for (const l of linesOf(transcripts, lang, p)) {
        const f = aiFlags[`${p}:${l.id}`];
        if (!f || f.hash !== hashLine(l.text)) continue;
        pending += f.spans.filter((sp) => spanLens(sp) === SUBST_LENS).length;
      }
      return { pid: p, n: transcripts[p].lines.length, at: last?.at.slice(0, 10) ?? null, pending };
    });
  }, [choose, tabs, transcripts, lang, aiLog, aiFlags]);

  const ready = !!pid && lines.length > 0 && rewritable > 0 && terms.length > 0 && !tooBig;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    if (!ready) return;
    setBusy(true); setErr(null);
    announce(`Reading ${pid} for substitutions…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      const { flags, dropped, usage } = await contextualize({
        key, model: model.id, lines, brief, redaction: red, context, sections, markers, offset,
        signal: abort.current.signal,
      });
      // every sent, rewritable line is recorded as read at its current text,
      // so an earlier run's leftovers on those lines are replaced, not stacked
      useStore.getState().addFlags(pid, flags, lines.filter((l) => !context.has(l.speaker.trim())), [SUBST_LENS]);
      const added = Object.values(flags).reduce((n, f) => n + f.length, 0);
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "contextualize", pid,
        lines: lines.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
        costUsd: +usage.costUsd.toFixed(5),
      });
      setDone({ added, unusable: dropped, cost: usage.costUsd });
      earcon.aiDone();
      announce(added
        ? `${added} substitution${added === 1 ? "" : "s"} proposed for ${pid}. Review them in the transcript.`
        : `No substitutions proposed for ${pid}.`);
    } catch (e) {
      useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "contextualize", pid, lines: lines.length, redactions,
      });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Contextualize run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={pid ? <>Contextualize “{pid}”</> : <>Contextualize</>} busy={busy} onClose={onClose}>
      {done ? (
        <>
          <div className="ai-body">
            <p className="about-lede">
              {done.added === 0
                ? <>No substitutions proposed. Either every reference was already clear, or the
                  model could not tell which condition was meant.</>
                : <><b>{done.added} substitution{done.added === 1 ? "" : "s"}</b> proposed, marked in
                  the transcript. Click a mark to read the evidence and <b>write it in</b>, or take a
                  whole transcript at once from the <b>Assist</b> tab — nothing changes a line until
                  you do.</>}
              {done.unusable > 0 && <> {done.unusable} unusable answer{done.unusable === 1 ? "" : "s"} discarded.</>}
            </p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button ref={doneRef} className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              The AI reads {pid ? <b>{pid}</b> : "one transcript"} whole and proposes where “the first
              one”, “the second system” or a bare “it” should read as a condition's name — written{" "}
              <b>[in brackets]</b>, the convention for words the researcher put in. It may use only
              the terms you write below, and every proposal waits for you to write it in.
            </p>
            {ready && (
              <div className="ai-warn">
                <b>This sends {lines.length} line{lines.length === 1 ? "" : "s"} of “{pid}”
                {markers.length > 0 && <> and its {markers.length} session event{markers.length === 1 ? "" : "s"}</>}
                {" "}to OpenAI in one request.</b>{" "}
                Interview transcripts are participant data — make sure this is allowed by your
                consent form and ethics approval.
              </div>
            )}

            {choose && (
              <>
                <div className="ai-sec">Transcript <span className="ai-sec-hint">the run reads this one, start to end</span></div>
                <div className="ai-tlist" role="radiogroup" aria-label="Transcript to contextualize">
                  {choices.map((c) => (
                    <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                      <input type="radio" name="context-pid" checked={picked === c.pid}
                        onChange={() => pick(c.pid)} disabled={busy} />
                      <span className="tName">{c.pid}</span>
                      <em>{c.n} lines
                        {c.pending > 0 && <> · {c.pending} awaiting review</>}
                        {c.at && <> · last read {c.at}</>}</em>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="ai-sec">
              The conditions{" "}
              <span className="ai-sec-hint">
                {hasOwn ? `an override for ${pid}` : "the study default"} — edits below apply to this run only
              </span>
            </div>
            <textarea className="ai-brief" value={brief} rows={6} disabled={busy}
              aria-label="What the conditions are called, in square brackets, and how to tell which one is being discussed"
              placeholder={"Two systems, counterbalanced. Write [Beacon] for the system with the glowing legend and [Harbor] for the one with the side panel.\nP3 saw Harbor first. The moderator names the system before each task."}
              onChange={(e) => setBrief(e.target.value)} />
            {terms.length > 0 ? (
              <div className="ai-vocab" role="status">
                <b>These terms, and no others:</b> {terms.join(", ")}
              </div>
            ) : (
              <div className="ai-warn" role="alert">
                <b>No term to write in.</b> Name each condition in square brackets —{" "}
                <code>[Beacon]</code> — and the run may write those and nothing else. Everything
                else you write is context.
              </div>
            )}
            <div className="ai-briefsave">
              <button className="btn" disabled={busy || brief === (substBrief[""] ?? "")}
                onClick={() => { useStore.getState().setSubstBrief("", brief); announce("Saved as the study default"); }}>
                Save as the study default
              </button>
              <button className="btn" disabled={busy || !dirty || !pid}
                onClick={() => { useStore.getState().setSubstBrief(pid, brief); announce(`Saved for ${pid}`); }}>
                Save for {pid || "this transcript"}
              </button>
              {hasOwn && (
                <button className="btn" disabled={busy}
                  onClick={() => {
                    useStore.getState().clearSubstBrief(pid);
                    setBrief(useStore.getState().substBrief[""] ?? "");
                    announce("Using the study default again");
                  }}>
                  Use the study default again
                </button>
              )}
            </div>

            {speakers.length > 0 && (
              <>
                <div className="ai-sec">Whose speech <span className="ai-sec-hint">only “rewrite” lines get proposals; “context only” is read, never changed</span></div>
                <div className="ai-voices">
                  {speakers.map(([s, n]) => (
                    <label key={s} className={"voice " + (voice[s] === "rewrite" ? "code" : voice[s] ?? "code")}>
                      <span className="vName">{s}</span>
                      <span className="vN">{n} lines</span>
                      <select value={voice[s] ?? "rewrite"} disabled={busy}
                        aria-label={`What to do with ${s}'s speech`}
                        onChange={(e) => setVoice((v) => ({ ...v, [s]: e.target.value as Voice }))}>
                        <option value="rewrite">rewrite</option>
                        <option value="context">context only</option>
                        <option value="exclude">not sent</option>
                      </select>
                    </label>
                  ))}
                </div>
              </>
            )}

            {tooBig && (
              <div className="ai-warn" role="alert">
                <b>This transcript is too long to read in one request</b> (about {Math.round(inTok / 1000)}k
                tokens; the limit is {Math.round(CONTEXT_TOKEN_CAP / 1000)}k). A reference is resolved from
                the whole session, so there is no window to fall back to. Set a speaker to “not sent”,
                or split the transcript.
              </div>
            )}

            <ModelPicker modelId={modelId} onPick={setModelId} disabled={busy} />

            {ready ? (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">The first lines, in the form they leave your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}{lines.length > 6 ? "\n…" : ""}</pre>
                </div>
                <div className="ai-facts">
                  <span>lines <b>{lines.length}</b></span>
                  {sections.length > 0 && <span>sections <b>{sections.length}</b></span>}
                  {markers.length > 0 && <span>events <b>{markers.length}</b></span>}
                  <span>terms <b>{terms.length}</b></span>
                  <span>requests <b>1</b></span>
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                  <LangFact />
                </div>
              </>
            ) : (
              <p className="about-lede" style={{ marginTop: 10 }}>
                {!pid ? "Pick a transcript above and the payload, the token count and the price appear here."
                  : !lines.length ? "This transcript has no lines to read."
                    : !rewritable ? "Set at least one speaker to “rewrite”."
                      : tooBig ? "Too long for one request — see above."
                        : "Name at least one condition in [brackets] above, and the payload, the token count and the price appear here."}
              </p>
            )}

            {err && <div className="ai-err" role="alert">{err}</div>}
          </div>

          <div className="imp-actions">
            {ready && (
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? "Reading the whole transcript…" : "Send 1 request to OpenAI"}
              </button>
            )}
            <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
              {busy ? "Stop" : "Cancel — send nothing"}
            </button>
          </div>
        </>
      )}
    </AiModal>
  );
}
