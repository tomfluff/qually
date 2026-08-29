# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a qualitative researcher doing first-cycle thematic analysis on interview
and session transcripts — reading line by line, for hours, and assigning codes. QuAlly is
a public research tool: it must be usable cold, by a stranger on the open web, with no
onboarding from the author.

Within that audience, the design is led by the needs of researchers with low vision. The
author is a low-vision researcher and is the guiding voice on visual accessibility; the
product's reason to exist is that established qualitative tools are unusable for that
reader. Sighted researchers are fully served, but never at the cost of that reader.

Device envelope: desktop first — a large screen and a physical keyboard is the real usage
scene. A tablet-sized viewport must remain usable; phone width is not a requirement.

## Product Purpose

Load a transcript, assign codes to lines, and browse every excerpt by code — in one
self-contained HTML file that runs in the browser with no server, no install, and no data
leaving the machine. Success is a researcher completing hours of real coding work in
QuAlly without the tool's presentation getting in the way of reading.

## Positioning

Accessibility is the mechanism, not a feature list. Competing tools treat magnification
and contrast as settings bolted onto a fixed presentation; QuAlly treats the researcher's
own way of seeing as the thing the interface adapts to. The transcript and the sidebar
scale independently, so growing the words does not shrink the reading column — a
neighbouring product built on a fixed layout cannot truthfully copy that.

Designed against four named failure modes of existing tools:

1. **Too small to read** — fixed ~11px text, ~10px colour swatches, chrome that eats the
   reading column the moment you zoom.
2. **Too much on screen at once** — dense panels, every affordance visible always, no way
   to abstract or hide what you are not using. Overwhelming visuals are a failure.
3. **Fixed and unpersonalizable** — no way to change typeface, size, density, or layout to
   fit how you actually see.
4. **AI that replaces the researcher** — assistance must support the analysis, never
   perform it.

## Operating Context

- Long, continuous reading sessions on a desktop screen with a physical keyboard.
- Source material arrives as a simple CSV (`line_id, timestamp, speaker, text, codes`);
  an in-app File format dialog explains it and supplies a paste-ready prompt for
  converting other transcript formats. See `DATA-FORMAT.md`.
- Work is saved by exporting a `.qually.json` project (transcripts + codebook +
  corrections) and reopening it later, or exporting everything as CSVs in a zip. Live
  state lives in browser localStorage.
- Media playback can accompany the transcript, driven from the selected line.

## Capabilities and Constraints

Confirmed functionality:

- Keyboard-first coding: arrow keys select lines, `1`–`9` apply hotbar codes, `0` opens a
  searchable palette; undo/redo, search, and media transport are all keyboard-reachable.
  Every action is reachable without a mouse today — a property to preserve, though the
  user did not mark it as a binding commitment.
- Codebook view: filter and read every excerpt for a code across all transcripts.
- Optional AI assistance, off by default, using the researcher's own OpenAI key:
  mis-transcription flags with suggested fixes, observations mapped to first-cycle coding
  methods, grounding (which words carry a code), and near-duplicate code merge proposals.
- Merge partial lines, line numbers, full/short speaker names, a resizable transcript
  minimap, near-balance speaker warnings on mixed excerpts, zen mode.
- Independent text scaling: transcript 12–48px, sidebar 11–36px, each with a reset.
- Non-colour encodings: selection rail, underline styles for AI observations, stripes and
  outlines for rejected segments, optional per-code patterns mirrored in sidebar swatches.

Technical facts (current implementation, recorded so future work does not break them
unknowingly rather than as user-declared commitments):

- React 19 + TypeScript + zustand, bundled by Vite through `vite-plugin-singlefile` into
  one inlined HTML. No CDN, no runtime backend. `npm run release` builds `docs/index.html`,
  which GitHub Pages serves.
- Atkinson Hyperlegible ships embedded in the file so it works fully offline.
- Everything is client-side; nothing is uploaded.
- Licensed GNU AGPL v3.

Terminology: *code*, *codebook*, *segment*, *excerpt*, *transcript*, *mark*,
*observation*, *grounding*, *first-cycle coding method*.

## Brand Commitments

- Name: QuAlly. Copyright Yotam Sechayk, GNU AGPL v3.
- Voice: honest and specific over promotional. `ACCESSIBILITY.md` is an explicit ledger of
  what does *not* work yet (screen-reader support in particular); README claims are
  written to be checkable rather than trusted. Future copy must hold that standard —
  never claim an accessibility property the app does not have.

## Evidence on Hand

- `README.md`, `ACCESSIBILITY.md` (audited 2026-07-14; keyboard + screen-reader pass
  2026-07-17), `DEV.md`, `FUTURE.md`, `AI-ASSIST.md`, `DATA-FORMAT.md`, `BUG-REPORT.md`.
- Live deployment: https://tomfluff.github.io/qually/
- The app is built and used by the author for real qualitative coding.

Absences that must not be fabricated: there are **no** third-party testimonials, no named
customers, no adoption or performance numbers, and **no independent accessibility audit**.
Screen-reader support is wired but untested with real screen-reader users. Broader testing
across more low-vision users and assistive technologies is the acknowledged next step and
has not happened.

## Product Principles

1. **The researcher's way of seeing is the input, not the exception.** Presentation adapts
   to the reader; the reader does not adapt to the presentation.
2. **Personalize every dimension, but ship presets too.** Anything affecting legibility —
   font, size, density, colour, pattern, layout, panel visibility — is adjustable and
   remembered. Named baseline presets exist alongside the knobs so that arriving cold does
   not mean decision fatigue or paralysis.
3. **Abstract the clutter.** Reducing what is on screen is a first-class capability, not a
   power-user escape hatch. Dense-by-default is the failure mode being designed against.
4. **The AI proposes, the researcher decides.** *(Non-negotiable.)* No AI output is ever
   applied without an explicit human accept. Optional, off by default, the user's own key.
5. **Claim only what can be checked.** Accessibility statements are a ledger, not a
   marketing surface.

## Accessibility & Inclusion

Visual accessibility for low vision is a binding, user-declared constraint, and it is
explicitly **beyond WCAG conformance** rather than satisfied by it. In the author's words:
visual clarity, personalized presentation, customizable fonts and text sizes, and
abstraction of cluttered data.

WCAG 2.2 AA is the measurable floor the project already targets — AA contrast for text in
both themes on every primary colour, visible focus rings everywhere, honouring the system
*increase contrast* and *reduce motion* settings — but meeting it does not discharge the
constraint above.

Known open gap: screen-reader support is provisional and untested with real users.
