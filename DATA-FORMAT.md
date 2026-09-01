# Coding App — Transcript format & import

This mirrors the in-app **Transcript format & import** modal (the file-text button
next to *Import files…*). Keep the two in sync — the prompt below is duplicated in
`src/components/DataFormatButton.tsx`.

## The CSV format

Transcripts import as CSV, one row per line. A header row is required.

| Column | Meaning |
|---|---|
| `line_id` | Whole numbers, unique within the file. **Required** (import needs `line_id` + `text`). Gaps are fine and rows may arrive in any order — they are sorted by this. Sequential from 1 is simply the tidiest case. |
| `timestamp` | Line start time, `H:MM:SS` or `MM:SS` (milliseconds after a `.` are ignored). Powers the play-from-here chip. Optional. |
| `end_timestamp` | Line end time, same shape. Makes the merge-by-pause gap exact — without it, where a line ends is estimated from its text length at a typical speaking pace. Optional. |
| `speaker` | Any consistent label, reused per speaker — a full name is fine, it needn't be short. Optional (defaults to `P`). The interviewer is auto-dimmed (and prefixed `[R:]` in excerpts) when the label is exactly `R`, `I`, `Interviewer`, `Moderator`, `Facilitator` (or `R1`, `R2`…) — a first guess, editable per speaker in Settings → Speakers. A participant named "Rachel" stays a participant. |
| `text` | The spoken text for that line. **Required.** |
| `text_en` | An English translation of that line. A transcript carrying one can be read in either language — from the ⚙ button at its bottom right, or by right-clicking its tab — and the choice is not display-only: what you read is also what a code quotes, what an export writes, and what the AI is sent. Per line — an empty cell leaves that line as it was spoken, and the switch counts how many. In the Codebook, **Show the original** puts the source back under any excerpt. Reading in English, double-clicking a line edits the TRANSLATION (and writes one where the line has none); the spoken text is only editable while reading Source. Optional. |
| `text_en_original` | Written by QuAlly, not by you: the translation as it was imported, present only where you have since corrected it in the app — `text_en` then carries the corrected text. Mirrors what `original` does for `text`. Optional. |
| `codes` | Pre-existing codes, `;`-separated, or empty. Loaded as coded segments. Optional. |

It is real RFC-4180 CSV: any `text` containing a comma, quote, or newline must be
double-quoted (and internal quotes doubled). Don't hand-write it — use the AI
prompt below, which emits correctly-quoted CSV.

Example:

```csv
line_id,timestamp,end_timestamp,speaker,text,text_en,codes
1,00:00:03,00:00:06,R,So how do you usually read a chart?,,
2,00:00:07,00:00:11,P,"I zoom in really close, then pan across to follow the line.",,
3,00:00:12,00:00:15,P,Then I lose track of where the axis labels are.,,
```

## Session events (optional)

Markers and field notes captured *while the session ran* — hotkey presses, break
flags, free-text observations — import as their own CSV, **per transcript**, from
the tab's right-click menu → *Load events…*. It attaches to the tab you clicked,
so a recorder's file is never guessed onto the wrong participant.

*Export session events* writes **every** transcript's events to one file, so each
row names its own transcript in a `pid` column. Re-importing that file onto a tab
loads only the rows belonging to it and reports the rest as "belong to other
transcripts" — the round trip is a no-op however many transcripts are open. A
file with **no** `pid` column is from a recorder, or from an export written
before the column existed: there is nothing in it that could say otherwise, so
every row attaches to the tab you dropped it on, and the app says so when more
than one transcript is loaded.

The format is deliberately loose. Only three things are required:

| Column | Meaning |
|---|---|
| `event` | What kind of row this is (`marker`, `recording_start`, anything else). **Required** — it's how an events CSV is recognised. |
| a time | `video_time_s` (preferred), else `rec_offset_s`, else `video_time_hms`. **Required**; a row with no readable time is skipped. |
| `label` | The note itself. Editable in the app. |
| `code` | Groups and colours the events (`MAKE_PROGRESS`, `custom`, …). Optional — rows without one group under their `event`. |
| `detail` | The recorder's own annotations (`slot=1;via=hotkey`). Shown on hover. |
| `pid` | Which transcript the row belongs to. Written by the app's own export; optional on a recorder's file, where the drop target decides. |

Every other column (`epoch_ms`, `session`, `local_time`, whatever your recorder
writes) is kept verbatim and written back out by *Export session events*.

Times are read on the **video** clock, so events follow the offset set in the
video dock: correcting the offset re-places every event rather than stranding it.
Each event sits immediately before the first line that starts after it, so the
times still run downwards, and it prints its timecode in the transcript's own
shape (`24:32` next to `24:16`, not `0:24:32`).

Events can also be added by hand: right-click a transcript line (or press **E**
on the selected line) to open the add-event modal — time prefilled to that
line's end, type picked from the existing ones or typed fresh, note free-text.
Hand-added events export and round-trip like recorded ones.

An event shows up three ways — its own row in the transcript, an entry in the
sidebar's *Events* list (click to jump; drag its top edge to resize, and switch
between grouped-by-type and time order), and a tick in its own minimap lane.
Notes are editable in place (double-click) and any event can be deleted; both are
undoable. Right-click an event's type — in the transcript row or on the sidebar
dot — to recolour every event of that type; the choice travels in the project file.

