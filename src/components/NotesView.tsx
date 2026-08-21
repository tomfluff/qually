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
import { playheadSecFor, seekVideo } from "../video/seek";
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

// a stamp line: starts with the em-dash marker and carries a clock time
const STAMP_RE = /^\u2014 .*\d{2}:\d{2}/;

export function NotesView() {
  const notes = useStore((s) => s.projectNotes);
  const setNotes = useStore((s) => s.setProjectNotes);
  const fontSize = useStore((s) => s.ui.fontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd+click a stamp line: go back to its moment — open the transcript,
  // select the line, seek the playhead. The breadcrumb is the way BACK, not
  // just a record. (A plain click keeps editing; the hint says the modifier.)
  const jumpFromStamp = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const ta = taRef.current;
    if (!ta) return;
    // the click already placed the caret — read the line under it
    const a = ta.selectionStart ?? 0;
    const line = notes.slice(notes.lastIndexOf("\n", a - 1) + 1,
      notes.indexOf("\n", a) === -1 ? notes.length : notes.indexOf("\n", a));
    if (!line.startsWith("— ")) return;
    const parts = line.slice(2).split(" · ").map((x) => x.trim());
    const s = useStore.getState();
    const pid = parts.find((x) => x in s.transcripts);
    if (!pid) return;
    e.preventDefault();
    const ln = parts.find((x) => x.startsWith("line "));
    const vid = parts.find((x) => x.startsWith("video "));
    if (ln) s.jumpTo(pid, parseInt(ln.slice(5), 10));
    else s.setActive(pid);
    // seek AFTER the view switch so the dock's element is the one registered
    if (vid) requestAnimationFrame(() => seekVideo(vid.slice(6)));
  };

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
        <span className="notesHint">Memos, hunches, decisions — one document for the whole study. Saved as you type; travels with the project file. <b>Ctrl+click</b> a stamp to jump back to its moment.</span>
        <button className="btn iconlabel" onClick={stamp}
          title="Insert a breadcrumb of what you were just doing — transcript, line, playhead (Ctrl+M)">
          <Icon name="pin" size={15} /> <span className="blabel">Stamp context</span>
        </button>
      </div>
      <div className="notesWrap">
        {/* the mirror re-renders the same text with transparent glyphs, so the
            chip it paints behind a stamp line sits exactly under the textarea's
            own (still fully editable) text */}
        <div ref={mRef} className="notesText notesMirror nicescroll" aria-hidden="true">
          {notes.split("\n").map((line, i) => (
            <span key={i}>{i > 0 ? "\n" : ""}{STAMP_RE.test(line)
              ? <span className="stampchip">{line}</span> : line}</span>
          ))}
          {"\u200b" /* keeps a final empty line the same height as the textarea's */}
        </div>
        <textarea ref={taRef} className="notesText nicescroll" value={notes} autoFocus
          aria-label="Project notes"
          // N types the letter while you write (as it must), so Escape is the
          // keyboard way back to where you were
          onMouseDown={jumpFromStamp}
          onKeyDown={(e) => {
            // Ctrl/Cmd+M: stamp without leaving the keyboard (M for moment)
            if ((e.ctrlKey || e.metaKey) && (e.key === "m" || e.key === "M")) {
              e.preventDefault(); stamp(); return;
            }
            if (e.key !== "Escape") return;
            e.stopPropagation();
            const st = useStore.getState();
            st.setActive(st.lastPid || st.tabs[0] || "browse");
          }}
          placeholder={"What are you noticing across the study?\n\nStamp context drops a line like “— 21 Aug 2026 14:30 · P07 · line 214 · video 0:14:03” so a memo keeps the moment it came from."}
          onScroll={(e) => { const m = mRef.current; if (m) m.scrollTop = e.currentTarget.scrollTop; }}
          onChange={(e) => setNotes(e.target.value)} />
      </div>
    </div>
  );
}
