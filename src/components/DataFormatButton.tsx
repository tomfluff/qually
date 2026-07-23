// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

// The prompt a user pastes into an AI (ChatGPT / Claude) to turn any transcript
// into the CSV this app imports. Kept in sync with DATA-FORMAT.md.
const AI_PROMPT = `You are a data-formatting assistant. Convert my interview/session transcript into a CSV
for a qualitative-coding app. Write a Python 3 script (standard library only, csv module)
that reads input.txt in the same folder and writes transcript.csv with EXACTLY these
columns, in this order:

line_id,timestamp,speaker,text,codes

Requirements:
- One row per digestible chunk of speech, not per whole speaker turn.
  * Always start a new row when the speaker changes.
  * If the transcript already contains timecodes INSIDE a long turn, honor them:
    each mid-turn timecode starts a new row, with that timecode as its timestamp.
    The same speaker may therefore appear on several consecutive rows.
  * If a long turn has no mid-turn timecodes, split it anyway at the finest
    time-stamped boundary the format offers (per-segment timings, cue anchors, etc.),
    once a row passes ~300 characters, preferring a break after a sentence end.
    Hard-cut at ~600 characters if no sentence end appears. Never split mid-segment
    and never invent a timestamp — every row's timestamp must come from a real
    boundary in the source.
- line_id: sequential integers starting at 1.
- timestamp: that row's start time as H:MM:SS, or MM:SS under an hour. Drop milliseconds.
  Empty if the row has no time.
- speaker: consistent label per speaker; reuse the exact same label. If the source uses
  speaker codes (S01, S2, A15, SPEAKER_01, ...), prompt me for a real name for each code,
  showing two sample lines from that speaker so I can tell them apart. Blank input keeps
  the code.
- text: spoken text, whitespace-trimmed, with any speaker-label prefix and inline
  timecode markers removed.
- codes: always empty.
- Use csv.writer so fields containing commas, quotes, or newlines are correctly quoted
  (RFC 4180). Header row first.
- Print the row count and the first 5 output rows for a sanity check.
- Leave the chunk-size thresholds as named constants at the top so I can tune them.

Adapt the parsing to my transcript format: 
<<paste or attach a sample>>`;

const EXAMPLE_CSV = `line_id,timestamp,speaker,text,codes
1,00:00:03,R,So how do you usually read a chart?,
2,00:00:07,P,"I zoom in really close, then pan across to follow the line.",
3,00:00:12,P,Then I lose track of where the axis labels are.,
`;

export function DataFormatButton() {
  const open = useStore((s) => s.formatOpen);
  const setOpen = useStore((s) => s.setFormatOpen);
  const [copied, setCopied] = useState(false);
  const dialogRef = useDialogFocus();

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  });

  const copyPrompt = () => {
    navigator.clipboard.writeText(AI_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const downloadExample = () => {
    const url = URL.createObjectURL(new Blob([EXAMPLE_CSV], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "example-transcript.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button className="btn dfbtn" title="Transcript format & import guide" onClick={() => setOpen(true)}>
        <Icon name="file-text" size={15} /> <span className="blabel">File format</span>
      </button>
      {open && (
        <div className="about-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="about" ref={dialogRef} role="dialog" aria-modal="true"
            aria-labelledby="data-format-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="about-head">
              <h2 id="data-format-title">Transcript format &amp; import</h2>
              <button className="btn iconbtn" onClick={() => setOpen(false)} title="Close (Esc)"><Icon name="x" size={16} /></button>
            </div>
            <p className="about-lede">
              Transcripts import as CSV. The easiest path: use the AI prompt below to convert
              whatever you have into the right shape, then <b>Import files…</b>.
            </p>

            <div className="about-body nicescroll">
              <section>
                <h3>The CSV format</h3>
                <p>One row per line. Columns (header row required):</p>
                <table className="fmt-table">
                  <tbody>
                    <tr><td><code>line_id</code></td><td>Sequential integers, starting at 1. <b>Required.</b></td></tr>
                    <tr><td><code>timestamp</code></td><td>Line start time, <code>H:MM:SS</code> or <code>MM:SS</code> (milliseconds ignored). Powers the play-from-here chip. Optional.</td></tr>
                    <tr><td><code>speaker</code></td><td>Any consistent label, reused per speaker — a full name is fine, it needn't be short. Optional (defaults to <code>P</code>).</td></tr>
                    <tr><td><code>text</code></td><td>The spoken text for that line. <b>Required.</b></td></tr>
                    <tr><td><code>codes</code></td><td>Pre-existing codes, <code>;</code>-separated, or empty. Loaded as segments. Optional.</td></tr>
                  </tbody>
                </table>
                <p className="fmt-note">It's real CSV: any <code>text</code> with a comma, quote, or newline must be double-quoted. Don't hand-write it — let the prompt below do it.</p>
                <p className="fmt-note">The interviewer's rows are dimmed automatically when the label is exactly <code>R</code>, <code>I</code>, <code>Interviewer</code>, <code>Moderator</code>, <code>Facilitator</code> (or <code>R1</code>, <code>R2</code>…) — a first guess you can change for any speaker in <b>Settings → Speakers</b>. A participant named “Rachel” stays a participant.</p>
                <button className="btn" onClick={downloadExample}>Download example-transcript.csv</button>
              </section>

              <section>
                <h3>Working with your data</h3>
                <ul>
                  <li><b>Autosave:</b> everything (transcripts, codes, segments) is saved in this browser automatically — no accounts, no server.</li>
                  <li><b>Back up / hand off:</b> <b>Export coded-segments.csv</b> writes your coding. Do this regularly — clearing the browser's site data wipes the local copy.</li>
                  <li><b>Round-trip:</b> re-importing an exported <code>coded-segments.csv</code> (with the transcripts) restores the segments; imported rows for transcripts you haven't loaded pass through untouched on the next export.</li>
                  <li><b>Multiple transcripts:</b> import several CSVs — each becomes a tab; the Browse tab reads codes across all of them.</li>
                </ul>
              </section>

              <section>
                <h3>Convert any transcript with AI</h3>
                <p>Paste this into ChatGPT or Claude, add a sample of your transcript where noted, run the Python script it gives you, then import the resulting <code>transcript.csv</code>.</p>
                <div className="aiprompt-wrap">
                  <button className="btn copyprompt" onClick={copyPrompt}>
                    <Icon name="copy" size={14} /> {copied ? "Copied!" : "Copy prompt"}
                  </button>
                  <pre className="aiprompt nicescroll">{AI_PROMPT}</pre>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
