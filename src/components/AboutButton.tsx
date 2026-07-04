import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

const KEYS: [string, string][] = [
  ["Click / drag", "Select a line, or drag to select a range"],
  ["Shift-click / Ctrl-click", "Extend the range / toggle individual lines"],
  ["↑ ↓", "Move selection to the next/previous line"],
  ["Shift + ↑ ↓", "Extend the selection"],
  ["1 – 9", "Apply the matching hotbar code to the selection"],
  ["0", "Open the code palette (fuzzy search or create a code)"],
  ["Ctrl + C", "Copy the selected lines (speaker-grouped)"],
  ["Ctrl + Z  /  Ctrl + Shift + Z", "Undo / redo"],
  ["Ctrl + F", "Search the transcript (This tab / All); Enter / Shift+Enter step matches"],
  ["Esc", "Clear selection · close a popover · exit search or zen"],
];

export function AboutButton() {
  const helpSeen = useStore((s) => s.ui.helpSeen);
  const setUi = useStore((s) => s.setUi);
  const importFiles = useStore((s) => s.importFiles);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // auto-open once, on the first ever launch
  useEffect(() => { if (!helpSeen) setOpen(true); }, [helpSeen]);

  const close = () => { setOpen(false); if (!helpSeen) setUi({ helpSeen: true }); };

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  });

  return (
    <>
      <button className="btn iconbtn" title="Help & shortcuts" onClick={() => setOpen(true)}>
        <Icon name="help" size={17} />
      </button>
      {open && (
        <div className="about-backdrop" onMouseDown={close}>
          <div className="about" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2>Coding App</h2>
              <button className="btn iconbtn" onClick={close} title="Close (Esc)"><Icon name="x" size={16} /></button>
            </div>
            <p className="about-lede">
              Code interview and session transcripts offline. Everything stays in your browser
              (autosaved locally); export a merged <code>coded-segments.csv</code> when you're done.
            </p>

            <div className="about-body nicescroll">
              <section>
                <h3>Get started</h3>
                <ol>
                  <li><b>Import</b> a transcript CSV — columns <code>line_id, timestamp, speaker, text</code>
                    (an optional <code>codes</code> column is loaded as segments). Optionally add a video/audio file to sync playback.</li>
                  <li><b>Select</b> lines and <b>apply codes</b> (below).</li>
                  <li><b>Export</b> the coded segments when done.</li>
                </ol>
                <button className="btn about-import" onClick={() => fileRef.current?.click()}>Import a transcript…</button>
                <input ref={fileRef} type="file" multiple accept=".csv" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files; if (f?.length) { importFiles(f); close(); } e.target.value = ""; }} />
              </section>

              <section>
                <h3>Coding</h3>
                <ul>
                  <li><b>Apply a code:</b> press <b>1–9</b> for the hotbar, <b>0</b> for the fuzzy code palette, or click a code in the sidebar.</li>
                  <li><b>Edit a segment:</b> click its colored lane bar (notes, reject, delete, copy) or drag its top/bottom edge to resize. Hover a bar to see its line range.</li>
                  <li><b>Manage codes:</b> right-click a code (sidebar or Browse) to rename, edit its definition, recolor, merge, pin, or delete.</li>
                  <li><b>Browse tab:</b> pick codes on the left, read their excerpts on the right; click a ref to jump to it.</li>
                </ul>
              </section>

              <section>
                <h3>Keyboard shortcuts</h3>
                <table className="about-keys">
                  <tbody>
                    {KEYS.map(([k, v]) => (
                      <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section>
                <h3>Also</h3>
                <ul>
                  <li><b>Video dock</b> (bottom-right): click a timecode chip to play from that moment; collapse for audio-only.</li>
                  <li><b>Settings</b> (gear): text sizes, hotbar mode, theme, and zen mode.</li>
                  <li>Drag the panel dividers to resize; drag lane bars past 5 and the text reflows.</li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
