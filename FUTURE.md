# Coding App — Future Opportunities & Backlog

Captured from the 2026-07-04 brainstorm. **Nothing here is scheduled.** These are
hypotheses with a rough effort/value read, kept so the thinking isn't lost. The
value test for anything in this file: does it make coding *faster*, the analysis
*more defensible*, or the codes→paper handoff *shorter*? Ideas that fail that test
are parked under "Probably YAGNI" on purpose.

Pipeline seam to respect: **Python** owns prep + theme drafting + sync
(`analysis/prepare_transcripts.py`, `refresh_themes_draft.py`, `sync_coding.py`);
the **app** is the coding surface. Some ideas below belong on the Python side.

Shipped items get moved to the "Done" list with the commit.

---

## Done

- **(9) Consolidation suite — SHIPPED 2026-08-23** (Waves 0–2, local commits
  `5291298`…`867288f`). Three layers, all reviewed by a second model:
  - *The record.* A decision ledger beside `aiLog`: every merge, rename,
    withdrawal, deletion and set-aside with its reason and whose idea it was
    (you / matched on wording / AI + model), undo-aware (an undone decision is
    flagged, not erased), travelling in the project file and exporting as
    `decisions.csv`. Provenance per code is derived from it (`provenance.ts`),
    as is the methods paragraph. Assist → **Decisions** shows all of it.
  - *Seeing and thinning.* The view menu says what each grouping holds
    ("84 of 123 on one excerpt or none"); an offline whole-book wording sweep
    (`sweep.ts`) proposes merge capsules with no key and no cost, remembering
    what you turned down; **the thin tail** (Assist) walks every thin code one
    screen at a time, keep / fold / set aside, forwards and back.
  - *Deciding.* **What separates these two?** asks for the distinguishing
    sentence before anything offers one, and writes it as both definitions;
    **argue against this merge** asks the model for the strongest case that you
    are wrong, and may find none; **your call before the model's** withholds an
    AI proposal's reasoning until you have said what you think, and counts the
    agreement into the methods paragraph.
  - Also: `parked` codes (set aside without rejecting or deleting), stable
    cluster ids, and a Code map that no longer evicts a group's codes when you
    move it.

- **(5) Session event logs — SHIPPED 2026-08-09.** A recorder's events CSV
  (markers + field notes) loads per transcript from the tab's right-click menu;
  events interleave with the lines by time on the video clock (they follow the
  dock's offset), render as their own rows, and land in a resizable sidebar
  Events list and a minimap lane. Events are editable/deletable/addable in-app
  (right-click a line or E), types are renameable and recolourable, and
  everything round-trips through events.csv and the project file.

- **(4) AI assistance suite — SHIPPED 2026-07 (multiple commits).** The
  "Probably YAGNI" verdict below was overturned: observation scan (7 Saldaña
  first-cycle lenses incl. transcription repair), code suggestion from the
  researcher's own codebook (candidate segments, accept/reject), near-duplicate
  code merge, and per-code grounding — all behind the Assist tab / sidebar AI
  menu, key-in-browser, redaction before send, per-call provenance log.

- **(3) Density minimap — SHIPPED 2026-07-05** (`Minimap.tsx`). Zoomed-out
  lane mirror down the right edge: segment density, speaker rail, AI-mark and
  event lanes, close-call gutter, accent viewport box, click/drag navigation.
  Replaces the native transcript scrollbar; detailed + simplified modes.

- **(2) Multi-coder foundation — SHIPPED 2026-07-15** (branch `feat/multi-coder`).
  The coder name is a setting (Settings → Codes, `ui.coderName`, default `tom`)
  instead of a hardcoded `proposedBy`; segment dedup is per coder, so importing a
  second coder's `coded-segments.csv` keeps their agreeing rows as agreement data;
  any unverdicted status (`candidate`/`proposed`) renders pencilled-in (dashed
  outline + pale fill, proposer in the tooltip) with a real Accept/Reject pair in
  the popover. The Python side matches (`sync_coding.py --coder`, per-coder dedup,
  unique-segment theme counts). This is the "half an IRR workflow" half of the
  inter-rater item below; the agreement view / κ / Compare panel remains future.

- **(1) In-app close-call warnings — SHIPPED 2026-07-04.** The excerpt rule's
  `closeCall` flag (losing speaker held ≥40% of chars, i.e. a mixed-substance
  segment) is now surfaced while coding, not just at export: a thick amber outline
  around the segment's lane block (additive over a rejected border, not a
  replacement) + a minimap gutter tick + a warning line in the segment popover.
  `excerptOf` already computed it; this only consumes it. Closes the visible half
  of the W7 item 18 provisional-rule loop (the rule itself is still on trial).

