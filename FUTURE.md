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

- **(1) In-app close-call warnings — SHIPPED 2026-07-04.** The excerpt rule's
  `closeCall` flag (losing speaker held ≥40% of chars, i.e. a mixed-substance
  segment) is now surfaced while coding, not just at export: an amber dot on the
  segment's lane bar + a warning line in the segment popover. `excerptOf` already
  computed it; this only consumes it. Closes the visible half of the W7 item 18
  provisional-rule loop (the rule itself is still on trial).

---

## Candidates (unscheduled)

### Analysis rigor — highest leverage, tied to real open threads
- **Excerpt rule v2 is still PROVISIONAL** (CODING-APP-DEV.md W7/§4). The close-call
  warning is now in the app (done above); the remaining question is whether the
  dominant-speaker rule itself survives Tom's trial. The `excerptOf` /
  `excerpt_for` function boundary exists precisely so the rule is swappable — no
  new work until the trial verdict.
- **Inter-rater / second coder.** The schema already carries `proposedBy` +
  `status` (accepted/rejected/candidate) and the lanes already render rejected
  segments distinctly — that's half an IRR workflow. Import a second coder's
  `coded-segments.csv`, show agreement/disagreement visually, maybe a crude κ.
  High analytical payoff *if the paper needs reliability numbers*; real scope.

### Coding speed & ergonomics — cheap, compounding
- **Jump between segments of the current code** (next/prev coded region) so
  reviewing one code across a transcript is a keypress, not a scroll-hunt.
- **Filter the transcript view**: show only lines carrying code X, or only
  speaker P. Search is substring-only today; a code/speaker filter is a different,
  high-use axis.
- ~~**Density minimap**~~ — **SHIPPED 2026-07-05.** Lane-mirror strip on the right
  edge (`Minimap.tsx`, canvas): zoomed-out segment density, accent viewport box,
  click/drag to navigate; replaces the native transcript scrollbar.

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

- **In-app AI code suggestions.** Tempting given the paper's about AI, and
  `proposedBy` hints at it — but it's a large build and the Python side
  (`refresh_themes_draft.py`) already owns draft generation. Don't pull it into
  the app speculatively.
- **Hierarchical codes / themes in the sidebar.** Themes live in Python today.
  A second grouping model in the app is a lot of surface for unclear gain unless
  coding actually stalls on flat codes.
- **Per-segment video clipping, regex search, richer export formats.** All real,
  none earning their complexity until you hit the wall that needs them.

---

## Decided against (with rationale)

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
