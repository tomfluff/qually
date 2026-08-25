# AI coding assistance — scope & decisions

Branch: `feat/ai-coding-assist`. Decided 2026-07-24 (Yotam + Claude).

The line that governs all three features: **the AI proposes, the researcher
decides.** Nothing is applied without an explicit accept. This extends the
existing promise ("marks instances, never codes") — the Welcome/README/AI-tab
copy must be updated honestly when F2/F3 ship (see "Copy changes").

Build order: **F1 → F2 → F3** (as originally listed).

## Shared infrastructure (exists today)

- `callJson` structured output, redaction, per-request approval preview
  (AiCheckModal pattern: what's sent, cost estimate), `aiLog` for the methods
  appendix, model tiers (Terra/Sol hinted for interpretive tasks).
- Segments already carry `proposedBy` + `candidate/accepted/rejected`;
  candidate lanes render striped; Accept/Reject lives in the segment popover
  and Browse. Exports carry `proposed_by` (the intercoder column).

## Where runs start (Assist tab)

Observations and Suggest both group by **transcript** or by their own axis (lens /
code), and both start their run from the same two places: a full-width button above
the list, and a sparkle on each transcript row. The row's sparkle preselects that
transcript; the button preselects nothing and the consent gate's primary action
stays disabled until you pick. AiCheckModal and SuggestModal each take `pid` +
`choose`: a transcript's own code sidebar passes `pid` alone and keeps the scope
locked, Assist passes `choose` and shows the picker (lines, last run, what it
yielded — read from `aiLog` + the live marks/candidates).

## F1 — Grounding highlights (first)

What in a coded segment actually carries its code.

- **Call:** per segment — excerpt + code name + definition → exact quote
  spans (verbatim substrings, same guards as the scan: drop non-substrings).
- **Batch:** one run scans every accepted segment of a transcript (chunked,
  one approval).
- **Storage:** `aiGrounds: Record<sid, { hash, spans: {lineId, quote}[] }>` —
  invalidated by excerpt hash (line edit, resize, recode ⇒ stale, drops out).
- **Display (decided):** Browse excerpts emphasise the grounding quotes;
  segment popover shows them. The reading view is untouched.
- **Cost:** small — excerpts only.

## F2 — Merge near-duplicate codes (second) — SHIPPED

Built in the Assist tab (a "Merge codes" panel beside Observations): one-shot
`dedupeCodes` over the codebook (name + def + up to 3 exemplar excerpts each),
consent modal (MergeModal) with payload preview + per-run model picker, proposals
rendered inline with a flippable direction, accept per pair via the existing
undoable `mergeCode`. Honesty copy (README + Settings → AI) updated to
"proposes… applies nothing without your decision".

### Original plan

- **Call:** one-shot — codebook (names, definitions) + up to N sample
  excerpts per code (token-capped) → merge proposals
  `{ from, into, rationale }`.
- **Flow:** button in Browse (the codebook's home) → approval preview →
  proposals modal → accept per pair → existing merge machinery (undoable).
  No persistent AI state; a rejected proposal is just closed.
- **Guards:** needs ≥2 codes with segments; proposals only, never auto-merge.

## F3 — Suggest codes from the researcher's own codebook (third) — SHIPPED

Two launch surfaces, one modal: a transcript's code sidebar (scope locked to that
transcript) and the Assist tab's Suggest panel — its "AI code suggestion…" button
(nothing preselected) or the sparkle on any transcript row (that one preselected).
ai/suggest.ts chunks ONE transcript into 40-line windows, each sent with the
codebook (name + def + up to 2 exemplars). SuggestModal is the consent gate
(transcript picker when launched from Assist — lines, last run and candidates per
row from aiLog; payload preview, cost, per-run model picker, Terra hint).
Proposals land as candidate segments (proposedBy "AI · <model>", status
"candidate") via addSegment, skipping any range already carrying that code
(overlapsExisting — accepted or rejected, model-independent = rejection memory).
Reviewed in the Assist tab's "Suggest" worklist (Accept/Reject/open via setStatus)
and striped in the transcript. sanitizeSuggestReply is the trust boundary
(existing code + in-window range only). Unit-tested.

### Original plan

- **Call:** chunked windows (like the scan) with the codebook + a few
  exemplar excerpts per code → proposed segments `{ startLine, endLine,
  code }`, existing codes ONLY (no new code invention — that stays with the
  researcher).
- **Landing (decided):** candidate segments, `proposedBy: "AI · <model
  name>"` (e.g. `AI · Terra`) — review happens in the machinery that already
  exists. Exports then support intercoder-agreement work against a machine
  second coder.
- **Rejection memory:** rejected AI candidates are remembered
  (pid+range+code key, like dismissed marks) so re-runs don't resurface them.
  Skip ranges already carrying the same code.
- **Cost:** the expensive one — window + codebook per chunk. Preview shows
  the estimate; Terra recommended in the modal hint.

## Copy changes (ship with F2/F3, not before)

- Welcome + README: "marks instances only" → "proposes — marks, merges and
  candidate codings — and applies nothing without your decision."
- AI settings intro note: same reframe, one line.
- ACCESSIBILITY.md unaffected (review flows are the existing keyboard paths).

## Out of scope (raised, deliberately not now)

- Embeddings/vector similarity (no infra, LLM judgment suffices at codebook
  scale).
- New-code invention by the AI (crosses "coding stays yours").
- In-transcript grounding underlines (revisit after F1 lands in Browse).

---

## F4–F6 — the consolidation suite (SHIPPED 2026-08-23, Waves 0–2)

Same line, extended: **the AI proposes, the researcher decides** — and now the
record says which was which.

- **The decision ledger** (`state/store.ts`, `provenance.ts`, Assist →
  Decisions). `aiLog` records what was ASKED of the model; the ledger records
  what the researcher DID with the answer. Every merge / rename / withdrawal /
  deletion / set-aside carries its reason, its source (`you` / `wording` /
  `ai` + model) and the size of what moved. Exports as `decisions.csv`; the
  methods paragraph is counted from it, never written by a model.
- **The offline wording sweep** (`sweep.ts`). The whole book at once, on the
  device, no key: two tiers (one name's words inside another's, vs merely
  shares wording), a negation guard so valence flips never reach the confident
  tier, and refusal memory read out of the ledger's dismiss rows.
- **The thin tail** (`components/TailQueue.tsx`). One thin code per screen,
  keep / fold / set aside, walked in both directions. The ledger is its memory.
- **What separates these two?** (`components/TellApartModal.tsx`). The
  researcher writes the distinguishing sentence BEFORE any model is asked, and
  it becomes both codes' definitions. Failing to write it merges, with that
  failure as the recorded reason.
- **Argue against this merge** (`ai/reconcile.ts: argueAgainst`). Same model,
  opposite job: the strongest case that a proposed merge is wrong, with "no
  real case" a first-class answer drawn as a shrug.
- **Your call before the model's** (`ui.blindVerdict`, on by default). An AI
  capsule withholds its reasoning until the researcher has called it; the
  agreement rate lands in the ledger and in the methods paragraph.

Copy note: the Welcome/README reframe promised above still says "proposes —
marks, merges and candidate codings — and applies nothing without your
decision". That remains true of every surface here, and the Decisions panel is
now the place a reader can check it.

---

## F7 — Propose sections (stretches) from a study brief — SCOPED 2026-08-25

Same line, once more: **the AI proposes, the researcher decides** — and here the
researcher also decides, in advance, what the AI is *allowed to say*.

A within-subject session has a shape: warm-up, task 1, condition switch, task 2,
debrief. Today that shape is marked by hand, span by span, on every transcript.
The researcher already knows the shape before they open the file — they designed
the study. F7 lets them state it once and have each transcript marked up against
it.

Sections are **stretches**, not segments: `{pid, start, end, dim, value}` — the
axis and the label within it, overlapping freely (see `stretches.ts`). A code is
an interpretation of what was said; a section is a fact about where in the
session it was said. Nothing else in the model fits — a `Marker` is a moment,
a `Segment` belongs to the codebook.

### The closed vocabulary (the decision that shapes everything else)

The model may **never invent a label**. This is the same rule F3 holds for codes,
and for the same reason: a vocabulary that grows by itself is not the
researcher's vocabulary any more. But sections differ from codes in where the
list comes from — a codebook already exists in the project, whereas the study
design lives in the researcher's head until they write it down.

So the brief carries it. The brief is prose *plus* one or more declaration
lines in a deliberately tiny grammar:

```
phase: warm-up, task 1, task 2, debrief
condition: baseline, beacon
```

Everything else in the brief is free prose about the study — how the session was
run, what the switch sounds like, what to ignore — and rides along as context.
Two properties make the tiny grammar worth its own parser:

- **It is the guard.** Whatever parses out of it is exactly the set the
  sanitizer will accept back; anything else the model returns is dropped, not
  negotiated. Parsed once, used twice — in the prompt and at the trust boundary.
- **It is visible before sending.** The gate echoes what it parsed ("I will
  accept exactly these: phase → warm-up / task 1 / task 2 / debrief") next to
  the payload preview. A misparsed line is then something the researcher SEES,
  rather than something they discover as a silently empty result.

A brief that declares nothing blocks the run, with that sentence as the reason.
With no declared vocabulary there is no guard, and the premise of the feature is
that there is one.

### The remembered brief

```ts
studyBrief: Record<string, string>   // "" = the project default, [pid] = an override
```

Project data — it describes the study, so it travels with the project file and
exports with it. One field covers all three things asked for: remembered,
reused across transcripts, and adaptable per transcript. The gate opens on
`studyBrief[pid] ?? studyBrief[""]`, edits apply to that run alone, and two
explicit buttons — *Save as the study default* / *Save for this transcript* —
are the only ways an edit persists. A run never silently rewrites the brief.

### The call

- **Whole transcript, one call.** Not chunked. A 40-line window (F3's shape)
  cannot see a boundary, let alone the arc of a session; the question "where
  does task 1 end" is only answerable from the whole. ~1,500 lines is ~31k
  tokens — pennies on Luna, and the cheapest thing about this feature.
- **Fallback for the long ones:** overlapping windows (~400 lines, ~40 overlap)
  above a size threshold, stitching adjacent runs of the same `dim:value`.
  Written only when a real transcript needs it — not up front.
- **Payload:** the brief (prose + declarations) + the numbered lines, redacted
  as everywhere else, `id<TAB>speaker<TAB>text`.
- **Reply:** `{ sections: [{ dim, value, line_start, line_end, why }] }`, strict
  JSON schema. `why` is one sentence of evidence — it is what makes a verdict
  fast, and it is shown in review rather than stored.
- **Model:** the researcher's, from the gate's `ModelPicker` starting at the
  Settings default — as every other run in the app.

### Landing and review

Proposals land as stretches carrying the same two fields segments already use:

```ts
status?: "candidate" | "accepted" | "rejected";   // absent = the researcher's own
proposedBy?: string;                              // "AI · Terra"
```

Both optional, so every project file written before F7 still loads and every
hand-marked stretch stays exactly what it is. Exports gain `proposed_by`, the
column segments already carry, which is what makes intercoder work against a
machine second coder possible for sections too.

Review happens **in the gutter**, not in a list: a boundary cannot be judged
without the lines on either side of it. Candidate bands render striped (the
existing candidate language), the pill menu gains Accept/Reject, and a summary
bar offers *Accept all* / *Discard all* — with `deleteStretchesBy({pid, status})`
mirroring `deleteSegmentsBy` as the escape hatch from a run nobody wanted.

### The trust boundary

`sanitizeSectionsReply`, testable without the network, by analogy with
`sanitizeSuggestReply`:

- `dim:value` must be in the declared vocabulary — matched case-insensitively,
  stored in the **declared** spelling, so a project never accumulates both
  `Task 1` and `task 1`.
- Both endpoints must be real line ids of THIS transcript; ranges normalised
  low→high; exact duplicates dropped.
- A proposal identical to an existing stretch is skipped (`markStretch` is
  already a no-op on exact duplicates); one that overlaps a *rejected* stretch
  with the same label is skipped too — rejection memory, as F3 has.
- Two candidate values overlapping **within one dim** are surfaced in review as
  a conflict rather than dropped: a session cannot be in two phases at once, and
  that is a judgement about which one is wrong, not a parse error.

### What this does not do

- No new-label invention (above) — the whole point.
- No timestamp reasoning: sections are line ranges, like every stretch. The
  time filter in search already covers "the second task, after 12 minutes".
- No automatic re-run on re-import. Stretches are remapped to new line ids by
  the existing import path; a re-run is the researcher's call.
