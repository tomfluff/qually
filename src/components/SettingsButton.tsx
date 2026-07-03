import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

// Settings popover: instant-apply controls (no save button), all persisted via ui autosave.
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fontSize = useStore((s) => s.ui.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const sidebarFontSize = useStore((s) => s.ui.sidebarFontSize);
  const setSidebarFontSize = useStore((s) => s.setSidebarFontSize);
  const mode = useStore((s) => s.hotbar.mode);
  const setHotbarMode = useStore((s) => s.setHotbarMode);
  const dark = useStore((s) => s.ui.dark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setZen = useStore((s) => s.setZen);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div className="settings-wrap" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>Settings</button>
      {open && (
        <div className="settings-pop">
          <div className="settings-title">Settings</div>
          <label className="srow">
            <span>Transcript</span>
            <input type="range" min={12} max={30} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} />
            <span className="sval">{fontSize}</span>
          </label>
          <label className="srow">
            <span>Sidebar</span>
            <input type="range" min={10} max={30} value={sidebarFontSize} onChange={(e) => setSidebarFontSize(+e.target.value)} />
            <span className="sval">{sidebarFontSize}</span>
          </label>
          <div className="srow">
            <span>Hotbar</span>
            <div className="seg">
              <button className={mode === "auto" ? "on" : ""} onClick={() => setHotbarMode("auto")}>auto</button>
              <button className={mode === "pinned" ? "on" : ""} onClick={() => setHotbarMode("pinned")}>pinned</button>
            </div>
          </div>
          <div className="srow">
            <span>Theme</span>
            <div className="seg">
              <button className={!dark ? "on" : ""} onClick={() => { if (dark) toggleTheme(); }}>light</button>
              <button className={dark ? "on" : ""} onClick={() => { if (!dark) toggleTheme(); }}>dark</button>
            </div>
          </div>
          <div className="settings-div" />
          <button className="btn zenbtn" onClick={() => { setZen(true); setOpen(false); }}>Enter zen mode</button>
          <div className="settings-note">Hides the toolbar and panels. Press Esc to exit.</div>
        </div>
      )}
    </div>
  );
}
