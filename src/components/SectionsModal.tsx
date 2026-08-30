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
import { linesOf, AI_PROPOSED_BY_PREFIX, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { parseBrief, vocabSays, vocabRespelled, briefProse } from "../sections";
import { proposeSections, estimateSectionsTokens, renderSections, eventRedactions,
  SECTIONS_TOKEN_CAP, SECTIONS_MAX, SECTION_OUT_TOKENS } from "../ai/sections";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";
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
  const lang = useStore((s) => s.ui.lang);
  const lines = useMemo(() => linesOf(transcripts, lang, pid), [transcripts, lang, pid]);
  // This transcript's session events ride along: a researcher who logged
  // "task 2 starts" has already said where a boundary is, more reliably than
  // the talk around it. Their labels are the researcher's own words, so they
  // are redacted and counted like any other prose in the payload.
  const allMarkers = useStore((s) => s.markers);
  const markers = useMemo(() => allMarkers.filter((m) => m.pid === pid), [allMarkers, pid]);
  // events are stamped on the VIDEO clock; this is the correction to the
  // transcript's own, and every other placement in the app applies it
  const offset = useStore((s) => s.video[pid]?.offset ?? 0);

  // The brief this run will use: the transcript's own override if it has one,
  // otherwise the study default. Edits here apply to THIS RUN only — a run must
  // never silently rewrite something the researcher wrote — and the two Save
  // buttons below are the only things that persist them.
  const saved = studyBrief[pid] ?? studyBrief[""] ?? "";
  const [brief, setBrief] = useState(saved);
  const [briefFor, setBriefFor] = useState(pid); // which pid `brief` was seeded from
  useEffect(() => {
    if (briefFor === pid) return;
    // Reseed only when the draft is untouched — measured against the transcript
    // it was seeded FOR, not the one just picked. The common first flow is to
    // write the brief and THEN pick the transcript to run it on; reseeding
    // unconditionally would make the picking wipe the words.
    if (brief === (studyBrief[briefFor] ?? studyBrief[""] ?? ""))
      setBrief(studyBrief[pid] ?? studyBrief[""] ?? "");
    setBriefFor(pid);
  }, [pid, briefFor, brief, studyBrief]);
  const dirty = brief !== saved;
  // NB the pid check: in choose mode nothing is picked yet and pid is "", which
  // is the study default's own key — without it the "use the default again"
  // button would offer to DELETE the study default itself.
  const hasOwn = !!pid && pid in studyBrief;

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; cost: number } | null>(null);
  // The dialog stays mounted across the run, so useDialogFocus does not fire
  // again — and the button that had focus (Send) is replaced by Done, dropping
  // the caret onto <body> OUTSIDE the focus trap. Hand it to Done instead.
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);
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
  const respelled = useMemo(() => vocabRespelled(brief, stretches), [brief, stretches]);
  // what this transcript has already settled — marked or turned down. It rides
  // in the request so the run is not spent re-proposing it, and in the estimate
  // and the preview so the gate describes what actually leaves.
  const settled = useMemo(() => stretches.filter((x) => x.pid === pid), [stretches, pid]);

  const inTok = useMemo(
    () => (lines.length && declared ? estimateSectionsTokens(lines, vocab, brief, red, markers, offset, settled) : 0),
    [lines, vocab, brief, red, declared, markers, offset]);
  const tooBig = inTok > SECTIONS_TOKEN_CAP;
  // the brief's prose is part of the payload and is redacted too (see
  // renderSections), so a name caught there belongs in this count — it is what
  // the facts row and the AI log claim was substituted
  const redactions = useMemo(
    () => lines.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
      + red.count(briefProse(brief))
      // only what renderEvents actually sends — counting the fields it drops
      // would describe a payload other than the one being approved
      + markers.reduce((n, m) => n + eventRedactions(m, red), 0),
    [lines, red, brief, markers]);
  // Priced against the schema's OWN ceiling, not against a guess at how many
  // sections the model will find: the reply is capped at SECTIONS_MAX, so this
  // is the worst the output can cost rather than the likely case. A pre-flight
  // price may overstate; it must never understate.
  const estCost = costOf(model, inTok, SECTIONS_MAX * SECTION_OUT_TOKENS);
  const preview = lines.length && declared
    // the FULL lines and markers, with `show` truncating the display: events
    // anchor against the whole transcript, so the preview's "after line N" is
    // the line the real request names
    ? renderSections(lines, vocab, brief, red, markers, offset, 6, settled) : "";

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
    const by = AI_PROPOSED_BY_PREFIX + model.name;
    try {
      const { sections, usage } = await proposeSections({
        key, model: model.id, lines, vocab, brief, redaction: red, markers, offset,
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
      // The request was already in flight, so the transcript HAS left the
      // device whether or not an answer came back. A provenance log that
      // records only the runs that succeeded is claiming to be complete while
      // being wrong in the one direction that matters — so an aborted or failed
      // run is logged too, with the usage the API never reported (zero) and the
      // outcome that explains why.
      useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "sections", pid, lines: lines.length, redactions,
      });
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
                  the transcript gutter. Right-click any line inside one to read why it was
                  proposed and <b>accept</b> or <b>reject</b> it — nothing counts towards your
                  analysis until you accept it.</>}
            </p>
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button ref={doneRef} className="btn primary" onClick={onClose}>Done</button></div>
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
                <b>This sends all {lines.length} lines of “{pid}”
                {markers.length > 0 && <> and its {markers.length} session event{markers.length === 1 ? "" : "s"}</>}
                {" "}to OpenAI in one request.</b>{" "}
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
              <div className="ai-vocab" role="status">
                <Icon name="check" size={14} />
                <div>
                  <b>These labels, and no others:</b> {vocabSays(vocab)}
                  {respelled.length > 0 && (
                    // said, not hidden: silently restyling what the researcher
                    // just typed is the kind of helpfulness that reads as a bug
                    <div className="ai-respell">
                      Written to match the spelling your project already uses: {respelled.join(", ")}.
                      To keep a new label distinct, give it a name that differs by more than case.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="ai-warn" role="alert">
                <b>No labels declared, so there is nothing to look for.</b> Add a bulleted line for
                each axis — <code>- phase: warm-up, task 1, debrief</code> — and the run will accept
                those labels and nothing else. Everything else you write is context.
              </div>
            )}

            <div className="ai-briefsave">
              {/* not gated on `declared`: only RUNNING needs a vocabulary. A
                  brief half-written, or all prose with the axes still to come,
                  is exactly the thing worth saving before you lose it.
                  The default's button is gated on differing from THE DEFAULT,
                  not from `saved` — otherwise an untouched per-transcript
                  override could never be promoted to the study default. */}
              <button className="btn" disabled={busy || brief === (studyBrief[""] ?? "")}
                onClick={() => { useStore.getState().setStudyBrief("", brief); announce("Saved as the study default"); }}>
                Save as the study default
              </button>
              <button className="btn" disabled={busy || !dirty || !pid}
                onClick={() => { useStore.getState().setStudyBrief(pid, brief); announce(`Saved for ${pid}`); }}>
                Save for {pid || "this transcript"}
              </button>
              {hasOwn && (
                <button className="btn" disabled={busy}
                  onClick={() => {
                    // overwriting the draft is what the button SAYS it does, so
                    // set it explicitly — the reseed effect above deliberately
                    // refuses to wipe a dirty draft on its own
                    useStore.getState().clearStudyBrief(pid);
                    setBrief(useStore.getState().studyBrief[""] ?? "");
                    announce("Using the study default again");
                  }}>
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

            <ModelPicker modelId={modelId} onPick={setModelId} disabled={busy} />

            {ready ? (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    {/* not "exactly what leaves your device", which the other
                        gates say of a payload they show whole: this run sends
                        the entire transcript, so the panel is a SAMPLE of it —
                        the first lines, in the form they leave in. The count
                        beside it is the honest total. */}
                    <span className="eyebrow">The first lines, in the form they leave your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}{lines.length > 6 ? "\n…" : ""}</pre>
                </div>
                <div className="ai-facts">
                  <span>lines <b>{lines.length}</b></span>
                  {markers.length > 0 && <span>events <b>{markers.length}</b></span>}
                  <span>labels <b>{declared}</b></span>
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
