import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { PALETTES } from "../palettes";

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
  const palettePos = useStore((s) => s.ui.palettePos);
  const accent = useStore((s) => s.ui.accent);
  const speakerNames = useStore((s) => s.ui.speakerNames);
  const warnSize = useStore((s) => s.ui.warnSize);
  const laneWidth = useStore((s) => s.ui.laneWidth);
  const mergeLines = useStore((s) => s.ui.mergeLines);
  const showLineNumbers = useStore((s) => s.ui.showLineNumbers);
  const setUi = useStore((s) => s.setUi);
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
        <div className="settings-pop nicescroll">
          <div className="settings-title">Settings</div>

          <div className="settings-sub">Appearance</div>
          <div className="srow">
            <span>Theme</span>
            <div className="seg">
              <button className={!dark ? "on" : ""} onClick={() => { if (dark) toggleTheme(); }}>light</button>
              <button className={dark ? "on" : ""} onClick={() => { if (!dark) toggleTheme(); }}>dark</button>
            </div>
          </div>
          <div className="srow">
            <span>Primary</span>
            <div className="swatches">
              {PALETTES.map((p) => (
                <button key={p.id} className={"swatchbtn" + (accent === p.id ? " on" : "")}
                  style={{ background: dark ? p.dark : p.light }}
                  title={p.name} aria-label={p.name} onClick={() => setUi({ accent: p.id })} />
              ))}
            </div>
          </div>

          <div className="settings-sub">Text size</div>
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

          <div className="settings-sub">Transcript</div>
          <div className="srow">
            <span>Line numbers</span>
            <div className="seg">
              <button className={!showLineNumbers ? "on" : ""} onClick={() => setUi({ showLineNumbers: false })}>off</button>
              <button className={showLineNumbers ? "on" : ""} onClick={() => setUi({ showLineNumbers: true })}>on</button>
            </div>
          </div>
          <div className="srow">
            <span>Speakers</span>
            <div className="seg">
              <button className={speakerNames === "full" ? "on" : ""} onClick={() => setUi({ speakerNames: "full" })}>full</button>
              <button className={speakerNames === "short" ? "on" : ""} onClick={() => setUi({ speakerNames: "short" })}>short</button>
            </div>
          </div>
          <div className="settings-note">Short shows the first 3 characters (hover for the full name).</div>
          <div className="srow">
            <span>Merge lines</span>
            <div className="seg">
              <button className={!mergeLines ? "on" : ""} onClick={() => setUi({ mergeLines: false })}>off</button>
              <button className={mergeLines ? "on" : ""} onClick={() => setUi({ mergeLines: true })}>on</button>
            </div>
          </div>
          <div className="settings-note">Joins consecutive same-speaker lines that don't end in . ? ! … into one unit.</div>

          <div className="settings-sub">Coding</div>
          <div className="srow">
            <span>Hotbar</span>
            <div className="seg">
              <button className={mode === "auto" ? "on" : ""} onClick={() => setHotbarMode("auto")}>auto</button>
              <button className={mode === "pinned" ? "on" : ""} onClick={() => setHotbarMode("pinned")}>pinned</button>
            </div>
          </div>
          <div className="srow">
            <span>Cmd palette</span>
            <div className="seg">
              <button className={palettePos === "auto" ? "on" : ""} onClick={() => setUi({ palettePos: "auto" })}>near</button>
              <button className={palettePos === "centered" ? "on" : ""} onClick={() => setUi({ palettePos: "centered" })}>center</button>
            </div>
          </div>
          <div className="srow">
            <span>Lane width</span>
            <div className="seg">
              {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                <button key={sz} className={laneWidth === sz ? "on" : ""} onClick={() => setUi({ laneWidth: sz })}>{sz}</button>
              ))}
            </div>
          </div>
          <div className="srow">
            <span>Warning size</span>
            <div className="seg">
              {(["xs", "sm", "md", "lg"] as const).map((sz) => (
                <button key={sz} className={warnSize === sz ? "on" : ""} onClick={() => setUi({ warnSize: sz })}>{sz}</button>
              ))}
            </div>
          </div>
          <div className="settings-note">The near-balanced (⚠) marker on coded segments.</div>

          <div className="settings-div" />
          <button className="btn zenbtn" onClick={() => { setZen(true); setOpen(false); }}>Enter zen mode</button>
          <div className="settings-note">Hides the toolbar and panels. Press Esc to exit.</div>
        </div>
      )}
    </div>
  );
}
