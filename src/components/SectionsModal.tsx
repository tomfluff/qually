// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the sections run (F7 of AI-ASSIST.md) — the same contract as
// the scan / ground / merge / suggest modals, with one addition the others do
// not need: the researcher writes the vocabulary here, and the gate SHOWS what
// it parsed out of it before a byte is sent. A misparsed declaration is then
// something they see, not something they discover as an empty result.
//
// Two callers, two scopes, as everywhere: a transcript's own sidebar locks the
// scope to that transcript; the Assist tab passes `choose` and picks in here.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { parseBrief, vocabSays } from "../sections";
import { proposeSections, estimateSectionsTokens, renderSections, SECTIONS_TOKEN_CAP } from "../ai/sections";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";
import { Icon } from "./Icon";

export function SectionsModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const aiLog = useStore((s) => s.aiLog);
  const stretches = useStore((s) => s.stretches);
  const studyBrief = useStore((s) => s.studyBrief);
  const ai = useStore((s) => s.ai);
  const [picked, setPicked] = useState(initial ?? "");
  const pid = picked;
  const lines = useMemo(() => transcripts[pid]?.lines ?? [], [transcripts, pid]);

  // The brief this run will use: the transcript's own override if it has one,
  // otherwise the study default. Edits here apply to THIS RUN only — a run must
  // never silently rewrite something the researcher wrote — and the two Save
  // buttons below are the only things that persist them.
  const saved = studyBrief[pid] ?? studyBrief[""] ?? "";
  const [brief, setBrief] = useState(saved);
  const [briefFor, setBriefFor] = useState(pid); // which pid `brief` was seeded from
  useEffect(() => {
    if (briefFor === pid) return;
    setBrief(studyBrief[pid] ?? studyBrief[""] ?? "");
    setBriefFor(pid);
  }, [pid, briefFor, studyBrief]);
  const dirty = brief !== saved;
  const hasOwn = pid in studyBrief;

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);
  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);

  // Parsed ONCE, here, and used twice — for the payload the preview shows and
  // for the guard the reply is checked against (see sections.ts). The project's
  // own stretches decide the spelling, so a declared "phase" cannot fork a
  // gutter column away from a hand-marked "Phase".
  const vocab = useMemo(() => parseBrief(brief, stretches), [brief, stretches]);
  const declared = vocab.axes.reduce((n, a) => n + a.values.length, 0);

  const inTok = useMemo(
    () => (lines.length && declared ? estimateSectionsTokens(lines, vocab, brief, red) : 0),
    [lines, vocab, brief, red, declared]);
  const tooBig = inTok > SECTIONS_TOKEN_CAP;
  const redactions = useMemo(
    () => lines.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0),
    [lines, red]);
  // output is one line per section and there are few sections — a generous
  // guess costs a fraction of a cent and never understates the bill
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(declared * 240)));
  const preview = lines.length && declared
    ? renderSections(lines.slice(0, 6), vocab, brief, red) : "";

  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => {
      const last = aiLog.filter((c) => c.task === "sections" && c.pid === p).at(-1);
      const cand = stretches.filter((s) => s.pid === p && s.status === "candidate").length;
      const marked = stretches.filter((s) => s.pid === p && (!s.status || s.status === "accepted")).length;
      return { pid: p, n: transcripts[p].lines.length, at: last?.at.slice(0, 10) ?? null, cand, marked };
    });
  }, [choose, tabs, transcripts, aiLog, stretches]);

  const ready = !!pid && lines.length > 0 && declared > 0 && !tooBig;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    if (!ready) return;
    setBusy(true); setErr(null);
    announce(`Reading ${pid} for sections…`);
    earcon.aiStart();
    abort.current = new AbortController();
    const by = `AI · ${model.name}`;
    try {
      const { sections, usage } = await proposeSections({
        key, model: model.id, lines, vocab, brief, redaction: red,
        existing: useStore.getState().stretches, pid, signal: abort.current.signal,
      });
      const added = useStore.getState().landSections(pid, sections, by);
      // logged whether or not anything came back: a run that proposed nothing is
      // a result — the session did not have the shape the brief expected — and
      // the methods appendix should be able to say it was asked
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "sections", pid,
        lines: lines.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      setDone({ added, cost: usage.costUsd });
      earcon.aiDone();
      announce(added
        ? `${added} section${added === 1 ? "" : "s"} proposed for ${pid}. Review them in the transcript.`
        : `No sections proposed for ${pid}.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Sections run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={pid ? <>Find sections in “{pid}”</> : <>Find sections</>} busy={busy} onClose={onClose}>
      {done ? (
        <>
          <div className="ai-body">
            <p className="about-lede">
              {done.added === 0
                ? <>No sections proposed. The transcript may not have the shape the brief
                  describes — or every section it found is already marked.</>
                : <><b>{done.added} section{done.added === 1 ? "" : "s"}</b> proposed, striped in
                  the transcript gutter. Right-click a line to accept or reject each one; nothing
                  counts towards your analysis until you do.</>}
            </p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              The AI reads {pid ? <b>{pid}</b> : "one transcript"} whole and proposes which stretch of
              it belongs to which part of your study. It may use <b>only the labels you declare
              below</b> — it never invents one — and every proposal arrives as a <b>candidate
              section</b> for you to accept or reject.
            </p>
            {ready && (
              <div className="ai-warn">
                <b>This sends all {lines.length} lines of “{pid}” to OpenAI in one request.</b>{" "}
                Interview transcripts are participant data — make sure this is allowed by your
                consent form and ethics approval.
              </div>
            )}

            {choose && (
              <>
                <div className="ai-sec">Transcript <span className="ai-sec-hint">the run reads this one, start to end</span></div>
                <div className="ai-tlist" role="radiogroup" aria-label="Transcript to find sections in">
                  {choices.map((c) => (
                    <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                      <input type="radio" name="sections-pid" checked={picked === c.pid}
                        onChange={() => setPicked(c.pid)} disabled={busy} />
                      <span className="tName">{c.pid}</span>
                      <em>{c.n} lines
                        {c.marked > 0 && <> · {c.marked} section{c.marked === 1 ? "" : "s"} marked</>}
                        {c.cand > 0 && <> · {c.cand} awaiting review</>}
                        {c.at && <> · last read {c.at}</>}</em>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="ai-sec">
              Your study brief{" "}
              <span className="ai-sec-hint">
                {hasOwn ? `an override for ${pid}` : "the study default"} — edits below apply to this run only
              </span>
            </div>
            <textarea className="ai-brief" value={brief} rows={7} disabled={busy}
              aria-label="Study brief: prose about the study, and bulleted lines declaring the section labels"
              placeholder={"A within-subject study, two systems, counterbalanced.\nIgnore the moderator's setup chatter at the start.\n\n- phase: warm-up, task 1, task 2, debrief\n- condition: baseline, beacon"}
              onChange={(e) => setBrief(e.target.value)} />

            {/* The echo. Everything the run promises to accept, said back in the
                researcher's own spellings — because a declaration that did not
                parse does not merely misread, it leaves the label unavailable,
                and finding that out from an empty result is finding out too late. */}
            {declared > 0 ? (
              <div className="ai-vocab">
                <Icon name="check" size={14} />
                <div><b>These labels, and no others:</b> {vocabSays(vocab)}</div>
              </div>
            ) : (
              <div className="ai-warn" role="alert">
                <b>No labels declared, so there is nothing to look for.</b> Add a bulleted line for
                each axis — <code>- phase: warm-up, task 1, debrief</code> — and the run will accept
                those labels and nothing else. Everything else you write is context.
              </div>
            )}

            <div className="ai-briefsave">
              <button className="btn" disabled={busy || !dirty || !declared}
                onClick={() => { useStore.getState().setStudyBrief("", brief); announce("Saved as the study default"); }}>
                Save as the study default
              </button>
              <button className="btn" disabled={busy || !dirty || !declared || !pid}
                onClick={() => { useStore.getState().setStudyBrief(pid, brief); announce(`Saved for ${pid}`); }}>
                Save for {pid || "this transcript"}
              </button>
              {hasOwn && (
                <button className="btn" disabled={busy}
                  onClick={() => { useStore.getState().clearStudyBrief(pid); setBriefFor(""); announce("Using the study default again"); }}>
                  Use the study default again
                </button>
              )}
            </div>

            {tooBig && (
              <div className="ai-warn" role="alert">
                <b>This transcript is too long to read in one request</b> (about {Math.round(inTok / 1000)}k
                tokens; the limit is {Math.round(SECTIONS_TOKEN_CAP / 1000)}k). Sections are found by
                reading the whole session at once, so there is no window to fall back to. Split the
                transcript, or mark this one's sections by hand.
              </div>
            )}

            <ModelPicker modelId={modelId} onPick={setModelId} />

            {ready ? (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}{lines.length > 6 ? "\n…" : ""}</pre>
                </div>
                <div className="ai-facts">
                  <span>lines <b>{lines.length}</b></span>
                  <span>labels <b>{declared}</b></span>
                  <span>requests <b>1</b></span>
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                </div>
              </>
            ) : (
              <p className="about-lede" style={{ marginTop: 10 }}>
                {!pid ? "Pick a transcript above and the payload, the token count and the price appear here."
                  : !lines.length ? "This transcript has no lines to read."
                    : tooBig ? "Too long for one request — see above."
                      : "Declare at least one label above, and the payload, the token count and the price appear here."}
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
