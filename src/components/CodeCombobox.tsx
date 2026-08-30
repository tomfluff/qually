// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore, liveCodes } from "../state/store";
import { earcon } from "../earcons";
import { norm } from "../contract/segments";

// subsequence fuzzy match: "vs" matches "visual strain"
// (exported: the add-event type combobox matches the same way)
export const fuzzy = (q: string, t: string) => {
  q = q.toLowerCase(); t = t.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
};

// Shared code input with fuzzy autocomplete. Used in the sidebar (persistent),
// the command palette (autoFocus + onClose), and the noticings panel (onPick).
// Default behavior applies to the current selection (or just creates the code);
// onPick overrides that and receives the chosen/created code instead.
export function CodeCombobox({ autoFocus, placeholder = "+ new code", onClose, onPick,
  exclude, allowCreate = true, suggest }: {
  autoFocus?: boolean; placeholder?: string; onClose?: () => void; onPick?: (code: string) => void;
  /** a code this picker must never offer — you cannot fold a code into itself */
  exclude?: string;
  /** false where creating one would be the wrong act entirely: folding into a
      code that does not exist is a rename, not a fold */
  allowCreate?: boolean;
  /** what to offer before anything is typed. The sidebar has nothing useful to
      say there (every code, in no order, is noise), but a caller that has
      RANKED the codebook for this moment does — the thin tail knows which codes
      the one you are reading most resembles, and that list is the answer most
      of the time. */
  suggest?: string[];
}) {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const hasSel = useStore((s) => s.selection.lines.size > 0);
  const ensureCode = useStore((s) => s.ensureCode);
  const applyCode = useStore((s) => s.applyCode);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(!!autoFocus);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId(); // two instances coexist (sidebar + palette); ids must not collide
  const lastPt = useRef({ x: -1, y: -1 });
  const wantScroll = useRef(false); // only keyboard nav scrolls the list, not hover
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    if (!wantScroll.current) return;
    wantScroll.current = false;
    (listRef.current?.children[hl] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    segments.filter((s) => s.status === "accepted").forEach((s) => { m[s.code] = (m[s.code] || 0) + 1; });
    return m;
  }, [segments]);

  const query = draft.trim();
  const usable = (list: string[]) => (exclude ? list.filter((c) => c !== exclude) : list);
  const matches = query
    // a parked code cannot be applied — that is what setting it aside means
    ? usable(liveCodes(codebook).filter((c) => fuzzy(query, c))).sort((a, b) => {
        const ql = query.toLowerCase();
        const rank = (x: string) => (x.toLowerCase().startsWith(ql) ? 0 : x.toLowerCase().includes(ql) ? 1 : 2);
        return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b);
      })
    // the caller's own ranking, kept in ITS order — it knows why those codes
    : usable(suggest ?? []);
  // …but it still BLOCKS a new code of the same name, or coding would
  // silently create a second code the book already has, parked
  const exact = Object.keys(codebook).some((c) => norm(c) === norm(query));
  const entries = [
    ...matches.map((c) => ({ type: "code" as const, name: c })),
    ...(allowCreate && query && !exact ? [{ type: "create" as const, name: query }] : []),
  ];
  const showList = open && entries.length > 0;

  const choose = (en: { type: "code" | "create"; name: string }) => {
    const code = en.type === "create" ? ensureCode(en.name) : en.name;
    if (onPick) onPick(code);
    else if (hasSel) applyCode(code); // applyCode sounds its own mark
    else if (en.type === "create") earcon.code(); // a bare new code is still an act
    setDraft(""); setHl(0);
    onClose?.();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // an IME's confirm-Enter is not a pick
    if (e.key === "ArrowDown") { e.preventDefault(); wantScroll.current = true; setHl((h) => Math.min(h + 1, entries.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); wantScroll.current = true; setHl((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const en = entries[Math.min(hl, entries.length - 1)]; if (en) choose(en); }
    else if (e.key === "Escape") { if (onClose) onClose(); else if (showList) setOpen(false); else e.currentTarget.blur(); }
  };

  return (
    <div className="newCodeWrap">
      <input ref={ref} className="newCode" value={draft} placeholder={placeholder} autoComplete="off"
        role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        aria-label={placeholder} aria-activedescendant={showList ? `${listId}-${hl}` : undefined}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); setHl(0); wantScroll.current = true; }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!onClose) setOpen(false); }}
        onKeyDown={onKey} />
      {showList && (
        <div className="acList nicescroll" ref={listRef} role="listbox" id={listId}>
          {entries.map((en, i) => (
            <div key={en.type + en.name} className={"acItem" + (i === hl ? " hl" : "")}
              role="option" id={`${listId}-${i}`} aria-selected={i === hl}
              onMouseDown={(e) => { e.preventDefault(); choose(en); }}
              onMouseMove={(e) => {
                // only real cursor movement changes the highlight (scroll fires enter/move at same coords)
                if (e.clientX === lastPt.current.x && e.clientY === lastPt.current.y) return;
                lastPt.current = { x: e.clientX, y: e.clientY };
                setHl(i);
              }}>
              {en.type === "code" ? (
                <>
                  <span className="swatch" style={{ background: codebook[en.name].color }} />
                  <span className="acName">{en.name}</span>
                  <span className="cnt">{counts[en.name] || 0}</span>
                </>
              ) : (
                <span className="acCreate">Create “{en.name}”</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
