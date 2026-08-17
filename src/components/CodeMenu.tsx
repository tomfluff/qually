// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { norm } from "../contract/segments";
import { Icon } from "./Icon";
import { openColorPicker } from "../colorPicker";
import { openDefine } from "./CodeDef";
import { useDismiss, useClampToViewport } from "../usePopover";

export function CodeMenu({ code, x, y, onClose }: {
  code: string; x: number; y: number; onClose: () => void;
}) {
  // select stable references only; derive arrays in render (fresh-array selectors loop React)
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const isPinned = useStore((s) => s.hotbar.pinned.includes(code));
  // pinning only steers the hotbar in "pinned" mode; in auto (by usage) it's inert
  const hotbarMode = useStore((s) => s.hotbar.mode);
  const segCount = segments.filter((z) => norm(z.code) === norm(code)).length;
  const others = Object.keys(codebook).filter((c) => c !== code).sort();
  const renameCode = useStore((s) => s.renameCode);
  const deleteCode = useStore((s) => s.deleteCode);
  const mergeCode = useStore((s) => s.mergeCode);
  const setColor = useStore((s) => s.setColor);
  const togglePin = useStore((s) => s.togglePin);
  // menu text follows the sidebar text-size setting, like SegmentPopover
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"menu" | "rename" | "merge">("menu");

  // Keyboard route: focus lands on the first item on open, returns to the opener
  // on close — unless the action DESTROYED the opener. Rename and Delete
  // re-render a list whose rows are keyed by code name, so the button that
  // opened this menu is gone by the time the cleanup runs, and focus()ing a
  // detached node is a silent no-op that drops the caret to <body>. Fall back to
  // the list the row lived in, so the user stays where they were working.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const home = opener?.closest<HTMLElement>(".cbList, .cbSide, .sideList, [role=listbox]") ?? null;
    ref.current?.querySelector("button")?.focus();
    return () => {
      if (opener?.isConnected) { opener.focus(); return; }
      if (!home) return;
      home.tabIndex = -1; // a scroll container isn't focusable on its own
      home.focus();
    };
  }, []);

  // Escape peels one layer (a sub-form goes back to the menu); an outside click
  // closes outright whatever the mode
  const back = useCallback(() => { mode === "menu" ? onClose() : setMode("menu"); }, [mode, onClose]);
  useDismiss(ref, onClose, { onEscape: back });
  // measure, don't guess: the old hardcoded 280px clamp was shorter than the real
  // menu (worse at a big sidebar font), so opening from the hotbar clipped the
  // bottom items off. Re-runs per mode — the forms are a different height.
  useClampToViewport(ref, [mode, x, y, sidebarFontSize]);

  // anchor at the menu's own position (the code row), not the menu item — the
  // menu is gone by the time the popover shows
  const pickColor = () => {
    openColorPicker(codebook[code]?.color || "#888888", (v) => setColor(code, v), { x, y });
    onClose();
  };

  // ArrowUp/Down walk the visible items (Enter is the buttons' own click); text fields keep their arrows
  const onArrows = (e: React.KeyboardEvent) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || (e.target as HTMLElement).matches("input, textarea")) return;
    e.preventDefault();
    // skip disabled items: focus() on one is a silent no-op, and the walk would stick
    const items = Array.from(ref.current?.querySelectorAll("button") ?? []).filter((b) => !b.disabled);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length].focus();
  };

  return (
    // dialog, not menu: two of its modes are text-input forms
    <div className="ctxmenu" ref={ref} onKeyDown={onArrows}
      role="dialog" aria-label={`Options for code ${code}`}
      style={{ left: x, top: y, fontSize: sidebarFontSize }}>
      {mode === "menu" && (
        <>
          <div className="ctxhead">{code}</div>
          <button onClick={() => setMode("rename")}><Icon name="pencil" size={15} />Rename</button>
          {/* the same editor the Codebook uses, in a thin dialog: a definition
              runs to a paragraph and a menu row can only show three lines of it */}
          <button onClick={() => { openDefine(code); onClose(); }}><Icon name="text" size={15} />Edit definition</button>
          <button onClick={pickColor}><Icon name="droplet" size={15} />Change color</button>
          {/* aria-disabled, not disabled: a disabled button is unfocusable, so the
              why-is-this-off hint was mouse-only. This stays in the arrow walk and
              announces as disabled; data-tip shows the hint on hover AND focus. */}
          <button aria-disabled={hotbarMode !== "pinned"}
            onClick={() => { if (hotbarMode !== "pinned") return; togglePin(code); onClose(); }}
            data-tip={hotbarMode !== "pinned" ? "The hotbar is in auto (by usage) mode — switch it to pinned in Settings first" : undefined}>
            <Icon name="pin" size={15} />{isPinned ? "Unpin from hotbar" : "Pin to hotbar"}
          </button>
          {others.length > 0 && <button onClick={() => setMode("merge")}><Icon name="merge" size={15} />Merge into</button>}
          <div className="ctxdiv" />
          <button className="danger" onClick={() => { deleteCode(code); onClose(); }}>
            <Icon name="trash" size={15} />Delete{segCount > 0 ? ` (and ${segCount} segment${segCount > 1 ? "s" : ""})` : ""}
          </button>
        </>
      )}
      {mode === "rename" && (
        <CodeForm label="Rename code" initial={code} placeholder="New name"
          onCancel={() => setMode("menu")} onSubmit={(v) => { renameCode(code, v); onClose(); }} />
      )}
      {mode === "merge" && (
        <>
          <div className="ctxhead">Merge “{code}” into…</div>
          <div className="ctxlist">
            {others.map((o) => (
              <button key={o} onClick={() => { mergeCode(code, o); onClose(); }}>
                <span className="swatch" style={{ background: codebook[o].color }} />{o}
              </button>
            ))}
          </div>
          <button onClick={() => setMode("menu")}><Icon name="chevron-left" size={15} />Back</button>
        </>
      )}
    </div>
  );
}

function CodeForm({ label, initial, placeholder, multiline, onSubmit, onCancel }: {
  label: string; initial: string; placeholder: string; multiline?: boolean;
  onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // grow to fit content; CSS max-height caps it then scrolls
  const resize = () => { const el = taRef.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(() => { if (multiline) resize(); }, [multiline]);
  return (
    <div className="ctxform">
      <div className="ctxhead">{label}</div>
      {multiline ? (
        <textarea ref={taRef} autoFocus value={v} placeholder={placeholder} rows={1} aria-label={label}
          onChange={(e) => { setV(e.target.value); resize(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmit(v); if (e.key === "Escape") onCancel(); }} />
      ) : (
        <input autoFocus value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(v); if (e.key === "Escape") onCancel(); }} />
      )}
      <div className="ctxrow">
        <button className="btn" onClick={() => onSubmit(v)}>Save</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