---

## Candidates (unscheduled)

### Analysis rigor — highest leverage, tied to real open threads
- **Excerpt rule v2 is still PROVISIONAL** (CODING-APP-DEV.md W7/§4). The close-call
  warning is now in the app (done above); the remaining question is whether the
  dominant-speaker rule itself survives Tom's trial. The `excerptOf` /
  `excerpt_for` function boundary exists precisely so the rule is swappable — no
  new work until the trial verdict.
- **Inter-rater / second coder.** ~~The import/review half~~ — shipped 2026-07-15
  (Done above). What remains: a Compare panel (Browse-like tab: load another
  coder's file, see agreement/disagreement visually, maybe a crude κ).
  High analytical payoff *if the paper needs reliability numbers*; real scope.

### Coding speed & ergonomics — cheap, compounding
- **Jump between segments of the current code** (next/prev coded region) so
  reviewing one code across a transcript is a keypress, not a scroll-hunt.
- **Filter the transcript view**: show only lines carrying code X, or only
  speaker P. Search is substring-only today; a code/speaker filter is a different,
  high-use axis.
- ~~**Density minimap**~~ — shipped 2026-07-05 (Done above).

### AI assistance
- ~~**Per-speaker scope for the suggest pass.**~~ — **SHIPPED 2026-08-10.**
  "Whose speech gets coded" checkboxes in the suggest modal; unticked speakers
  (researcher unticked by default, via the speaker-map guess) are sent tagged
  [context] — visible to the model, never codeable, with a sanitize-side guard
  dropping any proposal that lands only on context lines.
- **AI-drafted code definitions.** Many codes never get a written definition,
  which weakens both the codebook as an artifact and the AI suggest pass (it
  falls back to name + exemplars). Propose a definition per code from its
  accepted excerpts — surfaced in the Assist tab or the codebook, editable, and
  only saved when the researcher finalizes it. The AI drafts; the researcher
  owns the definition.

### Known, not yet scheduled

- **`--line` contrast audit (raised 2026-08-26).** `--line` is `#e4e4e4` on white
  (**1.27:1**) and `#2c333a` in dark (**1.37:1**). WCAG 1.4.11 asks **3:1** for the
  visual boundary of a *control*, and the token is used **151 times** across 21
  stylesheets — 123 of those as some form of `border`. `base.css` already knows the
  distinction: one comment there notes that a control's own boundary needs `--muted`,
  not `--line`. Nothing is broken for a sighted user, which is exactly why it has
  survived; four separate feature reviews have now flagged it independently.

  The work is not "raise the token" — that would darken every decorative divider in
  the app and flatten a deliberate hierarchy. It is an audit: go through all 151 uses
  and sort each into
  (a) **the boundary of a control** — inputs, buttons, comboboxes, the edges that tell
  you where you may click: these owe 3:1 and should move to `--muted` or a new
  `--line-strong`;
  (b) **a divider or container edge** — card outlines, menu separators, table rules:
  decorative, 1.4.11 does not apply, `--line` is right;
  (c) **ambiguous** — a card that is also a click target, which needs a decision
  rather than a rule.
  The deliverable is that classification. Once it exists the change itself is small.
  Densest files: browse.css (35), map.css (29), about.css (17), search.css (12),
  transcript.css (11).

### Parked, deliberately (2026-08-23)
- **Per-code history.** `historyOf` in `src/provenance.ts` already walks the
  decision ledger back through a code's former names; nothing surfaces it. The
  obvious home is a "History" item in the code context menu. Parked until the
  ledger has been used on real work.
- **Decisions panel visual pass**, the left rail especially. It works and it is
  legible; it has not had a designer's eye on it.
- **Wave 3 — signals from your own coding.** Co-occurrence (which codes land on
  the same lines: the only signal made entirely of decisions you already made,
  and the one that separates "one code" from "one theme"); coverage across
  declared comparisons (a condition coded on one side and not the other); the
  codebook's own house style measured and sent with every naming request.
- **Wave 4 — the handoff into themes.** Three lenses instead of one grouping;
  a theme's claim with the excerpts that resist it; theme integrity checks.
- **Index-keyed card state.** `openCards`, `menu.halo.ci` and the card's own
  `ci` are still list indices; clusters carry a stable `cid` now. A stale index
  there costs a folded card rather than data, but it is the same class of bug
  that ate a capsule's position and, once, a neighbouring proposal.

### Codes → paper — shortens the part after coding
- **Export excerpts grouped by code** as a quote-ready doc (respecting the `[R:]`
  rule — those are researcher speech, never quotable as participant speech, per
  docs/GUIDELINES.md). Browse already assembles excerpts on screen; making that a
  file is a short hop that directly feeds writing.

### Data safety — unglamorous, real risk
- Persistence is **localStorage only**. One cleared browser profile = lost coding.
  A periodic "export reminder," or a one-click JSON snapshot to disk. Low effort,
  prevents a genuinely bad day.

### Meta / a little ironic
- The tool that studies **accessibility** isn't itself verified keyboard-/
  screen-reader-navigable. Probably not worth it for a solo internal tool — but
  worth a conscious "no" rather than an accident.

---

## Probably YAGNI (flagged deliberately)

- ~~**In-app AI code suggestions.**~~ — **overturned; shipped 2026-07 (Done
  above).** The original worry (large build, Python owns drafting) gave way once
  the Assist tab existed: suggestions land as *candidate* segments the
  researcher verdicts, so the researcher-owns-coding line held. Kept here as a
  record that a YAGNI call can expire.
- **Hierarchical codes / themes in the sidebar.** Themes live in Python today.
  A second grouping model in the app is a lot of surface for unclear gain unless
  coding actually stalls on flat codes.
- **Per-segment video clipping, regex search, richer export formats.** All real,
  none earning their complexity until you hit the wall that needs them.

---

## Decided against (with rationale)

- **Warning-badge corner (left/right) setting — HIDDEN 2026-07-05.** The
  close-call `!` badge had a Settings control to place it on the top-left or
  top-right corner of the code block. Pulled from the UI because it wasn't
  visually stable: with badges free to sit on either side, it was hard to tell
  which warning belonged to which lane block (ambiguous association, especially
  with adjacent lanes). Badge is fixed to the **right** for now. The state
  (`ui.warnCorner`) and `.ccbadge.cc-left`/`.cc-right` CSS remain, so re-adding
  the control is a one-line change if a clearer association is found (e.g. always
  the side away from the neighboring lane).

- **ShadCN UI — NO (2026-07-05).** ShadCN isn't a paste-in of plain components:
  it's coupled to **Tailwind CSS** + **Radix UI** runtime deps. That collides
  with the project's constraints (single offline hand-rolled-CSS artifact; §6
  "no UI component libraries"; "no new runtime deps without sign-off"). The
  domain components (lane bars, hover brackets, transcript virtualization,
  hotbar, command palette) get zero benefit — it would only touch the generic
  Settings/Help/menu/tooltip/combobox bits, which already work and are
  hand-tuned. Migration cost + bundle bloat (~276KB artifact today) outweighs the
  gain for a solo internal tool. The general "use ShadCN" advice targets
  greenfield dashboards/SaaS, not retrofitting a deliberately hand-rolled niche
  app.
  - **Fallback IF tool a11y ever becomes a goal** (see "Meta / ironic" above):
    adopt **Radix headless primitives only** — `@radix-ui/react-dialog` /
    `-dropdown-menu` / `-tooltip` — for the modal/menu/tooltip, keeping the
    existing CSS. Radix is unstyled and a11y-correct (focus trap, ARIA, keyboard
    nav). That's the surgical version; still weigh it against the no-new-deps
    rule. Skip Tailwind/ShadCN entirely.

