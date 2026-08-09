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
- **Per-speaker scope for the suggest pass.** The observation scan lets you
  untick speakers before sending; suggest sends every line. A modal option so
  researcher lines ride along as context but are never themselves coded
  (tagged in the window + a sanitize-side guard).
- **AI-drafted code definitions.** Many codes never get a written definition,
  which weakens both the codebook as an artifact and the AI suggest pass (it
  falls back to name + exemplars). Propose a definition per code from its
  accepted excerpts — surfaced in the Assist tab or the codebook, editable, and
  only saved when the researcher finalizes it. The AI drafts; the researcher
  owns the definition.

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
