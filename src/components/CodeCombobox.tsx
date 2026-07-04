import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { norm } from "../contract/segments";

// subsequence fuzzy match: "vs" matches "visual strain"
const fuzzy = (q: string, t: string) => {
  q = q.toLowerCase(); t = t.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
};

// Shared code input with fuzzy autocomplete. Used in the sidebar (persistent)
// and the command palette (autoFocus + onClose). Applies to the current
// selection; if none, just creates the code.
export function CodeCombobox({ autoFocus, placeholder = "+ new code", onClose }: {
  autoFocus?: boolean; placeholder?: string; onClose?: () => void;
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
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    segments.filter((s) => s.status === "accepted").forEach((s) => { m[s.code] = (m[s.code] || 0) + 1; });
    return m;
  }, [segments]);

  const query = draft.trim();
  const matches = query
    ? Object.keys(codebook).filter((c) => fuzzy(query, c)).sort((a, b) => {
        const ql = query.toLowerCase();
        const rank = (x: string) => (x.toLowerCase().startsWith(ql) ? 0 : x.toLowerCase().includes(ql) ? 1 : 2);
        return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b);
      })
    : [];
  const exact = Object.keys(codebook).some((c) => norm(c) === norm(query));
  const entries = [
    ...matches.map((c) => ({ type: "code" as const, name: c })),
    ...(query && !exact ? [{ type: "create" as const, name: query }] : []),
  ];
  const showList = open && entries.length > 0;

  const choose = (en: { type: "code" | "create"; name: string }) => {
    if (en.type === "create") { const c = ensureCode(en.name); if (hasSel) applyCode(c); }
    else if (hasSel) applyCode(en.name);
    setDraft(""); setHl(0);
    onClose?.();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, entries.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const en = entries[Math.min(hl, entries.length - 1)]; if (en) choose(en); }
    else if (e.key === "Escape") { if (onClose) onClose(); else if (showList) setOpen(false); else e.currentTarget.blur(); }
  };

  return (
    <div className="newCodeWrap">
      <input ref={ref} className="newCode" value={draft} placeholder={placeholder} autoComplete="off"
        onChange={(e) => { setDraft(e.target.value); setOpen(true); setHl(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!onClose) setOpen(false); }}
        onKeyDown={onKey} />
      {showList && (
        <div className="acList nicescroll">
          {entries.map((en, i) => (
            <div key={en.type + en.name} className={"acItem" + (i === hl ? " hl" : "")}
              onMouseDown={(e) => { e.preventDefault(); choose(en); }}
              onMouseEnter={() => setHl(i)}>
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
