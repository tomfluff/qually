// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Shared shell for the AI consent modals (scan / ground / merge / suggest). Each
// modal keeps its own eligible-set, payload, and run loop; this owns the chrome
// they all repeated: the backdrop, the focus-trapped dialog, and the head.
import { useId, type ReactNode } from "react";
import { MODELS } from "../ai/openai";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

export function AiModal({ title, busy, onClose, children }: {
  title: ReactNode; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialogRef = useDialogFocus();
  const titleId = useId();
  return (
    <div className="about-backdrop" onMouseDown={() => !busy && onClose()}>
      {/* ai-check: a fixed-head / scrolling-body / pinned-footer layout so the
          consent buttons stay reachable no matter how tall the payload preview and
          any lens/speaker lists get (without it the footer clipped below 84vh). */}
      <div className="about imp ai-check" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn iconbtn" onClick={onClose} disabled={busy} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// The per-run model override, identical in every AI modal. The Settings default
// seeds it; this only changes the one run.
export function ModelPicker({ modelId, onPick }: { modelId: string; onPick: (id: string) => void }) {
  return (
    <>
      <div className="ai-sec">Model <span className="ai-sec-hint">this run only — the default lives in Settings → AI</span></div>
      <div className="ai-models">
        {MODELS.map((m) => (
          <button key={m.id} className={modelId === m.id ? "on" : ""}
            title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
            onClick={() => onPick(m.id)}>{m.name}</button>
        ))}
      </div>
    </>
  );
}
