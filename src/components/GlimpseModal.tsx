// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the halo's "describe this group": one small request that
// reads the group's codes (names, definitions, a few excerpts each) and
// returns a two-sentence glimpse of what the group means — saved onto the
// cluster so the card shows it. Same contract as every AI surface.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError, callJson } from "../ai/openai";
import { redactor, restore } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { renderMergePayload, type MergeCodeInput } from "../ai/dedupe";
import { announce } from "../announce";
import { AiModal, ModelPicker } from "./AiModal";

const SYSTEM = `You are helping a qualitative researcher revise a codebook. The codes below are proposed to merge into one. In TWO sentences, plain language: what kind of moment do these codes mark, and what unites their excerpts? This is a glimpse for the researcher deciding the merge — describe the shared usage, do not evaluate the merge. Text like [REDACTED_1] is a removed identifier; ignore it as evidence.`;
const SCHEMA = {
  type: "object",
  properties: { glimpse: { type: "string", description: "two plain sentences" } },
  required: ["glimpse"], additionalProperties: false,
} as const;

export function GlimpseModal({ ci, onClose }: { ci: number; onClose: () => void }) {
  const cluster = useStore((s) => s.codeClusters[ci]);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  const codes = useMemo<MergeCodeInput[]>(() => {
    const member = new Set(cluster?.codes ?? []);
    const byCode = new Map<string, string[]>();
    for (const s of segments) {
      if (s.status !== "accepted" || !member.has(s.code) || !transcripts[s.pid]) continue;
      const arr = byCode.get(s.code) ?? [];
      if (arr.length >= 4) continue;
      const ex = segExcerpt(s, transcripts[s.pid].lines).excerpt;
      if (ex) { arr.push(ex); byCode.set(s.code, arr); }
    }
    return [...member].map((name) => ({
      name, def: codebook[name]?.def ?? "", excerpts: byCode.get(name) ?? [],
    }));
  }, [cluster, segments, transcripts, codebook]);

  const preview = renderMergePayload(codes, red);
  const inTok = estimateTokens(SYSTEM) + estimateTokens(preview);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(80)));

  const run = async () => {
    const key = getKey();
    if (!key) { const m = "No API key set. Add one in Settings → AI."; setErr(m); announce(m, { assertive: true }); return; }
    setBusy(true); setErr(null);
    abort.current = new AbortController();
    try {
      const { data, usage } = await callJson<{ glimpse: string }>({
        key, model: model.id, system: SYSTEM,
        user: renderMergePayload(codes, red),
        schemaName: "glimpse_group", schema: SCHEMA, signal: abort.current.signal,
      });
      const text = restore(red, (data.glimpse ?? "").trim());
      const st = useStore.getState();
      st.setCodeClusters(st.codeClusters.map((c, i) => (i === ci ? { ...c, desc: text } : c)));
      st.logAiCall({
        at: new Date().toISOString(), model: model.id, task: "glimpse", pid: "(codebook)",
        lines: codes.length, redactions: 0,
        inTok: usage.inTok, outTok: usage.outTok, costUsd: +usage.costUsd.toFixed(5),
      });
      setDone(text);
      announce("Group description ready.");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg); announce(`Describe failed: ${msg}`, { assertive: true });
    } finally { setBusy(false); }
  };

  if (!cluster) return null;
  return (
    <AiModal title={`Describe “${cluster.newName ?? cluster.survivor}”`} busy={busy} onClose={onClose}>
        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">{done}</p>
              <div className="settings-note">Saved on the group — the cluster card shows it from now on.</div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                A two-sentence glimpse of what this group means, from its codes' definitions and a few
                excerpts each — for judging the merge, saved onto the group.
              </p>
              <div className="ai-warn">
                <b>This sends {codes.length} code{codes.length === 1 ? "" : "s"} with up to 4 excerpts
                each to OpenAI.</b> Excerpts are participant data; make sure this is allowed by your
                consent form and ethics approval.
              </div>
              <ModelPicker modelId={modelId} onPick={setModelId} />
              <div className="ai-payload">
                <div className="ai-payload-head">
                  <span className="eyebrow">Exactly what leaves your device</span>
                  <span className="ai-model">{model.id}</span>
                </div>
                <pre className="nicescroll">{preview}</pre>
              </div>
              <div className="ai-facts">
                <span>codes <b>{codes.length}</b></span>
                <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                <span>≈ <b>${estCost.toFixed(4)}</b></span>
              </div>
            </div>
            {err && <div className="ai-err">{err}</div>}
            <div className="imp-actions">
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? "Describing…" : "Send 1 request to OpenAI"}
              </button>
              <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                {busy ? "Stop" : "Cancel — send nothing"}
              </button>
            </div>
          </>
        )}
    </AiModal>
  );
}
