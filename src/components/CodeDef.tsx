// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// A code's definition, shown and edited in place. Editing lives on the page
// rather than in a dialog for two reasons: a modal re-bases its own font size
// (see about.css) so it ignored the reading and sidebar text-size settings this
// app exists for, and the Codebook already shows the coding a definition
// describes — no need to reprint it in a box on top of it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { excerptOf } from "../contract/excerpt";
import { Icon } from "./Icon";

// The right-click route needs a surface of its own — it fires from the code
// sidebar and the lane, where there is no definition on screen to edit in place.
// It is the SAME editor in a thin frame (no excerpts, no lede), sized by the
// reading text setting rather than the .about 1rem floor, so it scales like
// everything else. The menu's own form could only show three lines of a
// paragraph.
let openFn: ((code: string) => void) | null = null;
export function openDefine(code: string) { openFn?.(code); }

export function DefineHost() {
  const [code, setCode] = useState<string | null>(null);
  const fs = useStore((s) => s.ui.fontSize);
  const entry = useStore((s) => (code === null ? undefined : s.codebook[code]));
  const close = useCallback(() => setCode(null), []);
  useEffect(() => { openFn = setCode; return () => { openFn = null; }; }, []);
  useEffect(() => {
    if (code === null) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [code, close]);
  if (code === null || !entry) return null;
  return (
    <div className="about-backdrop" onMouseDown={close}>
      <div className="about defdlg" role="dialog" aria-modal="true" aria-labelledby="defdlg-title"
        style={{ fontSize: fs }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="defdlg-title">
            <span className="swatch" style={{ background: entry.color }} /> {code}
          </h2>
          <DefBadge def={entry.def} ai={entry.defAi} />
          {/* every other dialog in the app carries one; Esc and Cancel also close */}
          <button className="btn iconbtn" onClick={close} title="Close (Esc)" aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <DefLine code={code} autoEdit onDone={close} />
      </div>
    </div>
  );
}

// Definition provenance, wherever a definition shows: AI = the text is untouched
// model output; edited = a person wrote or reshaped it. No definition, no badge.
export function DefBadge({ def, ai }: { def: string; ai?: boolean }) {
  if (!def) return null;
  return ai
    ? <span className="defTag ai" title="AI-generated — not yet edited by a person">AI</span>
    : <span className="defTag" title="Written or edited by a person">edited</span>;
}

// A few of a code's excerpts, one per transcript first so a code used across
// sessions shows its breadth rather than three quotes from one participant.
export function codeExcerpts(code: string, max = 3): { text: string; ref: string }[] {
  const { segments, transcripts } = useStore.getState();
  const out: { text: string; ref: string }[] = [];
  const seenPid = new Set<string>();
  for (const pass of [true, false]) { // pass 1: unseen transcripts only; pass 2: fill up
    for (const s of segments) {
      if (out.length >= max) return out;
      if (s.code !== code || s.status !== "accepted" || !transcripts[s.pid]) continue;
      if (pass === seenPid.has(s.pid)) continue;
      const ex = excerptOf(transcripts[s.pid].lines
        .filter((l) => l.id >= s.start && l.id <= s.end)
        .map((l) => ({ text: l.text, speaker: l.speaker }))).excerpt.replace(/^\[R:\] /, "");
      if (!ex || out.some((x) => x.text === ex)) continue;
      seenPid.add(s.pid);
      out.push({ text: ex, ref: `${s.pid}:${s.start}${s.end !== s.start ? `-${s.end}` : ""}` });
    }
  }
  return out;
}

// The definition line: the text (or its absence) with its provenance badge,
// double-click to edit in place — the transcript's gesture. `excerpts` adds a
// disclosure with a few of the code's own quotes, for surfaces that don't
// already list them (the Assist panel; the Codebook prints them below).
export function DefLine({ code, excerpts = false, className = "", autoEdit = false, onDone }: {
  code: string; excerpts?: boolean; className?: string;
  autoEdit?: boolean;        // open straight into the editor (the dialog route)
  onDone?: () => void;       // told when an edit finishes, either way
}) {
  const entry = useStore((s) => s.codebook[code]);
  const setDef = useStore((s) => s.setDef);
  const [editing, setEditing] = useState(autoEdit);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(() => useStore.getState().codebook[code]?.def ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stop = () => { setEditing(false); onDone?.(); };

  // grow to the text: scrollHeight is the PADDING box, and these are border-box,
  // so the border has to be added back or the last line sits under the edge
  const fit = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  };
  useEffect(() => { if (editing) fit(taRef.current); }, [editing]);
  if (!entry) return null;

  const start = () => { setV(entry.def); setEditing(true); };
  // re-seed when the dialog route opens on a different code
  useEffect(() => { if (autoEdit) setV(entry.def); }, [autoEdit, code]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    const t = v.trim();
    // Saving the text UNCHANGED isn't authorship: it must not relabel an AI
    // definition as human-written, which would claim someone vouched for text
    // nobody touched.
    setDef(code, t, t === entry.def.trim() ? entry.defAi : false);
    stop();
  };

  if (editing) {
    return (
      <div className={`defLine editing ${className}`}>
        <textarea ref={taRef} className="defEdit" rows={2} autoFocus value={v}
          aria-label={`Definition for ${code}`} placeholder="Marks moments where…"
          onChange={(e) => { setV(e.target.value); fit(e.target); }}
          onKeyDown={(e) => {
            // Enter makes a new line here (definitions run to a paragraph), so
            // the commit key is Ctrl/Cmd+Enter — the buttons carry the rest
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            else if (e.key === "Escape") { e.stopPropagation(); stop(); }
          }} />
        <div className="defBar">
          <button className="nBtn pri" onMouseDown={(e) => e.preventDefault()} onClick={save}>Save</button>
          <button className="nBtn" onMouseDown={(e) => e.preventDefault()} onClick={stop}>Cancel</button>
          <span className="defHint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        </div>
      </div>
    );
  }

  const ex = excerpts && open ? codeExcerpts(code) : [];
  return (
    <div className={`defLine ${className}`}>
      <div className={"defText" + (entry.def ? "" : " none")} onDoubleClick={start}
        title={entry.def ? "Double-click to edit the definition" : "Double-click to write the definition"}>
        {entry.def || "No definition yet — double-click to write one."}
        <DefBadge def={entry.def} ai={entry.defAi} />
      </div>
      {excerpts && (
        <button className="defMore" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "hide excerpts" : "show excerpts"}
        </button>
      )}
      {ex.map((x) => (
        <div key={x.ref} className="defEx" style={{ borderLeftColor: entry.color }}>
          <div>{x.text}</div>
          <div className="defExRef">{x.ref}</div>
        </div>
      ))}
    </div>
  );
}
