import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

const KEYS: [string, string][] = [
  ["Click / drag", "Select a line, or drag to select a range"],
  ["Shift-click / Ctrl-click", "Extend the range / toggle individual lines"],
  ["↑ ↓", "Move selection to the next/previous line"],
  ["Shift + ↑ ↓", "Extend the selection"],
  ["PageUp / PageDn", "Scroll the transcript by about a screen"],
  ["Home / End", "Jump to the first / last line of the transcript"],
  ["1 – 9", "Apply the matching hotbar code to the selection"],
  ["0", "Open the code palette (fuzzy search or create a code)"],
  ["Double-click a line", "Fix its transcription in place; Enter saves, Esc cancels"],
  ["Ctrl + C", "Copy the selected lines (speaker-grouped)"],
  ["Ctrl + Z  /  Ctrl + Shift + Z", "Undo / redo"],
  ["Ctrl + F", "Search the transcript (This tab / All); Enter / Shift+Enter step matches"],
  ["Esc", "Clear selection · close a popover · exit search or zen"],
];

export function AboutButton() {
  const helpSeen = useStore((s) => s.ui.helpSeen);
  const setUi = useStore((s) => s.setUi);
  const [open, setOpen] = useState(false);

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
      <button className="helpbtn" title="Help & shortcuts" onClick={() => setOpen(true)}>?</button>
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
              Nothing is uploaded unless you add your own OpenAI key and approve each request.
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
              </section>

              <section>
                <h3>Coding</h3>
                <ul>
                  <li><b>Apply a code:</b> press <b>1–9</b> for the hotbar, <b>0</b> for the fuzzy code palette, or click a code in the sidebar.</li>
                  <li><b>Edit a segment:</b> click its colored lane bar (notes, reject, delete, copy) or drag its top/bottom edge to resize. Hover a bar to see its line range.</li>
                  <li><b>Manage codes:</b> right-click a code (sidebar or Browse) to rename, edit its definition, recolor, merge, pin, or delete.</li>
                  <li><b>Fix transcription:</b> double-click a line to correct it in place — with media loaded, the utterance loops at 0.75× while you type. The original is kept (✱ marks edited lines, hover to see it) and every correction exports via the toolbar's <b>Edit log</b> button.</li>
                  <li><b>AI (optional, off by default):</b> add your own OpenAI key in Settings and <b>AI scan</b> can flag likely mis-transcriptions (amber, dotted — double-click to fix) and, if you tick them, highlight instances for your review: emotional expressions, likes/dislikes, desires, workarounds, tensions, quotable phrasing — each mapped to a first-cycle coding method. It marks instances only; coding stays yours. Choose which speakers to include, see the exact lines before they're sent (listed names redacted first), Alt-click a highlight to dismiss it, hide them all with the eye button to read blind, and every request is logged for your methods appendix.</li>
                  <li><b>Mixed-speaker flag:</b> a small <b>!</b> badge on a segment's corner means its excerpt keeps only the dominant speaker — the other speaker's words may drop out, so double-check it.</li>
                  <li><b>Browse tab:</b> pick codes on the left, read their excerpts on the right; click a ref to jump to it. Turn on <b>Show rejected</b> to include rejected segments. After an AI scan, a <b>Noticings</b> switch appears: the AI's marks side by side across participants, filterable to what you haven't coded yet — <b>code…</b> writes a segment for that line (authored by you), <b>open</b> jumps to it, <b>dismiss</b> removes it.</li>
                  <li><b>Re-importing a transcript:</b> if you fix the CSV and import it again, the app matches the new lines against the old ones and re-anchors your codes, showing you what carries over before it changes anything. You can also keep both copies instead.</li>
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
                  <li><b>Minimap</b> (right edge): a zoomed-out map of the transcript — code density in the lanes, a faint view of the text lines, and amber ticks for near-balanced segments. Click or drag to navigate.</li>
                  <li><b>Video dock</b> (bottom-right): click a timecode chip to play from that moment; collapse for audio-only.</li>
                  <li><b>Settings:</b> zen mode, theme &amp; primary color, text sizes, line numbers, short/full speaker names, merge partial lines, lane width, warning-badge size, and hotbar &amp; command-palette position.</li>
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
