// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Shared shell for the AI consent modals (scan / ground / merge / suggest). Each
// modal keeps its own eligible-set, payload, and run loop; this owns the chrome
// they all repeated: the backdrop, the focus-trapped dialog, and the head.
import { useEffect, useId, type ReactNode } from "react";
import { MODELS } from "../ai/openai";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

export function AiModal({ title, busy, onClose, children }: {
  title: ReactNode; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialogRef = useDialogFocus();
  const titleId = useId();
  // No font-size of its own — it takes .about's 1rem floor. This used to override that
  // with ui.fontSize, the READING ramp (the transcript's 12–48px), which does not belong
  // to modal chrome: the consent gate rendered at up to 48px inside a fixed 680px box and
  // wrapped every lens label onto two lines. Scaling a dialog is browser zoom's job — it
  // grows the icons and padding too, which a font-size setting cannot. Two dialogs do
  // override, deliberately: DefineHost takes the reading ramp (a definition is content),
  // AddEventModal the panel ramp (a flow surface, like the code palette).
  // Every other dialog in the app closes on Escape; App's global handler bails
  // out on .about-backdrop, so these have to carry their own. Not while a run is
  // in flight — a stray Esc must not dismiss something being paid for.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [busy, onClose]);
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
export function ModelPicker({ modelId, onPick, disabled }: {
  modelId: string; onPick: (id: string) => void; disabled?: boolean;
}) {
  return (
    <>
      <div className="ai-sec">Model <span className="ai-sec-hint">this run only; the default is in Settings → AI</span></div>
      <div className="ai-models">
        {MODELS.map((m) => (
          // aria-pressed, not the class alone: which model is selected was
          // carried by colour only, so a screen reader could not tell what the
          // run about to be approved would actually be sent to.
          // disabled while a run is in flight — the closure has already captured
          // its model, so a click here would change the price and the highlight
          // while the request goes on being answered by the other one.
          <button key={m.id} className={modelId === m.id ? "on" : ""}
            aria-pressed={modelId === m.id} disabled={disabled}
            title={`${m.blurb} — $${m.in}/$${m.out} per 1M tokens in/out`}
            onClick={() => onPick(m.id)}>{m.name}</button>
        ))}
      </div>
    </>
  );
}
