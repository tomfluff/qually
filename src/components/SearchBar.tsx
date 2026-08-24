// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../state/store";
import { findMatches, replaceOccurrence } from "../search";
import { withSubs, SubText, subSpans } from "../markup";
import { Icon } from "./Icon";
import { announce } from "../announce";

// render text with all query matches wrapped in <mark>
function highlight(text: string, query: string): ReactNode {
  const m = findMatches(text, query);
  const subs = subSpans(text);
  if (!m.length) return withSubs(text, 0, subs);
  const nodes: ReactNode[] = [];
  let last = 0;
  m.forEach(([s, e], k) => {
    if (s > last) nodes.push(<SubText key={"p" + k} text={text.slice(last, s)} from={last} spans={subs} />);
    nodes.push(<mark key={k}><SubText text={text.slice(s, e)} from={s} spans={subs} /></mark>);
    last = e;
  });
  if (last < text.length) nodes.push(<SubText key="tail" text={text.slice(last)} from={last} spans={subs} />);
  return nodes;
}

export function SearchBar() {
  const search = useStore((s) => s.search);
  const transcripts = useStore((s) => s.transcripts);
  const active = useStore((s) => s.active);
  const setSearch = useStore((s) => s.setSearch);
  const closeSearch = useStore((s) => s.closeSearch);
  const scrollToLine = useStore((s) => s.scrollToLine);
  const jumpTo = useStore((s) => s.jumpTo);
  const editLine = useStore((s) => s.editLine);
  const replaceInTranscript = useStore((s) => s.replaceInTranscript);
  const inputRef = useRef<HTMLInputElement>(null);
  const replRef = useRef<HTMLInputElement>(null);
  const [idx, setIdx] = useState(0);
  // Find and replace. Closed by default: most searches are reading, not
  // rewriting, and a rewrite of the transcript is not something to offer by
  // accident. Its own state, not the store's — a half-typed replacement is not
  // project data, and it must not survive the bar closing.
  const [repOpen, setRepOpen] = useState(false);
  const [repl, setRepl] = useState("");
  // Substitutions are the reason this exists: a participant says "the first
  // system" and the researcher writes in which system that was. Brackets are
  // the app-wide convention for "this is my word, not theirs" (see markup.tsx),
  // so the field puts them on for you — and stays out of the way when you are
  // doing an ordinary replace by turning it off.
  const [wrap, setWrap] = useState(true);
  const replText = wrap && repl.trim() && !/^\[.*\]$/.test(repl.trim()) ? `[${repl.trim()}]` : repl;

  const { open, query, scope } = search;
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  // opening replace puts the caret where the next thing to type goes; closing
  // it hands the caret back to the query rather than dropping it on <body>
  useEffect(() => {
    if (repOpen) replRef.current?.focus();
    else if (document.activeElement === document.body) inputRef.current?.focus();
  }, [repOpen]);

  // "This tab": flat, ordered list of every occurrence
  const tabMatches = useMemo(() => {
    if (scope !== "tab" || !query) return [] as { line: number; occ: number }[];
    const t = transcripts[active];
    if (!t) return [];
    const out: { line: number; occ: number }[] = [];
    for (const l of t.lines) {
      const n = findMatches(l.text, query).length;
      for (let o = 0; o < n; o++) out.push({ line: l.id, occ: o });
    }
    return out;
  }, [transcripts, active, query, scope]);

  // Back to the first hit when the QUERY changes — not when the match list
  // merely re-derives. It re-derives on every replace (the transcript changed),
  // and resetting there sent the cursor back to hit one: Replace pressed twice
  // rewrote the top of the transcript instead of walking down it, and a
  // replacement containing the query ("system" → "[system A]") rewrote its own
  // output forever.
  useEffect(() => { setIdx(0); }, [query, scope, active]);
  // the list shrinks under the cursor as occurrences are replaced away
  const at = tabMatches.length ? Math.min(idx, tabMatches.length - 1) : 0;
  useEffect(() => {
    const cur = tabMatches[at];
    setSearch({ current: cur ?? null });
    if (cur) scrollToLine(cur.line);
  }, [tabMatches, at, setSearch, scrollToLine]);

  // "All": every loaded transcript, grouped by participant
  const allResults = useMemo(() => {
    if (scope !== "all" || !query) return [] as { pid: string; hits: { line: number; text: string; count: number }[]; total: number }[];
    const groups = [];
    for (const [pid, t] of Object.entries(transcripts)) {
      const hits = [];
      for (const l of t.lines) {
        const c = findMatches(l.text, query).length;
        if (c) hits.push({ line: l.id, text: l.text, count: c });
      }
      if (hits.length) groups.push({ pid, hits, total: hits.reduce((a, h) => a + h.count, 0) });
    }
    return groups;
  }, [transcripts, query, scope]);
  const allTotal = allResults.reduce((a, g) => a + g.total, 0);

  if (!open) return null;
  const step = (d: number) => { if (tabMatches.length) setIdx((at + d + tabMatches.length) % tabMatches.length); };
  // Replace the occurrence you are looking at, then stand on the next one.
  // The cursor does NOT move when the list re-counts: the replaced occurrence
  // leaves the list, so the same index is already the next match — except when
  // the replacement text CONTAINS the query ("system" → "[system A]"), which
  // puts new matches in its own place. Step past those, or Replace would sit
  // there rewriting its own output forever.
  const replaceOne = () => {
    const cur = tabMatches[at];
    const t = transcripts[active];
    const line = cur && t?.lines.find((l) => l.id === cur.line);
    // !repl.trim(): the Replace button disables on an empty replacement, but
    // Enter in the field reaches here directly — without the same guard it
    // would replace the occurrence with nothing, i.e. silently DELETE it
    if (!line || !query || !repl.trim()) return;
    const next = replaceOccurrence(line.text, query, cur.occ, replText);
    if (next === line.text) { // it already reads that way — say so, don't claim an edit
      announce("Already written that way — moved on");
      step(1);
      return;
    }
    editLine(active, line.id, next);
    // the replacement can CONTAIN the query ("system" → "[system A]"): those
    // new occurrences take the replaced one's place in the list, so step past
    // them or Replace would sit here rewriting its own output
    const self = findMatches(replText, query).length;
    const left = tabMatches.length - 1 + self;
    if (self) setIdx(Math.min(at + self, Math.max(0, left - 1)));
    // replacing the LAST occurrence disables the pressed button, and the
    // browser drops focus from a disabled button onto <body> — park it on the
    // field first, so the keyboard flow survives the list emptying
    if (!left) replRef.current?.focus();
    announce(`Replaced. ${left} left in this transcript`);
  };
  const replaceEvery = () => {
    // the same two guards Replace keeps: no query, and never a sweep that
    // replaces every occurrence with nothing
    if (!query || !repl.trim()) return;
    // the replacement containing the query would otherwise be rewritten by its
    // own sweep — one pass over the ORIGINAL text is what the store does, so
    // this is safe, but say the count plainly
    const n = replaceInTranscript(active, query, replText);
    // same focus rescue as replaceOne: the sweep usually empties the list
    if (n) replRef.current?.focus();
    announce(n ? `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${active}` : "Nothing to replace");
  };
  // closing unmounts the focused input and focus falls to <body> — hand it back to
  // the transcript list so the arrow-key flow it advertises still works
  const close = () => {
    // the bar renders null while closed but stays MOUNTED, so a half-typed
    // replacement would be waiting the next time it opens — against something
    // the researcher may by then have searched for a different reason
    setRepOpen(false); setRepl("");
    closeSearch();
    document.querySelector<HTMLElement>(".tviewlist")?.focus();
  };

  return (
    <div className="searchbar">
      <div className="searchrow">
        <div className="searchmain">
          <input ref={inputRef} className="searchinput" value={query} placeholder="Find in transcript…"
            aria-label="Find in transcript"
            onChange={(e) => setSearch({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); close(); }
            }} />
          {/* role=status: the match position announces as you type/step */}
          <span className="searchcount" role="status">
            {scope === "tab"
              ? (query ? `${tabMatches.length ? at + 1 : 0}/${tabMatches.length}` : "")
              : (query ? `${allTotal}` : "")}
          </span>
          {scope === "tab" && <>
            <button className="btn iconbtn" onClick={() => step(-1)} disabled={!tabMatches.length} title="Previous (Shift+Enter)">
              <Icon name="chevron-up" size={16} />
            </button>
            <button className="btn iconbtn" onClick={() => step(1)} disabled={!tabMatches.length} title="Next (Enter)">
              <Icon name="chevron-down" size={16} />
            </button>
          </>}
          {scope === "tab" && (
            <button className="btn iconbtn" aria-expanded={repOpen} aria-controls="searchReplaceRow"
              onClick={() => setRepOpen((v) => !v)}
              title={repOpen ? "Hide replace" : "Replace what you find"}
              aria-label={repOpen ? "Hide replace" : "Replace what you find"}>
              <Icon name="pencil" size={16} />
            </button>
          )}
          <div className="segmented searchscope">
            <button className={"seg" + (scope === "tab" ? " on" : "")} aria-pressed={scope === "tab"}
              onClick={() => setSearch({ scope: "tab", current: null })}>This tab</button>
            <button className={"seg" + (scope === "all" ? " on" : "")} aria-pressed={scope === "all"}
              onClick={() => setSearch({ scope: "all", current: null })}>All</button>
          </div>
        </div>
        <button className="searchclose" onClick={close} title="Close (Esc)"><Icon name="x" size={16} /></button>
      </div>

      {repOpen && scope === "tab" && (
        // One occurrence at a time, reviewed — "first system" is sometimes the
        // system and sometimes the phrase, and only the researcher reading the
        // line can tell. Replace all is there for when they have seen enough.
        <div className="searchrow searchrep" id="searchReplaceRow">
          <div className="searchmain">
            <input ref={replRef} className="searchinput" value={repl} placeholder={wrap ? "Beacon" : "Replace with…"}
              aria-label={wrap ? "Replace with, wrapped in square brackets" : "Replace with"}
              onChange={(e) => setRepl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
                else if (e.key === "Escape") { e.preventDefault(); close(); }
              }} />
            <button className={"btn iconbtn brackets" + (wrap ? " on" : "")} aria-pressed={wrap}
              aria-label="Wrap the replacement in square brackets"
              onClick={() => setWrap((v) => !v)}
              title={wrap
                ? "Writing it in as [a substitution] — your word, not the participant's. Click to insert it plain."
                : "Inserting the text as typed. Click to wrap it in square brackets."}>
              [&thinsp;]
            </button>
            <button className="btn" onClick={replaceOne} disabled={!tabMatches.length || !repl.trim()}
              title="Replace this one and move to the next (Enter)">Replace</button>
            <button className="btn" onClick={() => step(1)} disabled={!tabMatches.length}
              title="Leave this one as it is and move to the next">Skip</button>
            <button className="btn" onClick={replaceEvery} disabled={!tabMatches.length || !repl.trim()}
              title={`Replace every occurrence in ${active} — one undo takes it all back`}>All</button>
          </div>
        </div>
      )}

      {scope === "all" && query && (
        <div className="searchresults nicescroll">
          {allResults.length === 0
            ? <div className="empty">No matches.</div>
            : allResults.map((g) => (
              <div key={g.pid} className="searchgroup">
                <div className="searchgrouphead">{g.pid} <span className="cnt">{g.total}</span></div>
                {g.hits.map((h) => (
                  // focusable like the Browse rows: Tab reaches a hit, Enter/Space jumps
                  <div key={h.line} className="searchhit" role="button" tabIndex={0}
                    onClick={() => jumpTo(g.pid, h.line)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jumpTo(g.pid, h.line); }
                    }}>
                    <span className="searchlid">{h.line}</span>
                    <span className="searchtext">{highlight(h.text, query)}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
