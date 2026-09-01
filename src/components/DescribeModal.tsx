// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for AI-drafted code definitions. Scope: every code with at least
// one accepted segment (the excerpts are the evidence a definition is grounded
// in). Sending WRITES the drafts — one undoable step — and reports the cost,
// like every other AI run in the app. There is no review desk: a stack of
// textareas in a dialog was a worse editor than the Definitions panel the
// researcher already has, and it made a paid run discardable by a stray click.
import { useEffect, useMemo, useRef, useState } from "react";
import { linesOf, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { describeCodes, renderDescribePayload, estimateDescribeTokens, DESC_EXEMPLARS,
  type DescCodeInput } from "../ai/describe";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { sortCodes, type SortBy } from "../codeStats";
import { CodePickBar, CodePickRow } from "./CodePicker";
import { AiModal, LangFact, ModelPicker } from "./AiModal";

export function DescribeModal({ initial, onClose }: {
  // What the caller had in view: the codes picked in the Definitions sidebar,
  // or failing that the ones its Show filter is showing. Opening the dialog
  // shouldn't throw away the narrowing you just did. Omitted (the Codebook's AI
  // menu, which has no such context) means every coded code.
  initial?: string[];
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const codebook = useStore((s) => s.codebook);
  const applyDrafts = useStore((s) => s.applyDrafts);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  // null = still on the consent stage; after the run, what was written and what
  // it cost — the same receipt every other AI run shows.
  const [done, setDone] = useState<{ names: string[]; cost: number } | null>(null);
  const [checked, setChecked] = useState<Set<string> | null>(initial ? new Set(initial) : null); // null = every code
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // one input per code that has accepted segments — name + current def + up to
  // N excerpts — plus the code's full footprint (every accepted segment and
  // every transcript it appears in, uncapped) for the picker
  const codes = useMemo<(DescCodeInput & { segs: number; pids: number })[]>(() => {
    const byCode = new Map<string, { excerpts: string[]; segs: number; pids: Set<string> }>();
    for (const s of segments) {
      if (s.status !== "accepted" || !transcripts[s.pid]) continue;
      const e = byCode.get(s.code) ?? { excerpts: [], segs: 0, pids: new Set<string>() };
      e.segs++; e.pids.add(s.pid);
      if (e.excerpts.length < DESC_EXEMPLARS) {
        const ex = segExcerpt(s, linesOf(transcripts, lang, s.pid)).excerpt;
        if (ex) e.excerpts.push(ex);
      }
      byCode.set(s.code, e);
    }
    const rows = [...byCode.entries()].map(([name, e]) => ({
      name, def: codebook[name]?.def ?? "", excerpts: e.excerpts, segs: e.segs, pids: e.pids.size,
    }));
    const stats = Object.fromEntries(rows.map((r) => [r.name, { segs: r.segs, pids: r.pids }]));
    const order = sortCodes(rows.map((r) => r.name), stats, sortBy);
    return order.map((n) => rows.find((r) => r.name === n)!);
  }, [segments, transcripts, lang, codebook, sortBy]);

  // The caller's codes and this dialog's are not the same set: it only lists
  // codes with accepted segments (the excerpts a definition is drafted from), so
  // a selection made in the sidebar can name codes that have none. Say which
  // ones fell out rather than quietly widening the run — this one costs money
  // and ships participant data, so the safe direction is the smaller set.
  const dropped = useMemo(() => {
    if (!initial) return [];
    const live = new Set(codes.map((c) => c.name));
    return initial.filter((n) => !live.has(n));
  }, [initial, codes]);

  // everything downstream — payload, estimate, the run itself — sees only the
  // codes still ticked
  const on = checked ?? new Set(codes.map((c) => c.name));
  // memoised on the CHECKED set, not rebuilt per render: the payload preview and
  // the token estimate below hang off this array's identity, and a fresh one
  // every render made their useMemos re-walk every excerpt for nothing
  const sent = useMemo(() => codes.filter((c) => !checked || checked.has(c.name)), [codes, checked]);
  const toggle = (name: string) => setChecked(() => {
    const n = new Set(on); n.has(name) ? n.delete(name) : n.add(name); return n;
  });
  const pick = (which: "all" | "none" | "undefined" | "defined") => setChecked(new Set(
    codes.filter((c) =>
      which === "all" ? true
      : which === "none" ? false
      : which === "undefined" ? !c.def
      : !!c.def).map((c) => c.name)));

  const exCount = sent.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => estimateDescribeTokens(sent, red), [sent, red]);
  const redactions = useMemo(() => sent.reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [sent, red]);
  // A definition runs one or two sentences (~40 tokens), and every call bills
  // low-effort reasoning at the OUTPUT rate on top — the old guess of ~10 tokens
  // a code, reasoning ignored, showed a price several times under what the run
  // actually cost. Overshoot: this number sits next to the Send button.
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(sent.length * 160)) + 300);
  const preview = useMemo(() => renderDescribePayload(sent, red), [sent, red]);
  const enough = sent.length >= 1;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Drafting definitions for ${sent.length} codes…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      const { drafts, usage } = await describeCodes({
        key, model: model.id, codes: sent, redaction: red, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "describe", pid: "(codebook)",
        lines: sent.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
      });
      // written straight in, as one undo step — editing happens afterwards in
      // the Definitions panel, which scales with the reading-size setting and
      // shows the excerpts each definition is answerable to
      // what was WRITTEN, not what came back: a draft identical to the stored
      // definition changes nothing and must not be counted as a write
      const names = applyDrafts(drafts.map((d) => ({ code: d.code, def: d.definition })));
      setDone({ names, cost: usage.costUsd });
      earcon.aiDone();
      announce(names.length
        ? `${names.length} definition${names.length === 1 ? "" : "s"} written.`
        : "The model returned no definitions.");
    } catch (e) {
      // the request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete)
      useStore.getState().logAiIncomplete(e, { model: model.id, task: "describe", pid: "(codebook)", lines: sent.length, redactions });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Describe run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Draft definitions" busy={busy} onClose={onClose}>
      {done ? (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              {done.names.length === 0
                ? <>The model returned no definitions — nothing has changed.</>
                : <><b>{done.names.length} definition{done.names.length === 1 ? "" : "s"} written.</b> They
                  are marked <span className="defTag ai">AI</span> until you edit them — double-click
                  any definition in the Codebook or the Definitions panel to reshape it.
                  One <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the whole run.</>}
            </p>
            {done.names.length > 0 && (
              <div className="descWrote">
                {done.names.map((c) => (
                  <span key={c} className="descWroteOne">
                    <span className="mSw" style={{ background: codebook[c]?.color || "#999" }} />
                    {c}
                  </span>
                ))}
              </div>
            )}
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              Drafts each definition from the excerpts you coded with it. Drafts go straight
              into the codebook, marked AI until you edit them — one <kbd>Ctrl</kbd>+<kbd>Z</kbd>{" "}
              takes the whole run back.
            </p>
            {codes.length === 0 ? (
              <p className="about-lede" style={{ marginTop: 10 }}>
                Definitions are drafted from coded excerpts, and no code has an accepted
                segment yet. Code a bit first, then come back.
              </p>
            ) : (
              <>
                {/* above the picker, not below it: at a normal window size this
                    box scrolled out of sight while Send stayed visible and
                    enabled, which is precisely backwards for the one sentence
                    naming participant data */}
                <div className="ai-warn">
                  <b>This sends {sent.length} code{sent.length === 1 ? "" : "s"} — names, current definitions,
                  and up to {DESC_EXEMPLARS} excerpts each — to OpenAI.</b> Excerpts are participant
                  data; make sure this is allowed by your consent form and ethics approval.
                  Definitions you already wrote are replaced.
                </div>
                {dropped.length > 0 && (
                  <p className="descDropped">
                    {dropped.length === (initial?.length ?? 0)
                      ? <>None of the {dropped.length} code{dropped.length === 1 ? "" : "s"} you picked
                        {dropped.length === 1 ? " has" : " have"} coded excerpts yet — tick others below.</>
                      : <>{dropped.length} of the codes you picked {dropped.length === 1 ? "has" : "have"} no
                        coded excerpts yet and {dropped.length === 1 ? "is" : "are"} not listed: {dropped.join(", ")}.</>}
                  </p>
                )}
                <ModelPicker modelId={modelId} onPick={setModelId} />
                <div className="ai-sec">Codes <span className="ai-sec-hint">tick the ones to draft a definition for</span></div>
                <CodePickBar sortBy={sortBy} onSort={setSortBy} onPick={[
                  { label: "All", run: () => pick("all") },
                  { label: "Undefined", run: () => pick("undefined") },
                  { label: "Defined", run: () => pick("defined") },
                  { label: "None", run: () => pick("none") },
                ]} />
                <div className="cpickList" role="group" aria-label="Codes to draft definitions for">
                  {codes.map((c) => (
                    <CodePickRow key={c.name} code={c} color={codebook[c.name]?.color ?? ""}
                      on={on.has(c.name)} onToggle={() => toggle(c.name)} />
                  ))}
                </div>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}</pre>
                </div>
                <div className="ai-facts">
                  {/* the ticked codes, like every other number here — this read
                      the whole eligible set and contradicted the warning above */}
                  <span>codes <b>{sent.length}</b></span>
                  <span>excerpts <b>{exCount}</b></span>
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
              </>
            )}
          </div>

          {err && <div className="ai-err">{err}</div>}

          {codes.length === 0 ? (
            <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
          ) : (
            <div className="imp-actions">
              <button className="btn primary" onClick={run} disabled={busy || !enough}
                title={enough ? undefined : "Tick at least one code"}>
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
