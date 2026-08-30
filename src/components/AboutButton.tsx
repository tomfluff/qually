// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";
import { AUTHOR_AVATAR } from "../assets/avatar";

const KEYS: [string, string][] = [
  ["Tab, then ↓", "Move focus into the transcript and select a line — no mouse needed"],
  ["Click / drag", "Select a line, or drag to select a range"],
  ["Shift-click / Ctrl-click", "Extend the range / toggle individual lines"],
  ["↑ ↓", "Move selection to the next/previous line"],
  ["Shift + ↑ ↓", "Extend the selection"],
  ["PageUp / PageDn", "Scroll the transcript by about a screen"],
  ["Home / End", "Jump to the first / last line of the transcript"],
  ["1 – 9", "Apply the matching hotbar code to the selection"],
  ["0", "Open the code palette (fuzzy search or create a code)"],
  ["Enter", "Play the loaded media from the selected line"],
  ["Space", "Play / pause the loaded media (except while typing)"],
  ["[  /  ]", "Slow down / speed up media playback"],
  ["E", "Add a session event: after the selected line, or at the playhead when nothing is selected"],
  ["N", "Project notes (Esc returns) — memos with a Stamp of what you were doing"],
  ["Ctrl + M", "In Notes: insert a context stamp at the cursor"],
  ["Ctrl + F", "In Notes: find in the document"],
  ["M", "Open the selected line's AI observation (apply fix / dismiss); again cycles them"],
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
  const dialogRef = useDialogFocus();

  // auto-open once, on the first ever launch (the name ask is a separate prompt — see
  // CoderPrompt in Toolbar — that surfaces after this closes)
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
      <button className="btn iconlabel" title="Help & shortcuts" onClick={() => setOpen(true)}>
        <Icon name="help" size={16} /> <span className="blabel">Help</span>
      </button>
      {open && (
        <div className="about-backdrop" onMouseDown={close}>
          <div className="about" ref={dialogRef} role="dialog" aria-modal="true"
            aria-labelledby="about-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="about-title">QuAlly — thematic analysis, made accessible</h2>
              <button className="btn iconbtn" onClick={close} title="Close (Esc)"><Icon name="x" size={16} /></button>
            </div>
            <p className="about-lede">
              Code interview and session transcripts offline, built so that low vision doesn't get in
              the way. Everything stays in your browser (autosaved locally); export a merged
              <code>coded-segments.csv</code> when you're done. Nothing is uploaded unless you add your
              own OpenAI key and approve each request.
            </p>

            <div className="about-body nicescroll">
              <section>
                <h3>Get started</h3>
                <ol>
                  <li><b>Reading language:</b> a transcript whose CSV carried a <code>text_en</code> column can be read in either — from the ⚙ button at its bottom right, or by right-clicking its tab. It is not display-only: what you read is what a code quotes, what an export writes and what the AI is sent, so the evidence never disagrees with the page. Lines with no translation stay as they were spoken, and the switch counts them. In the Codebook, <b>Show the original</b> puts the source back under any excerpt.</li>
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
                  <li><b>Manage codes:</b> right-click a code (sidebar or Codebook) to rename, edit its definition, recolor, merge, pin, or delete.</li>
                  <li><b>Fix transcription:</b> double-click a line to correct it in place — with media loaded, the utterance loops at 0.75× while you type. The original is kept (✱ marks edited lines, hover to see it) and every correction exports via <b>Export → Transcript edits (.csv)</b> (the item appears once you've edited a line).</li>
                  <li><b>Mixed-speaker flag:</b> a small <b>!</b> badge on a segment's corner means its excerpt keeps only the dominant speaker — the other speaker's words may drop out, so double-check it.</li>
                  <li><b>Codebook tab:</b> pick codes on the left, read their excerpts on the right; click a ref to jump to it. Where an excerpt left another speaker out, it says how many lines and whose — click that to read every speaker in the range. The sidebar holds a <b>Show rejected</b> toggle and a <b>Grounding</b> style menu (how grounded quotes are emphasised in the excerpts).</li>
                  <li><b>Assist tab:</b> one panel per kind of AI work, chosen from the tab's own menu. Each lists what is waiting for your judgement across participants and is where its run starts — the sparkle on a transcript row, or the button above the list, opens that run's consent gate.</li>
                  <li><b>Re-importing a transcript:</b> if you fix the CSV and import it again, the app matches the new lines against the old ones and re-anchors your codes, showing you what carries over before it changes anything. You can also keep both copies instead.</li>
                </ul>
              </section>

              <section>
                <h3>AI functions</h3>
                <p className="about-note">
                  All optional and <b>off by default</b>. Nothing reaches a model until you add your own
                  OpenAI key in <b>Settings → AI</b> and approve that particular run: every one opens a gate
                  showing the lines it would send, with names you listed replaced first, the number of
                  substitutions, and a cost estimate. Every request is written to the AI log — including one
                  you stopped or that failed, because the material had already left. Nothing an AI proposes
                  counts as your analysis until you accept it.
                </p>
                <ul>
                  <li><b>On one transcript</b> — from its code sidebar or the <b>Assist</b> tab.{" "}
                    <b>Scan</b> flags likely mis-transcriptions (amber, dotted — double-click to fix) and,
                    per lens you tick, marks observations for review: emotional expressions, likes and
                    dislikes, desires, workarounds, tensions, quotable phrasing.{" "}<b>Suggest codes</b>{" "}
                    proposes codings drawn only from your existing codebook. <b>Find sections</b> marks the
                    shape of the session against a study brief you write, using the labels you declare and
                    no others. <b>Summarise</b> drafts a session summary for you to edit and own.</li>
                  <li><b>On the codebook</b> — from the <b>Code map</b> or the Assist panels.{" "}
                    <b>Merge duplicates</b> and <b>Consolidate</b> find codes doing the same work,
                    <b>Find similar</b> looks for the same idea under different words,
                    <b>Group into areas</b> sorts the map, <b>Draft definitions</b> writes a definition from
                    a code's own excerpts, and <b>Ground codes</b> quotes the passage that earned each one.
                    These are the runs that may propose a <i>new name</i> for a merged or renamed code —
                    the codings and sections above never invent a label.</li>
                  <li><b>Across everything: Ask</b> — a question answered only from your codes, excerpts and
                    session events, with every claim carrying a citation you can click back to.</li>
                  <li><b>Reviewing what comes back:</b> a proposal is drawn provisionally — striped in the
                    section gutter, lighter in the lanes, ghosted with a hairline on the minimap — until you
                    accept or reject it. Rejections are remembered, so a re-run will not put the same
                    proposal back in front of you.</li>
                  <li><b>The record:</b> <b>Export → AI log (.csv)</b> is your methods appendix — model, task,
                    lines sent, substitutions, cost and outcome for every request this project has made.</li>
                </ul>
              </section>

              <section>
                <h3>Reading comfort &amp; low vision</h3>
                <ul>
                  <li><b>Make it bigger:</b> Settings scales the transcript to <b>48px</b> and the sidebar
                    to 36px, independently — so the text grows without the chrome eating the reading column.
                    Browser zoom (<kbd>Ctrl</kbd> <kbd>+</kbd>) works too, and <kbd>Ctrl</kbd> <kbd>0</kbd> resets it.</li>
                  <li><b>Code without the mouse:</b> <kbd>Tab</kbd> to the transcript, <kbd>↓</kbd> to select
                    a line, <kbd>1</kbd>–<kbd>9</kbd> or <kbd>0</kbd> to apply a code. Every control shows a
                    focus ring, so where you are is never a guess.</li>
                  <li><b>Little rides on colour alone:</b> a selected line gets a rail, AI
                    noticings differ by underline style, rejected segments are striped and outlined, and an
                    AI proposal awaiting your verdict is striped in the gutter. Code identity is the
                    exception: lane bars can carry a <b>pattern</b> as well as a hue (the sidebar swatch
                    shows the same one), but that is a setting and it is <b>off by default</b> — turn on
                    Settings → Codes → <i>Code patterns</i> to make which-code-is-which independent of hue.</li>
                  <li><b>Contrast:</b> text meets WCAG AA in both themes, and the app follows your system's
                    "increase contrast" and "reduce motion" settings.</li>
                  <li><b>Less to look at:</b> zen mode hides the toolbar, tabs and sidebar, leaving the transcript (and the video dock, if you loaded media); the eye button hides AI highlights;
                    "merge lines" joins fragments into fewer, longer reading units.</li>
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

              {/* the credit that used to be the app-wide footer strip */}
            </div>

            <section className="about-credit">
              <span>Created with love and care by</span>
              <a className="foot-author" href="https://tomfluff.github.io/" target="_blank" rel="noreferrer">
                <img className="foot-avatar" src={AUTHOR_AVATAR} alt="Yotam Sechayk" width={20} height={20} />
                <span>Yotam Sechayk</span>
              </a>
              <span>— reach out with any questions.</span>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
