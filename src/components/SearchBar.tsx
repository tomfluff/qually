import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../state/store";
import { findMatches } from "../search";
import { Icon } from "./Icon";

// render text with all query matches wrapped in <mark>
function highlight(text: string, query: string): ReactNode {
  const m = findMatches(text, query);
  if (!m.length) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  m.forEach(([s, e], k) => {
    if (s > last) nodes.push(text.slice(last, s));
    nodes.push(<mark key={k}>{text.slice(s, e)}</mark>);
    last = e;
  });
  if (last < text.length) nodes.push(text.slice(last));
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [idx, setIdx] = useState(0);

  const { open, query, scope } = search;
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

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

  useEffect(() => { setIdx(0); }, [tabMatches]);
  useEffect(() => {
    const cur = tabMatches[idx];
    setSearch({ current: cur ?? null });
    if (cur) scrollToLine(cur.line);
  }, [tabMatches, idx, setSearch, scrollToLine]);

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
  const step = (d: number) => { if (tabMatches.length) setIdx((i) => (i + d + tabMatches.length) % tabMatches.length); };

  return (
    <div className="searchbar">
      <div className="searchrow">
        <input ref={inputRef} className="searchinput" value={query} placeholder="Find in transcript…"
          onChange={(e) => setSearch({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
          }} />
        <span className="searchcount">
          {scope === "tab"
            ? (query ? `${tabMatches.length ? idx + 1 : 0}/${tabMatches.length}` : "")
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
        <div className="seg searchscope">
          <button className={scope === "tab" ? "on" : ""} onClick={() => setSearch({ scope: "tab", current: null })}>This tab</button>
          <button className={scope === "all" ? "on" : ""} onClick={() => setSearch({ scope: "all", current: null })}>All</button>
        </div>
        <button className="btn iconbtn" onClick={closeSearch} title="Close (Esc)"><Icon name="x" size={16} /></button>
      </div>

      {scope === "all" && query && (
        <div className="searchresults nicescroll">
          {allResults.length === 0
            ? <div className="empty">No matches.</div>
            : allResults.map((g) => (
              <div key={g.pid} className="searchgroup">
                <div className="searchgrouphead">{g.pid} <span className="cnt">{g.total}</span></div>
                {g.hits.map((h) => (
                  <div key={h.line} className="searchhit" onClick={() => jumpTo(g.pid, h.line)}>
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
