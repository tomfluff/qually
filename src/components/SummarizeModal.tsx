// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the session-summary draft — same contract as the other AI
// modals: see exactly what leaves the device before sending. Scope: ONE
// transcript's event log and/or accepted coded excerpts (the researcher picks
// which), plus an optional note of researcher context. One request. The draft is
// shown before it lands: Use it writes the Summary tab's text pane (replacing
// what's there — the modal says so when that's the case), Discard keeps the run
// as a log entry and nothing else.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { renderSummaryPayload, estimateSummaryTokens, summarize } from "../ai/summarize";
import { useSummaryData } from "../useSummaryData";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";
import { openSummary } from "./SummaryView";

export function SummarizeModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const tabs = useStore((s) => s.tabs);
  const markers = useStore((s) => s.markers);
  const segments = useStore((s) => s.segments);
  const summaries = useStore((s) => s.summaries);
  const ai = useStore((s) => s.ai);
  const [picked, setPicked] = useState(initial ?? "");
  const pid = picked;
  const { events, excerpts, sections } = useSummaryData(pid);

  // which material rides along — either alone is a valid session record
  const [incEvents, setIncEvents] = useState(true);
  const [incCodes, setIncCodes] = useState(true);
  const [context, setContext] = useState("");
  const evSel = incEvents ? events : [];
  const exSel = incCodes ? excerpts : [];

  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ text: string; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => ({
      pid: p,
      ev: markers.filter((m) => m.pid === p).length,
      seg: segments.filter((s) => s.pid === p && s.status === "accepted").length,
      has: !!summaries[p]?.trim(),
    }));
  }, [choose, tabs, transcripts, markers, segments, summaries]);

  const inTok = useMemo(() => estimateSummaryTokens(evSel, exSel, context, red, sections),
    [evSel, exSel, context, red, sections]);
  const redactions = useMemo(() =>
    evSel.reduce((n, e) => n + red.count(e.text) + red.count(e.type), 0)
    + exSel.reduce((n, x) => n + red.count(x.excerpt) + red.count(x.ref), 0)
    + sections.reduce((n, x) => n + red.count(x.time), 0)
    + red.count(context), [evSel, exSel, sections, context, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(2400))); // a summary runs a few hundred tokens out
  const preview = renderSummaryPayload(evSel, exSel, context, red, sections);
  const overwriting = !!summaries[pid]?.trim();
  const ready = !!pid && (evSel.length > 0 || exSel.length > 0);

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Drafting a session summary for ${pid}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      const { summary, usage } = await summarize({
        key, model: model.id, events: evSel, excerpts: exSel, context, redaction: red,
        sections, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "summary", pid,
        lines: evSel.length + exSel.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      setDraft({ text: summary, cost: usage.costUsd });
      earcon.aiDone();
      announce("Summary draft ready — review it before it replaces anything.");
    } catch (e) {
      // the request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete)
      useStore.getState().logAiIncomplete(e, { model: model.id, task: "summary", pid, lines: evSel.length + exSel.length, redactions });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Summary draft failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  const use = () => {
    useStore.getState().setSummary(pid, draft!.text);
    announce(`Summary saved for ${pid}.`);
    onClose();
    openSummary(pid); // land where the text now lives, editable
  };

  return (
    <AiModal title={pid ? <>Summarise session “{pid}”</> : <>Summarise a session</>} busy={busy} onClose={onClose}>
      {draft ? (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              The draft below is not saved yet.{" "}
              {overwriting
                ? <b>Using it replaces the summary you already wrote for {pid}.</b>
                : <>Use it and it lands in the Summary tab, where you can edit every word.</>}
            </p>
            <div className="ai-payload">
              <div className="ai-payload-head">
                <span className="eyebrow">The draft</span>
                <span className="ai-model">{model.id}</span>
              </div>
              <pre className="nicescroll sumDraft">{draft.text}</pre>
            </div>
            <div className="imp-stats"><div>Cost: <b>${draft.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions">
            <button className="btn primary" onClick={use}>
              {overwriting ? "Replace my summary" : "Use this summary"}
            </button>
            <button className="btn" onClick={onClose}>Discard</button>
          </div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              {/* the shortest of the five ledes on purpose: this modal's warning is the
                  one that has to share a 700px window with a six-line intro */}
              The AI drafts a prose summary of {pid ? <b>{pid}</b> : "one session"} — what
              happened, what was expressed, what was observed, and highlights — from the
              event log and the excerpts you coded. You review it before it is saved.
            </p>
            {/* above the controls, not below them: at a normal window size this box
                scrolled out of the scrolling body while Send stayed visible and
                enabled -- backwards for the one sentence naming participant data */}
            {ready && (
              <div className="ai-warn">
                <b>This sends {evSel.length ? `${evSel.length} session event${evSel.length === 1 ? "" : "s"}` : ""}
                {evSel.length && exSel.length ? " and " : ""}
                {exSel.length ? `${exSel.length} coded excerpt${exSel.length === 1 ? "" : "s"}` : ""} of
                “{pid}” to OpenAI.</b> Excerpts and notes are participant data — make sure
                this is allowed by your consent form and ethics approval.
              </div>
            )}
            {choose && (
              <>
                <div className="ai-sec">Transcript <span className="ai-sec-hint">the summary covers this session</span></div>
                <div className="ai-tlist" role="radiogroup" aria-label="Transcript to summarise">
                  {choices.map((c) => (
                    <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                      <input type="radio" name="sum-pid" checked={picked === c.pid}
                        onChange={() => setPicked(c.pid)} disabled={busy} />
                      <span className="tName">{c.pid}</span>
                      <em>{c.ev} event{c.ev === 1 ? "" : "s"} · {c.seg} coding{c.seg === 1 ? "" : "s"}
                        {c.has ? " · has a summary" : ""}</em>
                    </label>
                  ))}
                </div>
              </>
            )}
            <ModelPicker modelId={modelId} onPick={setModelId} />
            {pid && (
              <>
                <div className="ai-sec">Material <span className="ai-sec-hint">what the draft is grounded in; either alone works</span></div>
                <div className="ai-spks">
                  <label className="ai-spk">
                    <input type="checkbox" checked={incEvents} onChange={() => setIncEvents((v) => !v)} disabled={busy} />
                    <span>session events <em>{events.length}</em></span>
                  </label>
                  <label className="ai-spk">
                    <input type="checkbox" checked={incCodes} onChange={() => setIncCodes((v) => !v)} disabled={busy} />
                    <span>coded excerpts <em>{excerpts.length}</em></span>
                  </label>
                </div>
                <div className="ai-sec">Additional context <span className="ai-sec-hint">optional study background; it is sent too</span></div>
                <textarea className="sumCtx" value={context} disabled={busy}
                  placeholder="e.g. Third session with this participant; the task was chart reading with a screen reader."
                  onChange={(e) => setContext(e.target.value)} />
              </>
            )}
            {!ready ? (
              <p className="about-lede" style={{ marginTop: 10 }}>
                {!pid
                  ? "Pick a transcript above and the payload, the token count and the price appear here."
                  : "Nothing to summarise — this session has no events or accepted codings ticked. Load an events CSV, accept some codings, or tick a source above."}
              </p>
            ) : (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}</pre>
                </div>
                <div className="ai-facts">
                  <span>events <b>{evSel.length}</b></span>
                  <span>excerpts <b>{exSel.length}</b></span>
                  {/* the session's own shape goes too — counted here for the
                      same reason everything else on this row is */}
                  {sections.length > 0 && <span>sections <b>{sections.length}</b></span>}
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
                {overwriting && (
                  <div className="settings-note" style={{ marginTop: 6 }}>
                    <b>{pid}</b> already has a summary. Nothing is replaced until you use the draft.
                  </div>
                )}
              </>
            )}
          </div>

          {err && <div className="ai-err">{err}</div>}

          {!ready ? (
            <div className="imp-actions">
              {!pid && choose && <button className="btn primary" disabled>Pick a transcript</button>}
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          ) : (
            <div className="imp-actions">
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? "Drafting…" : "Send 1 request to OpenAI"}
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
