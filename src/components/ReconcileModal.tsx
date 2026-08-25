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
import { reconcileCodes, reconcileFocus, estimateReconcileTokens, estimateFocusTokens, renderFocusPayload, mergeFocusResults, DEFAULT_ASKS, type ReconcilePlan, type ReconcileAsks } from "../ai/reconcile";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, ModelPicker } from "./AiModal";

type ReconcileScope = number | "all" | { focus: string[] };
/** how much evidence each code carries into the request (see exN below) */
const EXCERPTS_PER_CODE = 8;
export function ReconcileModal({ groups, initialScope = "all", selected = [], onPlan, onClose }: {
  groups: CodeGroup[];
  initialScope?: ReconcileScope;
  /** codes selected on the map when this opened — the scope choice is about these */
  selected?: string[];
  onPlan: (plan: ReconcilePlan, scope: ReconcileScope,
    meta?: { replaced: number; unreviewed: string[]; model?: string }) => void;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ clusters: number; actions: number; cost: number; replaced?: number; unreviewed?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Fixed, not a dial. It was a slider with a cost curve attached, which asked
  // the researcher to trade evidence for pennies on every run — eight excerpts
  // is enough to judge a code by and cheap enough not to think about.
  const exN = EXCERPTS_PER_CODE;
  const [scope, setScope] = useState<ReconcileScope>(initialScope);
  // only codes that still exist can be asked about
  const picked = useMemo(() => selected.filter((c) => c in codebook), [selected, codebook]);
  // what this run may propose — ticked like the observation scan's lenses
  const [asks, setAsks] = useState<ReconcileAsks>(DEFAULT_ASKS);
  const askable = asks.merge || asks.rename || asks.remove;
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
    ? estimateFocusTokens(codes, contextCodes, red, asks)
    : estimateReconcileTokens(codes, red, asks), [focusMode, codes, contextCodes, red, asks]);
  const redactions = useMemo(() => [...codes, ...contextCodes].reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [codes, contextCodes, red]);
  // clusters + rationales run long, and every call bills low-effort reasoning
  // at the OUTPUT rate on top (see DescribeModal). Overshoot: this number sits
  // next to the Send button.
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(codes.length * 80)) + 500);
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
      let meta: { replaced: number; unreviewed: string[]; model?: string } | undefined;
      if (focusMode) {
        const r = await reconcileFocus({
          key, model: model.id, focus: codes, context: contextCodes,
          redaction: red, asks, signal: abort.current.signal,
        });
        usage = r.usage;
        fresh = { clusters: r.plan.clusters.length, actions: r.plan.actions.length };
        const st = useStore.getState();
        // only the exactly-once-reviewed set may evict pending work — an
        // omitted code's pending proposal survives the model's oversight
        const merged = mergeFocusResults(st.codeClusters, st.codePlan, r.plan,
          new Set(r.reviewed));
        meta = { replaced: merged.replaced, unreviewed: r.unreviewed, model: model.id };
        plan = { clusters: merged.clusters, actions: merged.actions };
      } else {
        const r = await reconcileCodes({
          key, model: model.id, codes, redaction: red, asks, signal: abort.current.signal,
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
      // the model that produced these rides along, so a decision made from
      // them a week later can still name it
      onPlan(plan, scope, meta ?? { replaced: 0, unreviewed: [], model: model.id });
      // report what THIS run produced; the merged plan (with pre-existing
      // pending work) still goes to the map via onPlan
      const nC = fresh ? fresh.clusters : plan.clusters.length;
      const nA = fresh ? fresh.actions : plan.actions.length;
      setDone({ clusters: nC, actions: nA, cost: usage.costUsd, ...(meta ? { replaced: meta.replaced, unreviewed: meta.unreviewed.length } : {}) });
      earcon.aiDone();
      announce(`${nC} merge cluster${nC === 1 ? "" : "s"} and ${nA} action${nA === 1 ? "" : "s"} laid out on the map.`);
    } catch (e) {
      // the request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete)
      useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "reconcile",
        pid: focusMode ? `(focus: ${codes.length} codes)`
          : scope === "all" ? "(codebook)" : `(island: ${groups[scope as number]?.name})`,
        lines: codes.length + contextCodes.length, redactions,
      });
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
    <AiModal title="Consolidate the codebook" busy={busy} onClose={onClose}>
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
                proposes only what you tick below. On a well-coded book most codes come back
                untouched; every proposal waits on the map for your verdict.
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
                {/* What this run may propose. Three permissions, ticked like
                    the observation scan's lenses — the pair of bundles they
                    replace ("Consolidate" / "Full revision") named difficulty
                    settings and said nothing about the one thing that
                    mattered: whether a model may suggest throwing work away. */}
                <div className="ai-sec">May propose <span className="ai-sec-hint">every proposal still waits for your verdict</span></div>
                <div className="ai-lenses recAsks">
                  {/* the titles carry it; the long explanations moved to the
                      tooltip, where they are there for the one reading that
                      needs them and out of the way of the nine that do not */}
                  {([
                    ["merge", "Code merges", "Sets of codes that are one concept, with a survivor"],
                    ["rename", "Code renaming", "A name that misdescribes what its excerpts show"],
                    ["remove", "Code omissions (soft)", "Codes it judges to carry nothing of their own. Accepting one rejects that code's excerpts — the data stays in the file"],
                  ] as const).map(([id, label, hint]) => (
                    <label key={id} className="ai-lens" title={hint}>
                      <input type="checkbox" checked={asks[id]}
                        onChange={() => setAsks((a) => ({ ...a, [id]: !a[id] }))} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                {picked.length > 0 && (
                  <div className="srow" role="radiogroup" aria-label="Scope">
                    <span>Scope</span>
                    <div className="segmented">
                      <button className={"seg" + (focusMode ? " on" : "")}
                        role="radio" aria-checked={focusMode}
                        onClick={() => setScope({ focus: picked })}
                        title="Ask where the selected codes belong — reviewed against the whole codebook">
                        {picked.length === 1 ? "The selected code" : `The ${picked.length} selected`}
                      </button>
                      <button className={"seg" + (focusMode ? "" : " on")}
                        role="radio" aria-checked={!focusMode}
                        onClick={() => setScope("all")}
                        title="Review every code against every other">
                        Whole codebook
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
                <button className="btn primary" onClick={run} disabled={busy || !askable}
                  title={askable ? undefined : "Tick at least one thing the AI may propose"}>
                  {busy ? "Reconciling…" : askable ? "Send 1 request to OpenAI" : "Nothing to ask for"}
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
