// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Assist -> Ask: put a question to your own coded material and get back points,
// each carrying the refs it rests on. Every ref is clickable and lands on the
// excerpt or event it names.
//
// It is deliberately NOT a chat. Multi-turn would mean a conversation history in
// every payload — growing cost, and a consent gate that can no longer show you
// one payload and have that be the whole truth. A question is one request; a
// follow-up is another question over the same material.
import { useStore, type Answer } from "../state/store";
import { anchorMarkers, fmtLike, } from "../markers";
import { Icon } from "./Icon";

// The scope controls' own membership gesture: a row is IN or OUT, so a click
// toggles it rather than focusing it the way the Definitions rows do. Same row
// visuals, so the panels still look like one another.
export function ScopeGroup({ title, items, on, onToggle, onAll, disabled }: {
  title: string;
  items: { id: string; label: string; n?: number; color?: string }[];
  on: Set<string>;
  onToggle: (id: string) => void;
  onAll: (all: boolean) => void;
  disabled?: boolean;
}) {
  if (!items.length) return null;
  const every = items.every((i) => on.has(i.id));
  return (
    <div className={"askGroup" + (disabled ? " off" : "")}>
      <div className="nGrp askGrpHead">
        <span>{title}</span>
        <button className="defClear" disabled={disabled}
          onClick={() => onAll(!every)}>{every ? "none" : "all"}</button>
      </div>
      {items.map((i) => (
        <div key={i.id} className={"nLens" + (on.has(i.id) ? " sel" : "")}
          tabIndex={disabled ? -1 : 0} role="checkbox" aria-checked={on.has(i.id)}
          aria-disabled={disabled || undefined}
          aria-label={`${i.label}${i.n === undefined ? "" : `, ${i.n} in scope`}`}
          onClick={() => !disabled && onToggle(i.id)}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(i.id); }
          }}>
          <span className="askTick" aria-hidden="true">
            {on.has(i.id) ? <Icon name="check" size={13} /> : null}
          </span>
          {i.color && <span className="nDot" style={{ background: i.color }} />}
          <span className="nName">{i.label}</span>
          {i.n !== undefined && <span className="cnt" aria-hidden="true">{i.n}</span>}
        </div>
      ))}
    </div>
  );
}

// The answers, newest first — the record of what you asked and what it rested on.
export function AskList({ answers, question, setQuestion, onAsk, canAsk, why }: {
  answers: Answer[];
  question: string;
  setQuestion: (v: string) => void;
  onAsk: () => void;
  canAsk: boolean;
  why: string;                 // why the button is off, when it is
}) {
  const jumpTo = useStore((s) => s.jumpTo);
  const del = useStore((s) => s.deleteAnswer);
  return (
    <>
      <div className="askBox">
        <label className="askLabel" htmlFor="askq">Ask your coded material</label>
        <textarea id="askq" className="askInput" rows={2} value={question}
          placeholder="What did people say about losing the axis labels?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter makes a new line (a question runs to a sentence or two), so
            // the send key is Ctrl/Cmd+Enter — the same commit key the definition
            // editor uses
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canAsk) { e.preventDefault(); onAsk(); }
          }} />
        <div className="askBar">
          <button className="btn primary" onClick={onAsk} disabled={!canAsk} title={canAsk ? undefined : why}>
            <Icon name="sparkle" size={14} /> Ask
          </button>
          <span className="askHint">
            {canAsk ? <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> · you approve the payload before it sends</> : why}
          </span>
        </div>
      </div>

      {answers.length === 0 ? (
        <div className="empty">
          No questions yet. Ask one above and the AI answers from your codes, excerpts and
          events — every point carrying the refs it rests on, so you can check each one.
          It has not read your transcripts, only what you coded.
        </div>
      ) : (
        <div className="mList">
          {answers.map((a) => (
            <div key={a.aid} className="askAns">
              <div className="askQ">
                <span className="askQText">{a.question}</span>
                <button className="nBtn" title="Delete this answer" onClick={() => del(a.aid)}>Delete</button>
              </div>
              {a.points.map((p, i) => (
                <div key={i} className="askPoint">
                  <div className="askPointText">{p.text}</div>
                  <div className="askRefs">
                    {p.refs.map((r) => (
                      <button key={r} className="askRef" title={`Open ${r}`}
                        onClick={() => { const w = whereOf(r); if (w) jumpTo(w.pid, w.line); }}>{r}</button>
                    ))}
                  </div>
                </div>
              ))}
              {a.unsupported.length > 0 && (
                <div className="askUnsup">
                  {/* named, not hidden: a claim the material could not carry is
                      the most important thing on the card */}
                  <div className="askUnsupHead">Not supported by the material in scope</div>
                  {a.unsupported.map((u, i) => <div key={i} className="askUnsupLine">{u}</div>)}
                </div>
              )}
              <div className="askMeta">
                {a.scope.pids.length} transcript{a.scope.pids.length === 1 ? "" : "s"}
                {a.scope.excerpts && <> · {a.scope.codes.length} code{a.scope.codes.length === 1 ? "" : "s"}</>}
                {a.scope.events && <> · events</>}
                {" · "}{a.model} · ${a.costUsd.toFixed(4)}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// A ref is resolved against the CURRENT project, not against a map stored with
// the answer: an excerpt can be recoded, resized or deleted after the fact, and a
// link that still lands where the segment lives now is the honest one. A ref that
// no longer resolves simply doesn't navigate.
function whereOf(ref: string): { pid: string; line: number } | null {
  const s = useStore.getState();
  const at = ref.indexOf("@");
  if (at > 0) {
    // an event ref carries the session clock; find the event again by that time
    // and anchor it the way the transcript does, so the jump lands where the note
    // was made rather than at the top of the file
    const pid = ref.slice(0, at), time = ref.slice(at + 1);
    const lines = s.transcripts[pid]?.lines;
    if (!lines?.length) return null;
    const offset = s.video[pid]?.offset ?? 0;
    const tsSample = lines.find((l) => l.ts.trim())?.ts;
    const list = s.markers.filter((m) => m.pid === pid).sort((a, b) => a.t - b.t);
    const hit = list.find((m) => fmtLike(m.t - offset, tsSample) === time);
    if (!hit) return null;
    const placed = anchorMarkers(list, lines, offset);
    for (const [lid, ms] of placed.before) if (ms.some((m) => m.mid === hit.mid)) return { pid, line: lid };
    return { pid, line: lines[lines.length - 1].id }; // past the last line
  }
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m || !s.transcripts[m[1]]) return null;
  return { pid: m[1], line: +m[2] };
}
