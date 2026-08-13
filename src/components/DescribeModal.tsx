// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate + review desk for AI-drafted code definitions. Scope: every code
// with at least one accepted segment (the excerpts are the evidence a definition
// is grounded in). The AI drafts; each draft is edited and applied HERE, one
// Apply per code through the existing setDef — closing the modal applies nothing.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { excerptOf } from "../contract/excerpt";
import { describeCodes, renderDescribePayload, estimateDescribeTokens, DESC_EXEMPLARS,
  type DescCodeInput } from "../ai/describe";
import { announce } from "../announce";
import { SORTS, sortCodes, type SortBy } from "../codeStats";
import { AiModal, ModelPicker } from "./AiModal";

export function DescribeModal({ onClose }: { onClose: () => void }) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const setDef = useStore((s) => s.setDef);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  // null = still on the consent stage; after the run, the drafts being reviewed
  // (edited in place) with which are applied, plus the run's cost for the footer.
  // `ai` keeps the model's original text: applying it verbatim marks the
  // definition AI-only, while any edit marks it manually shaped.
  const [drafts, setDrafts] = useState<{ code: string; text: string; ai: string }[] | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string> | null>(null); // null until codes exist — then defaults to all
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [cost, setCost] = useState(0);
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
        const ex = excerptOf(transcripts[s.pid].lines
          .filter((l) => l.id >= s.start && l.id <= s.end)
          .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
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
  }, [segments, transcripts, codebook, sortBy]);

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
  const pick = (which: "all" | "none" | "undescribed" | "described") => setChecked(new Set(
    codes.filter((c) =>
      which === "all" ? true
      : which === "none" ? false
      : which === "undescribed" ? !c.def
      : !!c.def).map((c) => c.name)));

  const exCount = sent.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => estimateDescribeTokens(sent, red), [sent, red]);
  const redactions = useMemo(() => sent.reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [sent, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(sent.length * 40)));
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
    abort.current = new AbortController();
    try {
      const { drafts: out, usage } = await describeCodes({
        key, model: model.id, codes: sent, redaction: red, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "describe", pid: "(codebook)",
        lines: sent.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      setDrafts(out.map((d) => ({ code: d.code, text: d.definition, ai: d.definition })));
      setCost(usage.costUsd);
      announce(out.length
        ? `${out.length} definition draft${out.length === 1 ? "" : "s"} to review.`
        : "The model returned no definitions.");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      announce(`Describe run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  const apply = (code: string, text: string, aiText: string) => {
    const t = text.trim();
    if (!t || !codebook[code]) return;
    // verbatim AI text is marked AI-only; an edited draft is a person's words
    setDef(code, t, t === aiText.trim());
    setApplied((a) => new Set(a).add(code));
  };

  return (
    <AiModal title="Draft definitions" busy={busy} onClose={onClose}>
      {drafts ? (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              {drafts.length === 0
                ? <>The model returned no definitions — nothing has changed.</>
                : <>Edit each draft as needed, then <b>Apply</b> the ones you want — each write
                  goes into that code's definition. Anything not applied is discarded on close.</>}
            </p>
            {drafts.map((d, i) => {
              const gone = !codebook[d.code]; // merged/deleted since the run
              const cur = codebook[d.code]?.def ?? "";
              const done = applied.has(d.code);
              return (
                <div key={d.code} className="descRow">
                  <div className="descHead">
                    <span className="mSw" style={{ background: codebook[d.code]?.color || "#999" }} />
                    <b>{d.code}</b>
                    {done && <span className="mKeepTag">applied</span>}
                    {gone && <span className="mTier">code no longer exists</span>}
                  </div>
                  {cur && !done && <div className="descCur">current: {cur}</div>}
                  <textarea className="descText" value={d.text} rows={2} disabled={gone}
                    onChange={(e) => setDrafts((ds) =>
                      ds!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <div className="mActs">
                    <button className="nBtn pri" disabled={gone || !d.text.trim()}
                      onClick={() => apply(d.code, d.text, d.ai)}>
                      {done ? "Apply again" : cur ? "Replace definition" : "Apply"}
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="imp-stats"><div>Cost: <b>${cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            <p className="about-lede">
              The AI reads each code's name, its current definition, and a few excerpts you
              coded with it, then drafts a definition grounded in that usage. You review,
              edit and apply every definition yourself; nothing is written on its own.
            </p>
            <ModelPicker modelId={modelId} onPick={setModelId} />
            {codes.length === 0 ? (
              <p className="about-lede" style={{ marginTop: 10 }}>
                Definitions are drafted from coded excerpts, and no code has an accepted
                segment yet. Code a bit first, then come back.
              </p>
            ) : (
              <>
                <div className="ai-sec">Codes <span className="ai-sec-hint">tick the ones to draft a definition for</span></div>
                <div className="descPicks">
                  <button className="btn" onClick={() => pick("all")}>All</button>
                  <button className="btn" onClick={() => pick("undescribed")}>Undescribed</button>
                  <button className="btn" onClick={() => pick("described")}>Described</button>
                  <button className="btn" onClick={() => pick("none")}>None</button>
                  {/* ticks survive a re-sort: the order is a view, not the selection */}
                  <span className="descSort">
                    <span className="descSortLabel" id="descSortLabel">Sort</span>
                    <span className="nPills" role="group" aria-labelledby="descSortLabel">
                      {SORTS.map((s) => (
                        <button key={s.id} className={"nPill" + (sortBy === s.id ? " on" : "")}
                          aria-pressed={sortBy === s.id} onClick={() => setSortBy(s.id)}>{s.label}</button>
                      ))}
                    </span>
                  </span>
                </div>
                <div className="descCodes" role="group" aria-label="Codes to describe">
                  {codes.map((c) => (
                    <label key={c.name} className={"descPickRow" + (on.has(c.name) ? " on" : "")}>
                      <input type="checkbox" checked={on.has(c.name)} onChange={() => toggle(c.name)} />
                      <span className="mSw" style={{ background: codebook[c.name]?.color || "#999" }} />
                      <span className="descPickName">{c.name}</span>
                      {c.def
                        ? <span className="descPickDef" title={c.def}>{c.def}</span>
                        : <span className="descPickDef none">no definition</span>}
                      <span className="descPickN" title={`${c.segs} excerpt${c.segs === 1 ? "" : "s"} in ${c.pids} transcript${c.pids === 1 ? "" : "s"}`}>
                        {c.segs}·{c.pids}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="ai-warn">
                  <b>This sends {sent.length} code{sent.length === 1 ? "" : "s"} — names, current definitions,
                  and up to {DESC_EXEMPLARS} excerpts each — to OpenAI.</b> Excerpts are participant
                  data; make sure this is allowed by your consent form and ethics approval.
                </div>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}</pre>
                </div>
                <div className="ai-facts">
                  <span>codes <b>{codes.length}</b></span>
                  <span>excerpts <b>{exCount}</b></span>
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
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
