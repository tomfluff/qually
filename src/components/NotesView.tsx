// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Notes tab: the project's memo document. Analytic memos are first-class
// qualitative practice — a thought that belongs to the whole study, written the
// moment it happens. One free-form text (the Summary pane's editor pattern,
// autosaved per keystroke), plus Stamp: a breadcrumb of what you were doing
// when the thought arrived (transcript, selected line, playhead), inserted at
// the cursor so future-you can re-find the moment behind the memo.
import { useRef } from "react";
import { useStore } from "../state/store";
import { fmtTime } from "../markers";
import { playheadSecFor } from "../video/seek";
import { Icon } from "./Icon";

// what you were doing, as one line: last transcript, its selected line, the
// playhead — each part only when it exists. Local wall-clock leads: memos are
// diary entries, and "when did I think this" is half the breadcrumb.
export function stampLine(): string {
  const s = useStore.getState();
  const now = new Date();
  const when = `${now.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const parts = [`— ${when}`];
  const pid = s.lastPid;
  if (pid) {
    parts.push(pid);
    // the live selection empties on tab switch; the transcript's own stash
    // (savedSelections) still holds what was selected when you left it
    const sel = s.selection.pid === pid ? s.selection : s.savedSelections[pid];
    if (sel && sel.head !== null) parts.push(`line ${sel.head}`);
    const t = playheadSecFor(pid);
    if (t !== null) parts.push(`video ${fmtTime(t)}`);
  }
  return parts.join(" · ");
}

export function NotesView() {
  const notes = useStore((s) => s.projectNotes);
  const setNotes = useStore((s) => s.setProjectNotes);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const stamp = () => {
    const ta = taRef.current;
    const line = stampLine();
    if (!ta) { setNotes(notes + (notes && !notes.endsWith("\n") ? "\n" : "") + line + "\n"); return; }
    // insert at the cursor, on its own line, and put the caret after it
    const a = ta.selectionStart ?? notes.length, b = ta.selectionEnd ?? a;
    const pre = notes.slice(0, a), post = notes.slice(b);
    const ins = (pre && !pre.endsWith("\n") ? "\n" : "") + line + "\n";
    setNotes(pre + ins + post);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = a + ins.length;
    });
  };

  return (
    <div id="notes" style={{ fontSize }}>
      <div className="notesBar" style={{ fontSize: sidebarFontSize }}>
        <span className="notesTitle">Project notes</span>
        <span className="notesHint">Memos, hunches, decisions — one document for the whole study. Saved as you type; travels with the project file.</span>
        <button className="btn iconlabel" onClick={stamp}
          title="Insert a breadcrumb of what you were just doing (transcript, line, playhead)">
          <Icon name="pin" size={15} /> <span className="blabel">Stamp context</span>
        </button>
      </div>
      <textarea ref={taRef} className="notesText nicescroll" value={notes} autoFocus
        aria-label="Project notes"
        // N types the letter while you write (as it must), so Escape is the
        // keyboard way back to where you were
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          const st = useStore.getState();
          st.setActive(st.lastPid || st.tabs[0] || "browse");
        }}
        placeholder={"What are you noticing across the study?\n\nStamp context drops a line like “— 21 Aug 2026 14:30 · P07 · line 214 · video 0:14:03” so a memo keeps the moment it came from."}
        onChange={(e) => setNotes(e.target.value)} />
    </div>
  );
}
