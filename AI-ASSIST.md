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
The researcher knew the shape before they opened the first file — they designed
the study. F7 lets them state it once and have each transcript marked against it.

Sections are **stretches**, not segments: `{pid, start, end, dim, value}` — the
axis and the label within it (see `stretches.ts`). A code is an interpretation of
what was said; a section is a fact about where in the session it was said.
A `Marker` is a moment, a `Segment` belongs to the codebook; neither fits.

Reviewed 2026-08-25 (Fable + Codex) before any code. Their findings are folded
in below; the four that changed the design are marked **[review]**.

### The closed vocabulary

The model may **never invent a label** — the same rule F3 holds for codes, and
for the same reason. But sections differ from codes in where the list comes
from: a codebook already exists in the project, whereas the study design lives
in the researcher's head until they write it down.

So the brief carries it: prose *plus* declaration lines in a tiny grammar.

```
phase: warm-up, task 1, task 2, debrief
condition: baseline, beacon
```

Everything else is free prose about the study — how the session ran, what the
switch sounds like, what to ignore — and rides along as context.

- **The parse is the guard.** What parses out is exactly what the sanitizer will
  accept back; anything else is dropped, not negotiated. Parsed once into an
  immutable snapshot the run closes over, used twice — in the prompt and at the
  trust boundary — so editing the brief mid-gate cannot desync them.
- **The parse is shown before sending**, beside the payload preview: "I will
  accept exactly these: phase → warm-up / task 1 / task 2 / debrief". A
  misparsed line is then something the researcher SEES.
- A brief that declares nothing **blocks the run**. No vocabulary, no guard.

Grammar decisions (all previously unspecified — **[review]**):

- A declaration is a **bulleted** line — `- dim: v1, v2, …` (or `*`/`•`). The
  bullet is what keeps the grammar honest: without it any prose sentence holding
  a colon (`Note: participants were tired, confused`) parses as an axis, and a
  false declaration does not merely misread — it WIDENS the guard, which is the
  one thing the parser exists to prevent. Nobody writes a sentence beginning
  `- word:` by accident, and a bulleted list of axes is what a researcher would
  write anyway. (An earlier draft tried "no whitespace in the dim"; `Note` has
  none, so it stopped nothing.)
- Declarations may appear anywhere in the brief; order is irrelevant, and the
  prose may lead.
- Repeated dims merge; duplicate values collapse; empty items are dropped.
- Labels are compared **case-folded and Unicode-NFC-normalised**, and stored in
  the **declared** spelling — except where a stretch already in the project
  carries that label in another spelling, in which case the EXISTING spelling
  wins. `markStretch`, `stretchDims` and `coverageOf` all compare dim/value
  case-**sensitively** (`store.ts`, `stretches.ts`), so without this a declared
  `phase: warm-up` over a hand-marked `Phase: Warm-up` silently forks the
  project into two identically-coloured gutter columns.
- A comma cannot appear inside a label; a colon may (only the first splits).
  Pairs are keyed `dim\u0000value`, never joined by a space — a label may
  contain spaces, and `"chart type"+"bar"` must not collide with
  `"chart"+"type bar"`. Control characters are stripped from every label first:
  a separator only separates if it cannot appear in what it joins, or a declared
  `a`+`b\u0000c` and a replied `a\u0000b`+`c` build the same key.
- Matching is lowercase, not full Unicode case folding, so `STRASSE` and
  `straße` are different labels. That fails safe — the pair is not found and the
  proposal is dropped — which is the only direction this guard may be wrong in.
- An unrecognised `status` read from a project file becomes `candidate`, never
  absent: absent means "the researcher marked this", so deleting a typo'd status
  would launder an unjudged proposal into evidence that counts.
- `SectionProposal` is a **branded** type minted only by `sanitizeSections`, so
  `landSections` cannot be handed a raw model reply by a later caller who did
  not know the vocabulary check was the point.
- **Labels are never redacted.** They are the researcher's structural
  vocabulary, not participant speech — and a redacted label would come back as
  `[REDACTED_n]` and match nothing. Same split F3 already makes between code
  names (sent plain) and definitions/excerpts (redacted). Prose in the brief IS
  redacted, and `why` is restored before it is ever shown.

