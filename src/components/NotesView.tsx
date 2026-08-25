// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The Notes tab: the project's memo document. Analytic memos are first-class
// qualitative practice — a thought that belongs to the whole study, written the
// moment it happens. One free-form text (the Summary pane's editor pattern,
// autosaved per keystroke), plus Stamp: a breadcrumb of what you were doing
// when the thought arrived (transcript, selected line, playhead), inserted at
// the cursor so future-you can re-find the moment behind the memo.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { fmtTime } from "../markers";
import { playheadSecFor, seekVideo } from "../video/seek";
import { Icon } from "./Icon";

// a stamp line: starts with the em-dash marker and carries a clock time
// where the document was parked, session-only (same pattern as Browse/Assist/Summary)
let notesScroll = 0;

const STAMP_RE = /^— .*\d{2}:\d{2}/;

// what you were doing, as one line: last transcript, its selected line, the
// playhead — each part only when it exists. Local wall-clock leads: memos are
// diary entries, and "when did I think this" is half the breadcrumb.
function stampLine(): string {
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
  const transcripts = useStore((s) => s.transcripts);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  // restore before paint, so the document never flashes at the top on the way back
  const setTa = useCallback((el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    if (el) el.scrollTop = notesScroll;
  }, []);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [findIdx, setFindIdx] = useState(0);

  // every occurrence of the query (case-insensitive); the query is a single
  // line, so a match can never cross a newline
  const matches = useMemo(() => {
    if (!findOpen || !find) return [];
    const out: number[] = [];
    const hay = notes.toLowerCase(), q = find.toLowerCase();
    for (let i = hay.indexOf(q); i !== -1 && out.length < 2000; i = hay.indexOf(q, i + q.length)) out.push(i);
    return out;
  }, [notes, find, findOpen]);
  const cur = matches.length ? ((findIdx % matches.length) + matches.length) % matches.length : -1;

  // keep the current match in sight: the mirror carries a real DOM node for it
  useEffect(() => {
    if (!findOpen || cur < 0) return;
    const el = mRef.current?.querySelector(".notesMark.cur");
    const ta = taRef.current, m = mRef.current;
    if (!el || !ta || !m) return;
    const er = el.getBoundingClientRect(), wr = m.getBoundingClientRect();
    if (er.top < wr.top + 40 || er.bottom > wr.bottom - 40)
      ta.scrollTop = m.scrollTop + (er.top - wr.top) - m.clientHeight / 2;
    m.scrollTop = ta.scrollTop;
  }, [cur, matches, findOpen]);

  const closeFind = () => {
    setFindOpen(false);
    const ta = taRef.current;
    if (!ta) return;
    // hand the spot over: caret lands on the match the find bar was showing
    const at = cur >= 0 ? matches[cur] : null;
    requestAnimationFrame(() => {
      ta.focus();
      if (at !== null) ta.setSelectionRange(at, at + find.length);
    });
  };

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

  // pointer cursor over a live stamp chip while the jump modifier is held —
  // the mirror's chip rects are exactly where the textarea's stamp text sits
  const hoverChip = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = taRef.current;
    if (!ta) return;
    let ptr = false;
    if (e.ctrlKey || e.metaKey) {
      for (const c of mRef.current?.querySelectorAll(".stampchip:not(.dead)") ?? []) {
        const r = c.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { ptr = true; break; }
      }
    }
    ta.style.cursor = ptr ? "pointer" : "";
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

  // one line of the mirror, with any find matches wrapped so they highlight
  const lineWithMatches = (line: string, start: number) => {
    if (!matches.length) return line;
    const q = find.length;
    const here = matches.filter((m) => m >= start && m < start + line.length);
    if (!here.length) return line;
    const out: React.ReactNode[] = [];
    let c = 0;
    for (const m of here) {
      out.push(line.slice(c, m - start));
      out.push(<span key={m} className={"notesMark" + (matches[cur] === m ? " cur" : "")}>{line.slice(m - start, m - start + q)}</span>);
      c = m - start + q;
    }
    out.push(line.slice(c));
    return out;
  };

  let off = 0;
  const mirrorLines = notes.split("\n").map((line, i) => {
    const start = off;
    off += line.length + 1;
    const isStamp = STAMP_RE.test(line);
    // a stamp whose transcript is gone (closed project half, renamed pid) has
    // nowhere to jump — it greys out instead of silently doing nothing
    const dead = isStamp && !line.slice(2).split(" · ").some((x) => x.trim() in transcripts);
    const content = lineWithMatches(line, start);
    return (
      <span key={i}>{i > 0 ? "\n" : ""}{isStamp
        ? <span className={"stampchip" + (dead ? " dead" : "")}>{content}</span> : content}</span>
    );
  });

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
          {mirrorLines}
          {"​" /* keeps a final empty line the same height as the textarea's */}
        </div>
        <textarea ref={setTa} className="notesText nicescroll" value={notes} autoFocus
          aria-label="Project notes"
          // N types the letter while you write (as it must), so Escape is the
          // keyboard way back to where you were
          onMouseDown={jumpFromStamp}
          onMouseMove={hoverChip}
          onKeyDown={(e) => {
            // Ctrl/Cmd+M: stamp without leaving the keyboard (M for moment)
            if ((e.ctrlKey || e.metaKey) && (e.key === "m" || e.key === "M")) {
              e.preventDefault(); stamp(); return;
            }
            // Ctrl/Cmd+F: find within the document (the browser can't scroll a textarea)
            if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
              e.preventDefault(); setFindOpen(true); setFindIdx(0);
              requestAnimationFrame(() => findRef.current?.select());
              return;
            }
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (findOpen) { setFindOpen(false); return; }
            const st = useStore.getState();
            st.setActive(st.lastPid || st.tabs[0] || "browse");
          }}
          placeholder={"What are you noticing across the study?\n\nStamp context drops a line like “— 21 Aug 2026 14:30 · P07 · line 214 · video 0:14:03” so a memo keeps the moment it came from."}
          onScroll={(e) => { notesScroll = e.currentTarget.scrollTop; const m = mRef.current; if (m) m.scrollTop = e.currentTarget.scrollTop; }}
          onChange={(e) => setNotes(e.target.value)} />
        {findOpen && (
          <div className="notesFind" style={{ fontSize: sidebarFontSize }}>
            <input ref={findRef} value={find} placeholder="Find in notes" aria-label="Find in notes"
              onChange={(e) => { setFind(e.target.value); setFindIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); setFindIdx(cur + (e.shiftKey ? -1 : 1)); }
                if (e.key === "Escape") { e.stopPropagation(); closeFind(); }
              }} />
            <span className="findCount">{find ? (matches.length ? `${cur + 1}/${matches.length}` : "0") : ""}</span>
            <button className="btn" onClick={() => setFindIdx(cur - 1)} title="Previous match (Shift+Enter)"><Icon name="chevron-up" size={14} /></button>
            <button className="btn" onClick={() => setFindIdx(cur + 1)} title="Next match (Enter)"><Icon name="chevron-down" size={14} /></button>
            <button className="btn" onClick={closeFind} title="Close (Esc)"><Icon name="x" size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}
