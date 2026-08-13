// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The one place a code's definition is written by hand — opened from the code's
// right-click menu and by double-clicking the definition in the Codebook. A
// modal, not the old three-line menu form: definitions run longer than a menu
// row, and showing a few of the code's own excerpts next to the textarea keeps
// the writing grounded in how the code was actually used.
// Imperative opener (same pattern as colorPicker): callers anywhere say
// openDefine(code); the host lives once in App.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { excerptOf } from "../contract/excerpt";
import { Icon } from "./Icon";

// Definition provenance, wherever a definition shows: AI = the text is untouched
// model output; edited = a person wrote or reshaped it. No definition, no badge.
export function DefBadge({ def, ai }: { def: string; ai?: boolean }) {
  if (!def) return null;
  return ai
    ? <span className="defTag ai" title="AI-generated — not yet edited by a person">AI</span>
    : <span className="defTag" title="Written or edited by a person">edited</span>;
}

let openFn: ((code: string) => void) | null = null;
export function openDefine(code: string) { openFn?.(code); }

export function DefineHost() {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { openFn = setCode; return () => { openFn = null; }; }, []);
  if (code === null) return null;
  return <DefineModal code={code} onClose={() => setCode(null)} />;
}

function DefineModal({ code, onClose }: { code: string; onClose: () => void }) {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const setDef = useStore((s) => s.setDef);
  const entry = codebook[code];
  const [v, setV] = useState(entry?.def ?? "");
  const dialogRef = useDialogFocus();
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [onClose]);

  // a few of the code's own excerpts, one per transcript first so a code used
  // across sessions shows its breadth, capped at three
  const shown: { text: string; ref: string }[] = [];
  const seenPid = new Set<string>();
  for (const pass of [true, false]) { // pass 1: unseen transcripts only; pass 2: fill up
    for (const s of segments) {
      if (shown.length >= 3) break;
      if (s.code !== code || s.status !== "accepted" || !transcripts[s.pid]) continue;
      if (pass === (seenPid.has(s.pid))) continue;
      const ex = excerptOf(transcripts[s.pid].lines
        .filter((l) => l.id >= s.start && l.id <= s.end)
        .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
      if (!ex || shown.some((x) => x.text === ex)) continue;
      seenPid.add(s.pid);
      shown.push({ text: ex, ref: `${s.pid}:${s.start}${s.end !== s.start ? `-${s.end}` : ""}` });
    }
  }

  // Saving the text UNCHANGED isn't authorship: opening an AI definition and
  // pressing Save must not relabel it as human-written (the badge would then
  // claim a person vouched for text nobody touched).
  const save = () => {
    const t = v.trim();
    setDef(code, t, t === (entry?.def ?? "").trim() ? entry?.defAi : false);
    onClose();
  };

  if (!entry) return null;
  return (
    <div className="about-backdrop" onMouseDown={onClose}>
      <div className="about defmodal" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="define-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="define-title">
            <span className="swatch" style={{ background: entry.color }} /> {code}
          </h2>
          <DefBadge def={entry.def} ai={entry.defAi} />
          <button className="btn iconbtn" onClick={onClose} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
        <div className="ai-body nicescroll">
          <div className="ai-sec">Definition <span className="ai-sec-hint">what this code marks — and what it doesn't</span></div>
          <textarea ref={taRef} className="defText" autoFocus value={v} rows={4}
            placeholder="Marks moments where…"
            aria-label={`Definition for ${code}`}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); }} />
          {shown.length > 0 && (
            <>
              <div className="ai-sec">From your coding <span className="ai-sec-hint">a few excerpts carrying this code</span></div>
              {shown.map((x) => (
                <div key={x.ref} className="defEx" style={{ borderLeftColor: entry.color }}>
                  <div>{x.text}</div>
                  <div className="defExRef">{x.ref}</div>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="imp-actions">
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