### The remembered brief

```ts
studyBrief: Record<string, string>   // "" = the project default, [pid] = an override
```

Project data: it describes the study, so it travels with the project file. One
field covers all three things asked for — remembered, reused across transcripts,
adaptable per transcript. The gate opens on `studyBrief[pid] ?? studyBrief[""]`;
edits apply to that run alone unless *Save as the study default* or *Save for
this transcript* is pressed. A run never silently rewrites the brief.
An override is removed by *Use the study default again*, which **deletes the
key** — storing `""` would otherwise read as a deliberate empty override and
suppress the default (**[review]**).

### The call

- **Whole transcript, one call.** A 40-line window (F3's shape) cannot see a
  boundary, let alone the arc of a session. ~1,500 lines ≈ 31k tokens ≈ 3 cents
  of Luna input; output and reasoning bill on top, and Terra/Sol are 2.5× and 5×
  that. The honest claim is "pennies on Luna", not a total (**[review]**).
- **A bounded reply.** The schema caps the list at `SECTIONS_MAX`, and the
  gate prices the run against that cap rather than against a guess at how many
  sections the model will find — a pre-flight price may overstate, never
  understate. A session has a shape, not a thousand parts.
- **A hard ceiling, now.** `callJson` has no context preflight, so an oversized
  request becomes a post-consent API error. The gate refuses above a rendered
  token ceiling and says so. Windowing stays deferred — but the promise it would
  keep is bounded in v1 rather than left open (**[review]**).
- **Payload:** brief (prose redacted, declarations plain) + `id<TAB>speaker<TAB>text`.
- **Reply:** `{ sections: [{ dim, value, line_start, line_end, why }] }`, strict schema.
- **Model:** the researcher's, from the gate's `ModelPicker` starting at the
  Settings default — as every other run in the app.

### Landing and review

Stretches gain three optional fields — absent means a stretch the researcher
marked themselves, so every existing project file still loads unchanged:

```ts
status?: "candidate" | "accepted" | "rejected";
proposedBy?: string;   // "AI · Terra"
why?: string;          // the model's one-sentence evidence, restored from redaction
```

`why` is **kept**, not shown-and-discarded: candidates outlive the run (reload,
project file), and a candidate whose reason has evaporated cannot be judged. It
stays on the stretch after accepting, which is what lets the methods appendix
say why a boundary sits where it does (**[review]**).

**Status discipline, per consumer** — the largest gap the review found. Adding
the field is not enough; every reader of `stretches` must be told which kinds it
is looking at (**[review]**):

| consumer | candidate | rejected |
| --- | --- | --- |
| `coverageOf` (drives the Code map's by-dimension grouping) | excluded | excluded |
| `stretchDims` / gutter columns | own striped column | excluded |
| `stretchesAt`, the line-row dialog | listed, marked pending | excluded |
| Minimap strips | excluded | excluded |
| Browse membership dots | excluded | excluded |
| `sections.csv` | included, with status | included, with status |

Rejected stretches are **memory only**: they exist so a re-run does not
resurface them, and they are invisible everywhere a section means something.

**Landing is one store gesture.** `markStretch` owns its own `pushUndo`, so
looping it over 30 proposals would leave 30 undo entries; F3 solved this already
(one push per run, `addSegment` pushes nothing). F7 adds `landSections()`,
`setStretchStatus()`, `acceptSections({pid})` and `deleteStretchesBy({pid,
status})` — each one snapshot, mirroring `deleteSegmentsBy` (**[review]**).
Discarding deletes and so forgets; rejecting keeps the memory. Both are offered,
and the difference is stated in the buttons.

**Review is reachable without a selection, and by keyboard.** A right-click on
any line inside a striped section opens the verdict card: the label, the range,
the model's sentence, and Accept / Reject as ordinary buttons in the tab order.
A candidate offers those two and NOT Remove — the three are not variants of one
another, because rejecting remembers and removing forgets, inviting the same
boundary straight back on the next run.

**Review is reachable by keyboard.** The stretch overlay is `aria-hidden` and
its pills open by right-click only, so the gutter cannot be the only route —
ACCESSIBILITY.md promises otherwise, and this app's first user has low vision
(**[review]**). The host already exists: the line-row context dialog lists every
stretch overlapping the selection with per-stretch buttons. Accept/Reject join
it, the label, range, reason and provenance are spoken there, and the summary
bar's bulk actions announce their result.

### The trust boundary

`sanitizeSectionsReply`, testable without the network, by analogy with
`sanitizeSuggestReply`:

- `dim:value` must be in the parsed vocabulary — matched case-folded/NFC,
  stored in the canonical spelling.
- Both endpoints must be real line ids of THIS transcript; ranges normalised
  low→high; exact duplicates dropped.
- A proposal identical to an existing stretch is skipped (`markStretch` is
  already an exact-duplicate no-op).
- **Rejection memory is exact**: same dim, value, start and end. F3 suppresses
  any overlapping same-code proposal, which is right for excerpts and wrong here
  — a section spans hundreds of lines, so overlap-suppression would mean that
  rejecting `phase: task 1` once forbids task 1 anywhere near there forever. The
  fix for "right label, wrong boundary" is dragging the grips, which already
  works (**[review]**).
- **No within-dim conflict rule.** Overlapping values inside one dim are
  deliberately legal (re-marking, containment; `coverageOf` credits every
  overlapping value), and the gutter paints them into one column where the later
  band overpaints the earlier — so a "conflict" could be neither asserted nor
  shown. The prompt asks for one value per dim per line; anything else comes
  back as ordinary candidates (**[review]**).

### Exports

`sections.csv` joins the bundle: `pid, line_start, line_end, dim, value, status,
proposed_by, why`. Stretches have never had a CSV of their own — the earlier
claim that "exports gain `proposed_by`" assumed an export that does not exist
(**[review]**). DATA-FORMAT.md gains the section, and the import side stays
project-file-only for now.

### Provenance

- `aiLog` records the run as `task: "sections"` with real usage — including a
  run that proposed nothing, which is a result, not a non-event, and including
  one that was **aborted or failed after dispatch**. The transcript left the
  device either way: a log that records only the runs that came back is claiming
  to be complete while being wrong in the one direction that matters. `AiCall`
  gains an optional `outcome`; absent still means "completed", which is what
  every entry written before this field was.
- The decision **ledger is not extended**: its kinds and payload are
  codebook-centric (`codes: string[]`), and bending them to carry section
  verdicts would corrupt the codebook story the methods paragraph tells. Section
  provenance lives on the stretches themselves (`status` + `proposedBy` + `why`)
  and exports as `sections.csv`.

### Launch surface and the corpus-wide worklist

F1–F3 doctrine: a full-width button in the Assist tab plus a per-transcript
control. F7 adds a **Sections** panel to the `assistPanel` union with the same
two entry points, and the transcript picker's per-row readout (lines, last run,
live candidates) comes free from `aiLog`.

The panel is the corpus-wide half of review; the per-line verdict stays in the
transcript, where the lines around a boundary are visible and a verdict can
actually be made. Here you see how much is waiting, run the next transcript,
and — once a run has earned it — take one transcript's proposals in a single
gesture. **Accept all is offered per transcript, not corpus-wide**: a run is per
transcript, and "I read that one and it was right" is a thing a researcher can
truthfully say about one session and not about six.

**Clear sections** discards in bulk, and deliberately does not offer "reject in
bulk": rejecting is a verdict the next run consults, and a verdict on thirty
boundaries nobody read is not a verdict. Clearing the rejected ones forgets
their memory, which the menu says, because that memory is the only reason a
rejected section is kept at all.

### Copy

The README's AI list still names flags, observations, grounding and merge
proposals — the F2/F3 reframe never reached it. F7's wave includes an honest
pass over README, Welcome/About, Settings → AI, the Assist help text,
DATA-FORMAT.md and ACCESSIBILITY.md (which still describes the transcript as a
listbox, a contract the implementation deliberately rejected).

### Out of scope

- Label invention — the whole point.
- Timestamp reasoning: sections are line ranges. The search bar's time filter
  already covers "the second task, after 12 minutes".
- Automatic re-run on re-import. Stretches remap to new line ids on Update and
  drop on Replace, candidates included; a re-run is the researcher's call.
- Windowing for very long transcripts (bounded by the ceiling above instead).
