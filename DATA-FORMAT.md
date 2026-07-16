# Coding App — Transcript format & import

This mirrors the in-app **Transcript format & import** modal (the file-text button
next to *Import files…*). Keep the two in sync — the prompt below is duplicated in
`src/components/DataFormatButton.tsx`.

## The CSV format

Transcripts import as CSV, one row per line. A header row is required.

| Column | Meaning |
|---|---|
| `line_id` | Sequential integers starting at 1. **Required** (import needs `line_id` + `text`). |
| `timestamp` | Line start time, `H:MM:SS` or `MM:SS` (milliseconds after a `.` are ignored). Powers the play-from-here chip. Optional. |
| `speaker` | Any consistent label, reused per speaker — a full name is fine, it needn't be short. Optional (defaults to `P`). The interviewer is auto-dimmed (and prefixed `[R:]` in excerpts) when the label is exactly `R`, `I`, `Interviewer`, `Moderator`, `Facilitator` (or `R1`, `R2`…) — a first guess, editable per speaker in Settings → Speakers. A participant named "Rachel" stays a participant. |
| `text` | The spoken text for that line. **Required.** |
| `codes` | Pre-existing codes, `;`-separated, or empty. Loaded as coded segments. Optional. |

It is real RFC-4180 CSV: any `text` containing a comma, quote, or newline must be
double-quoted (and internal quotes doubled). Don't hand-write it — use the AI
prompt below, which emits correctly-quoted CSV.

Example:

```csv
line_id,timestamp,speaker,text,codes
1,00:00:03,R,So how do you usually read a chart?,
2,00:00:07,P,"I zoom in really close, then pan across to follow the line.",
3,00:00:12,P,Then I lose track of where the axis labels are.,
```

## Working with your data

- **Autosave:** transcripts, codes, and segments are stored in the browser
  automatically — no accounts, no server, fully offline.
- **Back up / hand off:** *Export coded-segments.csv* writes your coding
  (`segment_ref, pid, excerpt, code, proposed_by, status, notes`). Do it
  regularly — clearing the browser's site data wipes the local copy.
- **Round-trip:** re-importing an exported `coded-segments.csv` (with the same
  transcripts loaded) restores the segments; rows for transcripts you haven't
  loaded pass through untouched on the next export.
- **Multiple transcripts:** import several CSVs — each becomes a tab; the Browse
  tab reads codes across all of them.

## Convert any transcript with AI

Paste the prompt below into ChatGPT or Claude, add a short sample of your
transcript where marked, run the Python script it writes, then import the
resulting `transcript.csv`.

```text
You are a data-formatting assistant. Convert my interview/session transcript into a CSV for a qualitative-coding app. Write a small Python 3 script (standard library only, using the csv module) that reads my transcript from a file named input.txt in the same folder and writes transcript.csv with EXACTLY these columns, in this order:

line_id,timestamp,speaker,text,codes

The script must:
- Write one row per spoken line / utterance.
- line_id: sequential integers starting at 1.
- timestamp: the line's start time as H:MM:SS or MM:SS (drop any milliseconds). Leave empty if a line has no time.
- speaker: a consistent label per speaker — a name is fine, it need not be short. Reuse the exact same label for the same speaker. To have the interviewer's lines auto-dimmed in the app, label them exactly "R" or "Interviewer"; participant names (e.g. "Rachel") are left as participants.
- text: the spoken text for that line, whitespace-trimmed.
- codes: always empty.
- Use Python's csv.writer so any field containing a comma, quote, or newline is correctly quoted (RFC 4180). Write the header row first.
- Print the first 5 output rows so I can sanity-check.

Adapt the parsing to my transcript, which looks like this:
<<< paste a short sample of your transcript here >>>
```