---

## If picking next (recommendation, not a commitment)

1. ~~In-app close-call warnings~~ — **done.**
2. Group-by-code excerpt export (directly feeds writing).
3. localStorage snapshot/backup (cheap insurance).

## The five hook dependencies still suppressed (2026-09-01)

`npm run lint` is clean and CI gates on it, so a NEW stale dependency fails the
push. Five existing ones are suppressed in place rather than fixed, each with a
comment saying why. They are all in canvas/layout code where adding a dependency
changes when a redraw or a re-layout happens, which wants reading the code with
the map on screen — not obeying the rule:

- `CodeMapView.tsx` — the node memo (`spec.take`), two `showNodes` callbacks,
  and the viewport settle's `topicGroups.length`, which the rule calls
  unnecessary but which is plausibly what should re-settle after a regroup.
- `Minimap.tsx` — `syncFromList` and `ui`, both reached through refs precisely
  so the effect does not re-run on them. (The theme-flip bug that looked like it
  lived here did not: it was effect order in App, fixed 2026-09-01.)

The class they belong to has already bitten five times and been fixed: four
memos calling `linesOf(transcripts, lang, pid)` without `lang` (SearchBar,
CodeMapView, DescribeModal, SuggestModal), BrowseView's excerpt facets for the
same reason, and SectionsModal's token estimate missing `settled`. So these five
are worth a real pass, not a permanent shrug.
