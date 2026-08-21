// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the Code map's reconciliation run — same contract as every
// AI surface: see exactly what leaves the device before sending. One pass
// proposes similarity islands AND a per-code revision plan (rename / merge /
// remove-as-reject), reviewed on the map. Scope: the whole codebook, or one
// island for a cheaper local refinement. Evidence depth (excerpts per code) is
// the researcher's dial — more excerpts, better judgments, more tokens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type CodeGroup } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { renderMergePayload, type MergeCodeInput } from "../ai/dedupe";
import { reconcileCodes, estimateReconcileTokens, type ReconcilePlan, type ReconcileMode } from "../ai/reconcile";
import { announce } from "../announce";
import { AiModal, ModelPicker } from "./AiModal";

export function ReconcileModal({ groups, initialScope = "all", onPlan, onClose }: {
  groups: CodeGroup[];
  initialScope?: number | "all";
  onPlan: (plan: ReconcilePlan, scope: number | "all") => void;
  onClose: () => void;
}) {
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ groups: number; actions: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exN, setExN] = useState(8);
  const [scope, setScope] = useState<number | "all">(initialScope);
  const [mode, setMode] = useState<ReconcileMode>("consolidate");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // one input per in-scope code with accepted segments — name + def + up to exN excerpts
  const codes = useMemo<MergeCodeInput[]>(() => {
    const only = scope === "all" ? null : new Set(groups[scope]?.codes ?? []);
    const byCode = new Map<string, string[]>();
    for (const s of segments) {
      if (s.status !== "accepted" || !transcripts[s.pid]) continue;
      if (only && !only.has(s.code)) continue;
      const arr = byCode.get(s.code) ?? [];
      if (arr.length >= exN) continue;
      const ex = segExcerpt(s, transcripts[s.pid].lines).excerpt;
      if (ex) { arr.push(ex); byCode.set(s.code, arr); }
    }
    return [...byCode.entries()].map(([name, excerpts]) => ({
      name, def: codebook[name]?.def ?? "", excerpts,
    }));
  }, [segments, transcripts, codebook, exN, scope, groups]);

  const exCount = codes.reduce((n, c) => n + c.excerpts.length, 0);
  const inTok = useMemo(() => estimateReconcileTokens(codes, red), [codes, red]);
  const redactions = useMemo(() => codes.reduce((n, c) =>
    n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0), [codes, red]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(codes.length * 30)));
  const preview = renderMergePayload(codes, red);
  const enough = codes.length >= 4;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Reconciling ${codes.length} codes…`);
    abort.current = new AbortController();
    try {
      const { plan, usage } = await reconcileCodes({
        key, model: model.id, codes, redaction: red, mode, signal: abort.current.signal,
      });
      useStore.getState().logAiCall({
        at: new Date().toISOString(), model: model.id, task: "reconcile",
        pid: scope === "all" ? "(codebook)" : `(island: ${groups[scope]?.name})`,
        lines: codes.length, redactions,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      onPlan(plan, scope);
      setDone({ groups: plan.groups.length, actions: plan.actions.length, cost: usage.costUsd });
      announce(`${plan.groups.length} groups and ${plan.actions.length} revision proposals laid out on the map.`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
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
                Laid out <b>{done.groups} group{done.groups === 1 ? "" : "s"}</b> and proposed{" "}
                <b>{done.actions} revision{done.actions === 1 ? "" : "s"}</b> — each one waits on the
                map for your verdict (accept applies it, undoably; skip discards it). Nothing has
                changed yet, and "remove" only rejects a code's excerpts — the data stays in the file.
              </p>
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Review on the map</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                Second-cycle consolidation: the AI reads each code's definition and excerpts, groups
                codes by how they are USED, and proposes per-code revisions — clearer names, merges of
                splintered concepts, rejection of codes with no analytic value — so themes can build
                on clean, well-evidenced codes. You review every proposal on the map; coding stays yours.
                {groups.length > 0 && scope === "all" && <> <b>Your current groups are replaced.</b></>}
              </p>
              {enough && (
                <div className="ai-warn">
                  <b>This sends {codes.length} code{codes.length === 1 ? "" : "s"} — names, definitions,
                  and up to {exN} excerpts each — to OpenAI.</b> Excerpts are participant
                  data; make sure this is allowed by your consent form and ethics approval.
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
                <div className="srow">
                  <span>Scope</span>
                  <select className="settext" value={scope === "all" ? "all" : String(scope)}
                    onChange={(e) => setScope(e.target.value === "all" ? "all" : +e.target.value)}>
                    <option value="all">Whole codebook</option>
                    {groups.map((g, i) => <option key={i} value={i}>Island: {g.name}</option>)}
                  </select>
                </div>
                <label className="srow">
                  <span>Excerpts per code</span>
                  <input type="range" min={3} max={12} value={exN}
                    onChange={(e) => setExN(+e.target.value)} />
                  <span className="sval">{exN}</span>
                </label>
                <div className="settings-note">More excerpts give the AI better evidence for each judgment — and cost more tokens. The estimate below updates as you adjust.</div>
              </div>
              {!enough ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  Reconciling needs at least four codes with coded segments in scope. Code a bit
                  more (or widen the scope), then come back.
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
