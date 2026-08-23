// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the Code map's reconciliation run — same contract as every
// AI surface: see exactly what leaves the device before sending. One pass
// proposes similarity islands AND a per-code revision plan (rename / merge /
// remove-as-reject), reviewed on the map. Scope: the whole codebook, or one
// island for a cheaper local refinement. Evidence depth (excerpts per code) is
// the researcher's dial — more excerpts, better judgments, more tokens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, liveCodes, type CodeGroup } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { renderMergePayload, type MergeCodeInput } from "../ai/dedupe";
import { reconcileCodes, reconcileFocus, estimateReconcileTokens, estimateFocusTokens, renderFocusPayload, mergeFocusResults, type ReconcilePlan, type ReconcileMode } from "../ai/reconcile";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";

export type ReconcileScope = number | "all" | { focus: string[] };
export function ReconcileModal({ groups, initialScope = "all", onPlan, onClose }: {
  groups: CodeGroup[];
  initialScope?: ReconcileScope;
  onPlan: (plan: ReconcilePlan, scope: ReconcileScope, meta?: { replaced: number; unreviewed: string[] }) => void;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ clusters: number; actions: number; cost: number; replaced?: number; unreviewed?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exN, setExN] = useState(8);
  const [scope, setScope] = useState<ReconcileScope>(initialScope);
  const [mode, setMode] = useState<ReconcileMode>("consolidate");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  const focusMode = typeof scope === "object";
  // excerpt gatherer: cap excerpts per code; include zero-evidence codes when asked
  const gather = useMemo(() => {
    return (only: Set<string> | null, cap: number, includeEmpty: boolean): MergeCodeInput[] => {
      const byCode = new Map<string, string[]>();
      for (const s of segments) {
        if (s.status !== "accepted" || !transcripts[s.pid]) continue;
        // a code you set aside is out of the analysis, so it is out of the
        // payload — its excerpts are still there, they are just not evidence
        // the model is asked to reason about
        if (codebook[s.code]?.parked) continue;
        if (only && !only.has(s.code)) continue;
        const arr = byCode.get(s.code) ?? [];
        if (arr.length >= cap) continue;
        const ex = segExcerpt(s, transcripts[s.pid].lines).excerpt;
        if (ex) { arr.push(ex); byCode.set(s.code, arr); }
      }
      const names = includeEmpty && only
        ? [...only].filter((n) => n in codebook && !codebook[n].parked)
        : [...byCode.keys()];
      return names.map((name) => ({ name, def: codebook[name]?.def ?? "", excerpts: byCode.get(name) ?? [] }));
    };
  }, [segments, transcripts, codebook]);
  // one input per in-scope code — name + def + up to exN excerpts. Focus mode:
  // focus codes carry the full evidence dial (zero-evidence ones included),
  // the REST of the codebook rides as context with 2 excerpts each.
  const focusSet = useMemo(() => (focusMode ? new Set((scope as { focus: string[] }).focus.filter((c) => c in codebook)) : null),
    [focusMode, scope, codebook]);
  const codes = useMemo<MergeCodeInput[]>(() => {
    if (focusMode) return gather(focusSet, exN, true);
    const only = scope === "all" ? null : new Set(groups[scope as number]?.codes ?? []);
    return gather(only, exN, false);
  }, [gather, focusMode, focusSet, exN, scope, groups]);
  const contextCodes = useMemo<MergeCodeInput[]>(() => {
    if (!focusMode) return [];
    const rest = new Set(liveCodes(codebook).filter((c) => !focusSet!.has(c)));
    // includeEmpty: "the WHOLE codebook" means it — a definition-only code
    // with no excerpts yet is often exactly the right home for a stray
    return gather(rest, 2, true);
  }, [gather, focusMode, focusSet, codebook]);

  const exCount = codes.reduce((n, c) => n + c.excerpts.length, 0)
    + contextCodes.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => focusMode
    ? estimateFocusTokens(codes, contextCodes, red)
    : estimateReconcileTokens(codes, red), [focusMode, codes, contextCodes, red]);
  const redactions = useMemo(() => [...codes, ...contextCodes].reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [codes, contextCodes, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(codes.length * 30)));
  // the preview IS the payload — same renderer the request uses
  const preview = focusMode
    ? renderFocusPayload(codes, contextCodes, red)
    : renderMergePayload(codes, red);
  const enough = focusMode ? codes.length >= 1 && contextCodes.length >= 1 : codes.length >= 4;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Reconciling ${codes.length} codes…`);
    earcon.aiStart();
    abort.current = new AbortController();
    try {
      let plan: ReconcilePlan; let usage: { inTok: number; outTok: number; costUsd: number };
      let fresh: { clusters: number; actions: number } | undefined;
      let meta: { replaced: number; unreviewed: string[] } | undefined;
      if (focusMode) {
        const r = await reconcileFocus({
          key, model: model.id, focus: codes, context: contextCodes,
          redaction: red, mode, signal: abort.current.signal,
        });
        usage = r.usage;
        fresh = { clusters: r.plan.clusters.length, actions: r.plan.actions.length };
        const st = useStore.getState();
        // only the exactly-once-reviewed set may evict pending work — an
        // omitted code's pending proposal survives the model's oversight
        const merged = mergeFocusResults(st.codeClusters, st.codePlan, r.plan,
          new Set(r.reviewed));
        meta = { replaced: merged.replaced, unreviewed: r.unreviewed };
        plan = { clusters: merged.clusters, actions: merged.actions };
      } else {
        const r = await reconcileCodes({
          key, model: model.id, codes, redaction: red, mode, signal: abort.current.signal,
        });
        plan = r.plan; usage = r.usage;
      }
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "reconcile",
        pid: focusMode ? `(focus: ${codes.length} codes)`
          : scope === "all" ? "(codebook)" : `(island: ${groups[scope as number]?.name})`,
        lines: codes.length + contextCodes.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      onPlan(plan, scope, meta);
      // report what THIS run produced; the merged plan (with pre-existing
      // pending work) still goes to the map via onPlan
      const nC = fresh ? fresh.clusters : plan.clusters.length;
      const nA = fresh ? fresh.actions : plan.actions.length;
      setDone({ clusters: nC, actions: nA, cost: usage.costUsd, ...(meta ? { replaced: meta.replaced, unreviewed: meta.unreviewed.length } : {}) });
      earcon.aiDone();
      announce(`${nC} merge cluster${nC === 1 ? "" : "s"} and ${nA} action${nA === 1 ? "" : "s"} laid out on the map.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Reconciliation failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Reconcile codes" busy={busy} onClose={onClose}>
        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                Proposed <b>{done.clusters} merge cluster{done.clusters === 1 ? "" : "s"}</b> and{" "}
                <b>{done.actions} rename/reject{done.actions === 1 ? "" : "s"}</b> — each waits on the
                map as a constellation or badge for your verdict (accept applies it, undoably; skip
                discards it). Nothing has changed yet, and "remove" only rejects a code's excerpts —
                the data stays in the file.
              </p>
              {done.replaced != null && done.replaced > 0 && (
                <div className="settings-note">Replaced {done.replaced} pending proposal{done.replaced === 1 ? "" : "s"} that touched the reviewed codes.</div>
              )}
              {done.unreviewed != null && done.unreviewed > 0 && (
                <div className="settings-note"><b>{done.unreviewed}</b> focus code{done.unreviewed === 1 ? "" : "s"} came back unreviewed — treat their absence as oversight, not a keep.</div>
              )}
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Review on the map</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                Second-cycle consolidation: the AI reads each code's definition and excerpts and
                proposes merge CLUSTERS — sets of codes that are the same concept, with a survivor —
                plus clearer names and (in Full revision) rejections of codes with no analytic value.
                On a well-coded book most codes come back untouched; clusters land as constellations
                for your verdict, and coding stays yours.
              </p>
              {enough && (
                <div className="ai-warn">
                  {focusMode ? (
                    <><b>This sends the WHOLE codebook — {codes.length} focus code{codes.length === 1 ? "" : "s"} with
                    up to {exN} excerpts each, plus {contextCodes.length} context codes with definitions and 2 excerpts
                    each — to OpenAI.</b> Excerpts are participant data; make sure this is allowed by your
                    consent form and ethics approval.</>
                  ) : (
                    <><b>This sends {codes.length} code{codes.length === 1 ? "" : "s"} — names, definitions,
                    and up to {exN} excerpts each — to OpenAI.</b> Excerpts are participant
                    data; make sure this is allowed by your consent form and ethics approval.</>
                  )}
                </div>
              )}
              <ModelPicker modelId={modelId} onPick={setModelId} />
              <div className="recDials">
                <div className="srow" role="radiogroup" aria-label="Phase">
                  <span>Phase</span>
                  <div className="segmented">
                    <button className={"seg" + (mode === "consolidate" ? " on" : "")}
                      role="radio" aria-checked={mode === "consolidate"}
                      onClick={() => setMode("consolidate")}
                      title="Low-level cleanup first: merge near-duplicates, sharpen names. No removals.">
                      Consolidate
                    </button>
                    <button className={"seg" + (mode === "full" ? " on" : "")}
                      role="radio" aria-checked={mode === "full"}
                      onClick={() => setMode("full")}
                      title="Everything: merges, renames, and rejecting codes with no analytic value.">
                      Full revision
                    </button>
                  </div>
                </div>
                {focusMode ? (
                  <div className="srow">
                    <span>Scope</span>
                    <span className="settings-note" style={{ margin: 0 }}>
                      Where do these belong: {codes.map((c) => c.name).join(", ")} — reviewed against the whole codebook.
                    </span>
                  </div>
                ) : (
                  <div className="srow">
                    <span>Scope</span>
                    <select className="settext" value={scope === "all" ? "all" : String(scope)}
                      onChange={(e) => setScope(e.target.value === "all" ? "all" : +e.target.value)}>
                      <option value="all">Whole codebook</option>
                      {groups.map((g, i) => <option key={i} value={i}>Island: {g.name}</option>)}
                    </select>
                  </div>
                )}
                <label className="srow">
                  <span>Excerpts per code</span>
                  <input type="range" min={3} max={12} value={exN}
                    onChange={(e) => setExN(+e.target.value)} />
                  <span className="sval">{exN}</span>
                </label>
              </div>
              <div className="settings-note">More excerpts give the AI better evidence for each judgment — and cost more tokens. The estimate below updates as you adjust.</div>
              {!enough ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {focusMode
                    ? "None of the selected codes are still in the codebook (or there are no other codes to review them against). Close this and select codes on the map."
                    : "Reconciling needs at least four codes with coded segments in scope. Code a bit more (or widen the scope), then come back."}
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
            {!enough ? (
              <div className="imp-actions"><button className="btn" onClick={onClose}>Close</button></div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? "Reconciling…" : "Send 1 request to OpenAI"}
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