Example:

```csv
event,code,label,rec_offset_s,video_time_s,video_time_hms,session,detail
recording_start,,,0.000,0.000,00:00:00.000,P01,anchor_err_ms=16.7
marker,MAKE_PROGRESS,Progress,1207.793,1206.767,00:20:06.767,P01,slot=1;via=hotkey
marker,custom,"Clicks the chart to see what each colour means",1473.218,1472.195,00:24:32.195,P01,slot=custom;via=hotkey
```

## Sections (optional)

A **section** says which part of the study a stretch of transcript belongs to —
"these lines are the warm-up", "these are the baseline condition". They are
`dimension: value` pairs (the axis, and the label within it), they may overlap
freely, and several axes can run at once. Mark them by selecting lines and
right-clicking, or let the AI propose them against labels you declare yourself
(Assist → Sections).

They ride in the project file and export as `sections.csv`, alone or in the CSV
bundle:

| column | what it holds |
| --- | --- |
| `pid` | the transcript |
| `line_start`, `line_end` | the line ids the section covers, inclusive |
| `dim` | the axis, e.g. `phase` |
| `value` | the label within it, e.g. `task 1` |
| `status` | blank for a section you marked yourself; otherwise `candidate` (proposed, not yet judged), `accepted`, or `rejected` |
| `proposed_by` | blank for your own; otherwise the model, e.g. `AI · Terra` |
| `why` | for a proposal, the model's one sentence naming what marks the boundary — kept after you accept, so the reason is still there when you write up |

A blank `status` with a blank `proposed_by` means you drew it — that is what QuAlly
itself writes for a section you marked by hand, and only AI-proposed rows carry either
field. (A hand-edited or third-party project file may set one without the other; nothing
breaks, but the pair no longer tells you where the section came from.)

Rejected sections are exported too. They are kept so a re-run does not propose
the same span again, and they count towards nothing.

`sections.csv` is export-only — nothing reads it back in. Sections come back
through the project file, where they ride with everything else.

## Working with your data

- **Autosave:** transcripts, codes, and segments are stored in the browser
  automatically — no accounts, no server, fully offline.
- **Back up / hand off:** *Export coded-segments.csv* writes your coding
  (`segment_ref, pid, excerpt, code, proposed_by, status, notes`) — with the
  reading language set to English on a translated study, an `excerpt_source`
  column joins it carrying what was actually said, so the file is never only a
  translation. Do it
  regularly — clearing the browser's site data wipes the local copy.
- **Round-trip:** re-importing an exported `coded-segments.csv` (with the same
  transcripts loaded) restores the segments; rows for transcripts you haven't
  loaded pass through untouched on the next export.
- **Multiple transcripts:** import several CSVs — each becomes a tab; the Browse
  tab reads codes across all of them.
- **Session events:** ride in the project file, and export as `events.csv`
  (alone or in the CSV bundle) with your edits applied. Re-importing that export
  is a no-op — events already loaded are recognised and skipped.
- **Session summaries:** the Summary tab's per-transcript text rides in the
  project file (`summaries`), alongside everything else the file carries.
- **Sections:** ride in the project file, and export as `sections.csv` (alone or
  in the CSV bundle) — see above. The study brief that AI proposals were made
  against rides in the project file too (`studyBrief`).

## Convert any transcript with AI

Paste the prompt below into ChatGPT or Claude, add a short sample of your
transcript where marked, run the Python script it writes, then import the
resulting `transcript.csv`.

```text
You are a data-formatting assistant. Convert my interview/session transcript into a CSV
for a qualitative-coding app. Write a Python 3 script (standard library only, csv module)
that reads input.txt in the same folder and writes transcript.csv with EXACTLY these
columns, in this order:

line_id,timestamp,end_timestamp,speaker,text,text_en,codes

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
- end_timestamp: when the row's speech ENDS, same shape, only if the source carries end
  times (per-segment end timings, cue end anchors, ...). A row split from a longer
  segment takes the end of its last source segment. Never compute or guess one — leave
  the column empty when the source has no real end boundary.
- speaker: consistent label per speaker; reuse the exact same label. If the source uses
  speaker codes (S01, S2, A15, SPEAKER_01, ...), prompt me for a real name for each code,
  showing two sample lines from that speaker so I can tell them apart. Blank input keeps
  the code.
- text: spoken text, whitespace-trimmed, with any speaker-label prefix and inline
  timecode markers removed.
- text_en: leave every cell EMPTY. It is a column for an English translation of the
  text column, added later by a translator or by me — never machine-translate it
  here, and never copy the text column into it. If my transcript is already in
  English, keep the column and leave it empty rather than duplicating the text.
- codes: always empty.
- Use csv.writer so fields containing commas, quotes, or newlines are correctly quoted
  (RFC 4180). Header row first.
- Print the row count and the first 5 output rows for a sanity check.
- Leave the chunk-size thresholds as named constants at the top so I can tune them.

Adapt the parsing to my transcript format:
<<paste or attach a sample>>
```
