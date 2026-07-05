# Coding App — Development Handoff & v2 Plan (React migration APPROVED)

For Claude Code (or any session) continuing work on the coding app.
Read this fully before writing code. **Decision (Tom, 2026-07-03): v2 is a
rewrite as a Vite + React + TypeScript project, built to a single standalone
HTML artifact.** Do not port v1 verbatim and then refactor, implement the v2
punch list (§3) directly as the component spec.

---

## Status — BUILT (2026-07-04)

v2 is implemented, verified, and shipped to `tools/coding-app.html` (via
`npm run release`). **The punch list in §3 (W1–W7) is DONE** — treat §3/§4/§5
below as the original spec and decision record, not a live TODO. What shipped:

- **W1–W6:** layout/typography, selection + keyboard + clipboard, hotbar dock,
  settings popover, video dock, two-pane Browse — all built.
- **W2 (items 7–8):** arrow-key selection (anchor/head model), speaker-grouped
  Ctrl+C copy.
- **W7:** excerpt rule v2 mirrored into `analysis/sync_coding.py` with a Python
  parity suite (`analysis/test_excerpt.py`) matching the vitest suite; docs
  updated (`docs/QUAL-WORKFLOW.md`).
- **Beyond the list:** undo/redo, command palette (`0`) with fuzzy code search,
  full code management (rename / edit-definition / recolor / merge / delete) via
  right-click, resizable panel dividers, connected multiline lane bars with
  hover brackets + per-line hover, segment popover copy (button + Ctrl+C).
- **Post-v2 UI additions (2026-07-04, W8 in §3):** transcript search (in-tab
  find-bar + cross-transcript "All" scope, magnifier toggle, prev/next nav);
  Help/About modal (shortcut reference + first-run onboarding); toolbar reorg
  (Import/Export · Undo/Redo divider · Settings/Help flushed right); scroll
  headroom (hatched 3rem pad before first / after last line) with
  PageUp/PageDown/Home/End list scrolling; **merge partial lines** toggle;
  **line-numbers** toggle (off by default); tabs inherit the sidebar text size
  and the Browse tab is a distinct tinted pill. New Settings controls: palette
  position (near/center), merge lines, line numbers.
- **Verified:** vitest contract + smoke + merge suites and the Python parity
  suite green; headless data-pipeline round-trip
  (import→code→export→re-import idempotent); full live browser smoke of the UI.
  Source lives in `tools/coding-app-src/`.

New change requests get appended to §3 with dates, same as before.
Unscheduled ideas / backlog live in `CODING-APP-FUTURE.md`.

---

## 1. Constraints (non-negotiable)

1. **The BUILT ARTIFACT is a single self-contained HTML file**, produced via
   `vite-plugin-singlefile` and **committed to the repo** as
   `tools/coding-app.html`. Users never need node; the artifact opens via
   `file://` offline, forever, even if the dev toolchain rots. Source lives
   in `tools/coding-app-src/` (never required at use time).
   Exception per Tom's approval: font-awesome may load from CDN for the
   hotbar refresh icon ONLY, with a text/unicode fallback so the app stays
   fully functional offline (only the icon may degrade).
2. **Toolchain pinned**: exact versions in package.json + committed lockfile
   + `.nvmrc`. `npm ci`, never bare `npm install`, when returning to the
   project after time away.
3. **The CSVs are the truth** (unchanged contract, shared with
   `analysis/sync_coding.py` and `analysis/refresh_themes_draft.py`):
   - transcript CSV: `line_id, timestamp, speaker, text, codes [, text_raw]`
   - `coded-segments.csv`: `segment_ref, pid, excerpt, code, proposed_by, status, notes`
   - `segment_ref` = `PID:start` or `PID:start-end` (contiguous ranges only)
   - inline-codes import collapses runs with EXACTLY sync_coding.py's
     semantics (per-code independent contiguous runs; overlaps legal)
   - excerpt rule: dominant speaker (see §3 W7 item 18, PROVISIONAL)
   Contract changes require mirroring the Python scripts, updating
   `docs/QUAL-WORKFLOW.md`, and a THOUGHTS entry.
4. **Transcripts are read-only** in the app. Only segments/codebook state changes.
5. Export = the COMPLETE merged coded-segments.csv (imported rows for
   unloaded transcripts pass through untouched).

## 2. Architecture

### Source layout (`tools/coding-app-src/`)

```
src/contract/            THE parity module, plain TS, no React imports:
  csv.ts                 parseCSV/toCSV (RFC4180)
  segments.ts            run-collapse, segment_ref parse/format, dedup keys,
                         alias resolution
  excerpt.ts             dominant-speaker excerpt rule ([R:] prefix, tie->P)
  __tests__/             vitest suites MIRRORING the Python fixtures
                         (see "Parity tests" below)
src/state/               store (zustand or useReducer, keep it simple),
                         undo stack, localStorage persistence
src/merge.ts             pure line-grouping for "merge partial lines" (§3 W8
                         item 23); + merge.test.ts
src/search.ts            substring match helper for transcript search (W8 item 19)
src/components/          Toolbar, Tabs, CodeSidebar, TranscriptView (rows +
                         lanes + edge-drag), HotbarDock, SettingsButton,
                         VideoDock, BrowseView, SegmentPopover, SearchBar,
                         AboutButton, CommandPalette
src/App.tsx, main.tsx
```

### Migration reference

v1 (`tools/coding-app.html`, 684-line vanilla file) stays in place until v2
reaches feature parity + punch-list completion; it is the behavioral
reference for anything §3 doesn't specify. Its verified semantics (CSV
round-trip, run-collapse parity, dedup) move into `src/contract/` tests.

### Parity tests (vitest, `npm test`)

Same fixtures as the Python side: the P07 run-collapse fixture (spans,
overlap on one line, non-contiguous same code), CSV round-trip with hostile
content (commas/quotes/newlines), alias-resolved dedup, and the five excerpt
cases of W7 item 18 (all-P, all-R with [R:], P-dominant with backchannells,
R-dominant member-check, near-tie warning). If a fixture changes, change it
in BOTH ecosystems in the same commit.

### Dev workflow

```
cd tools/coding-app-src
npm ci
npm run dev        # iterate
npm test           # contract parity suites
npm run build      # emits single-file dist/index.html
npm run release    # build + copy dist/index.html -> ../coding-app.html
```
`npm run release` output is what users get; commit it together with the
source change (never let artifact and source drift).

### Performance notes

React reconciliation handles per-row updates (v1's full-list re-render was
the known jank risk at ~1000 rows). Memoize row components on
(line, selection-membership, lane-slice). If transcripts ever exceed ~5k
lines, add react-window, not before.

## 3. v2 change requests (Tom's notes, 2026-07-03), by workstream

### W1 — Layout & typography
0. Scaffold `tools/coding-app-src/` (Vite+React+TS, pinned, singlefile
   plugin) and port the contract logic into `src/contract/` WITH the vitest
   parity suites green before any UI work.
1. **Move the coding lanes (vertical segment bars) to the RIGHT of the text
   lines** (currently left of line numbers). Row order becomes:
   line# · timecode · speaker · text · lanes.
2. **Reserve fixed width for 5 lanes** side by side (5 × bar + gaps),
   regardless of current overlap count, so text width stays stable while
   coding. >5 overlaps may scroll/squeeze, 5 is the design capacity.
3. **Uniform typography**: line numbers, timecode, speaker, and text use the
   SAME font family and size (the transcript size setting). Kill the
   0.72em/muted-size differentiation; keep color muting only.
4. **Toolbar above tabs**: reorder vertical stack to
   toolbar (import/export/settings/status) → tabs → content.
   Tabs sit DIRECTLY above the content area.
5. **Timecode as an obvious click target**: render as a chip/button with a
   play glyph, hover state; clicking seeks AND plays the video (existing
   `seekVideo`). Affordance, not just a tooltip.

### W2 — Selection, keyboard, clipboard
6. **Shift-click** = contiguous range from anchor (exists). **Ctrl-click** =
   toggle individual lines (non-contiguous selection, NEW). `applyCode`
   already splits non-contiguous selections into per-run segments, no change
   needed there, verify with the harness.
7. **Arrow keys**: with a selection active, ArrowUp selects the line before
   the first selected line, ArrowDown the line after the last.
   ⚠ OPEN QUESTION for Tom: replace the selection with that single line
   (cursor-like, current reading of the note) or EXTEND the selection?
   Recommendation: plain arrow = move (single line), Shift+arrow = extend;
   matches editor conventions. Confirm before implementing.
8. **Ctrl+C with selected lines** copies to clipboard, in line order, grouped
   by speaker runs: `"<speaker> : <line texts>"`, concatenated as
   `"S1 : ... S2 : ... S1 : ..."` when speaker changes mid-selection
   (consecutive same-speaker lines merge into one group; groups follow
   transcript order). Use `navigator.clipboard.writeText`; suppress when
   focus is in an input/textarea.

### W3 — Hotbar as a game-style bottom dock
9. **Hotbar becomes a floating, collapsible dock at the BOTTOM center**
   (Stardew/Diablo style): a row of square colored tiles, the shortcut
   number (1-9) centered in each tile; code name appears on hover, rendered
   at the SAME size as the transcript text.
10. **Refresh tile**: the LAST tile in the dock, white background, refresh
    icon centered. Note said "use font-awesome" — conflicts with constraint
    #1 (no CDN). Resolution to propose to Tom: inline the single FA rotate
    SVG path (MIT-licensed glyph, embedded, still offline). Do NOT add a CDN
    link without his explicit OK.
11. Clicking the refresh tile recomputes auto-mode slots (existing
    `hotbarCache = hotbarCodes()`); pinned mode still right-click-driven from
    the sidebar. Hotbar MODE selection moves into Settings (W4).
12. Sidebar keeps the full code list; **"+ new code" input moves to the TOP
    of the sidebar list** (above all codes).

### W4 — Settings popover
13. **Settings button in the top toolbar next to Export**, opening a popover
    with INSTANT-apply controls (no save button):
    - transcript text size (existing slider relocates here)
    - **sidebar code-list text size (its own new setting)**
    - hotbar mode (auto / pinned)
    - theme (light/dark), zen toggle can live here too (keep Esc to exit)
    All persisted in `S.ui` via existing autosave.

### W5 — Video dock behavior
14. **Collapsed state = audio continues playing**, dock shrinks to a mini
    transport bar with play/pause AND playback-speed buttons (0.75/1/1.5/2).
    Expanded state shows the video. **Remove the separate "audio-only" (♪)
    button**, collapse IS audio mode now.
15. **Aspect-ratio-locked resize** for the expanded dock: replace CSS
    `resize:both` with a custom corner-drag handle that scales width and
    derives height from the loaded video's aspect ratio (plus fixed chrome
    height). Position/size persist per session (localStorage).

### W6 — Browse view polish
16. **Codes identifiable by color everywhere in Browse** (swatch exists in
    the code list; ensure the excerpt page header and any code mentions carry
    the swatch/color too).
17. **Excerpt metadata scaling**: PID/ref/details text scales WITH the
    transcript text-size setting but always at 80% of it
    (`calc`/`em`-based, not a fixed px).

### W7 — Cross-cutting contract fixes (app + Python scripts together)
18. **(2026-07-03) Excerpt rule v2: dominant speaker (PROVISIONAL, Tom is
    trialing it).** Old R-exclusion collides with codable R lines (member
    checking: researcher summarizes, participant confirms). Tom's rule,
    adopted:
    - **Excerpt = the lines of the speaker with the most total characters in
      the segment's range** (ties -> P).
    - If the winning speaker is R, prefix the excerpt once with `[R:] `.
    - **Close-call warning** (report, not behavior): when the losing speaker
      held >=40% of the characters, sync/export warns with the segment_ref,
      Tom's assumption is that mixed-substance segments won't exist; this
      makes violations visible instead of silent.
    - Known accepted loss: the participant's short assent in member-check
      segments drops out of the excerpt (recoverable via segment_ref);
      watch during trial.
    Implementation notes: one small pure function (`excerptOf` in the app,
    `excerpt_for` in sync_coding.py), IDENTICAL logic both sides, same
    commit; harness tests for: all-P, all-R (prefix), P-dominant with R
    backchannels, R-dominant member-check, near-tie warning.
    `refresh_themes_draft.py`'s example picker should deprioritize `[R:]`
    excerpts (participant voice preferred as a code's showcase example).
    `quote-cleanup` skill note: `[R:]` excerpts are researcher speech, never
    quotable as participant speech. Update docs/QUAL-WORKFLOW.md FAQ.
    ⚠ PROVISIONAL: revisit after Tom's trial ("I have to try it out and
    see"), the function boundary exists precisely so the rule is swappable.

### W8 — Post-build change requests (Tom, 2026-07-04)

All shipped and released. UI/ergonomics only — no CSV-contract or excerpt-rule
changes, so the Python scripts and `docs/QUAL-WORKFLOW.md` are untouched.

19. **Transcript search.** In-tab find-bar (Ctrl+F) with prev/next nav and a
    cross-transcript "All" scope; magnifier toggle button. Substring match,
    highlights via `<mark>`, current occurrence emphasized. `src/search.ts`,
    `SearchBar.tsx`.
20. **Help/About modal** (`AboutButton.tsx`): keyboard-shortcut reference +
    first-run onboarding (auto-opens once, gated on `ui.helpSeen`). Standout
    accent-circle `?` button.
21. **Toolbar layout**: Import/Export · divider · Undo/Redo, with Settings and
    Help flushed right. Settings popover right-aligned so it can't clip
    off-screen.
22. **Scroll headroom**: 3rem hatched pads (`.vpad`) before the first and after
    the last line so both ends can center. PageUp/PageDown/Home/End scroll the
    virtualized list (`TranscriptView` keydown effect, virtua handle).
23. **Merge partial lines** (Settings toggle, off by default, `ui.mergeLines`):
    joins consecutive same-speaker lines where each but the last is "partial"
    (doesn't end in `. ? ! …`, trailing quotes/brackets ignored) into one
    display **unit**, never crossing a speaker change. Approved as **Tier B —
    merged units**: the unit is one selectable/codeable row (select, arrow +
    shift nav, lanes, hover brackets, search-scroll all operate at unit level),
    but it is purely a **view over lines [start..end]** — `line_id`,
    `segment_ref`, excerpts, and export stay per-line (constraint #4 intact).
    Pure grouping in `src/merge.ts` (+ `merge.test.ts`); the group-aware
    selection reduces to per-line when the toggle is off (groups are singletons).
    Known display-only fuzziness: a segment covering only part of a unit renders
    on the whole unit (true per-line ref still exported).
24. **Line-numbers toggle** (Settings, off by default, `ui.showLineNumbers`):
    hides the line-# column. When on, a merged unit shows its range (`5–6`).
25. **Tabs**: font size follows the sidebar text setting (`ui.sidebarFontSize`)
    instead of a fixed 13px. The **Browse** tab is restyled as a distinct tinted
    rounded pill with a list glyph, set apart from the square participant tabs.
26. **In-app close-call warnings.** The excerpt rule's `closeCall` flag (losing
    speaker ≥40% of chars — a mixed-substance segment) is surfaced while coding,
    not just at export: a thick amber outline (layered inset shadow, so it adds
    to a rejected segment's border rather than replacing it) around the segment's
    lane block + an amber gutter tick on the minimap + a warning line in the
    segment popover. Consumes the existing `excerptOf().closeCall`; no
    rule change. Follow-up on W7 item 18. (First item from `CODING-APP-FUTURE.md`.)
27. **Transcript minimap** (`Minimap.tsx`). Fixed-width (~56px) lane-mirror strip
    down the right edge, drawn on a `<canvas>` from the store (virtua only mounts
    visible rows). Maps by group index (the axis virtua scrolls), so nav is exact
    despite variable row heights. Accent viewport box updated imperatively on
    `onScroll` (no list re-render); click/drag calls `scrollToIndex`. Replaces the
    native transcript scrollbar (hidden via CSS); the search bar/toggle offset by
    `--mm-w` to clear it. Also user-selectable primary color (5 palettes), full/
    short speaker names, and the grouped Settings panel landed in this batch.
28. **Minimap layers + close-call polish + lane width (2026-07-05).** Minimap also
    draws a faint per-line text representation (bar width ∝ line length, dimmer for
    R) and amber close-call ticks in a left gutter. Close-call marker iterated
    emoji → amber outline → **corner `!` badge**, configurable size (xs/sm/md/lg)
    via Settings, anchored to the bar center so it overlaps at most half the block;
    it flags rejected segments too. Corner (left/right) setting was built then
    hidden (not visually stable — see `CODING-APP-FUTURE.md`). New **lane width**
    setting (xs/sm/md/lg → `--lane-w`). Ctrl+C now defers to a real text selection.
    Settings reorganized (Zen at top; Appearance / Transcript / Codes sections);
    Help modal refreshed (minimap, badge, new settings).
29. **Minimap resize + abstraction level (2026-07-05).** Minimap width is now
    drag-resizable (Resizer gained a `side="right"` mode; `ui.minimapWidth`, clamped
    44–160, drives `--mm-w` from App so the search offset tracks it; the canvas
    stretches via its ResizeObserver). New `ui.minimapDetail` toggle: **detailed**
    (per-line bars) vs **simplified** (text bucketed into speaker-tinted blocks;
    lanes/warnings widened with enforced min heights — bigger/obvious at the cost of
    pixel accuracy; codes keep their lanes, option A).

30. **Sidebar/hotbar polish + per-transcript scroll (2026-07-05).** Browse-tab
    glyph, code-list color indicator, and hotbar tooltip now scale with the sidebar
    text size (svg `em`; the square swatch became a full-height color bar; tooltip
    drop-shadow removed). Sidebar shortcut numbers styled as keycaps. Hotbar tiles
    now show 2-letter code initials (first letters of the first two non-stopword
    words) with the shortcut number as a keycap underneath; the `0` tile uses a
    library-plus glyph. Each transcript remembers its own scroll offset (ref keyed
    by pid, restored on tab switch unless a Browse→line jump is pending) — session
    scoped, not persisted across reloads.

## 4. Decisions log (was: open questions)

- **Arrow keys (item 7): APPROVED** — plain arrow moves the selection to the
  single adjacent line (up: before first; down: after last), Shift+arrow
  extends. (Tom, 2026-07-03)
- **Refresh icon (item 10): font-awesome via CDN APPROVED by Tom** — this
  amends constraint #1 for this one asset. Implement with graceful
  degradation: a plain-text/unicode fallback glyph must render when offline
  (the app must remain fully functional without network; only the icon may
  degrade).
- **Bottom real estate: APPROVED** — hotbar fixed bottom-center; video dock
  remains repositionable. Revisit only if real use shows collisions.
- **Excerpt rule (item 18): Tom's dominant-speaker rule adopted, marker
  `[R:]`, PROVISIONAL pending his trial.**
- **Merge partial lines (item 23): Tier B (merged units) APPROVED; terminators
  `. ? ! …`** (Tom, 2026-07-04). Display-only over per-line data; a unit is one
  selectable/codeable row. Tier A (continuation styling) was the lighter
  alternative, declined.
- Still open: none. New notes from Tom's continued use get appended to §3
  with dates.

## 5. Definition of done, per workstream

- `npm test` green in tools/coding-app-src (contract parity suites + new
  tests: speaker-grouped clipboard text, non-contiguous applyCode, excerpt
  rule five cases).
- `npm run release` executed; the committed tools/coding-app.html artifact
  matches the source (never drift).
- Manual smoke per the shakedown script in the chat history (import 2
  transcripts, code via all paths, export, re-sync idempotency).
- `docs/QUAL-WORKFLOW.md` §2B updated if user-visible behavior changed.
- THOUGHTS.md entry: what shipped, what's still open (skill: thoughts-log).
- Offer a checkpoint commit after each completed workstream
  (skill: version-checkpoint).

## 6. What NOT to do

- Stack is FIXED: Vite + React + TS + (zustand or useReducer) + vitest +
  vite-plugin-singlefile. No additional runtime dependencies without Tom's
  sign-off; no UI component libraries, styling stays hand-rolled CSS.
- No transcript editing features.
- No changes to segment_ref semantics or CSV columns without mirroring the
  Python scripts and getting Tom's explicit sign-off.
- Don't "improve" the visual design beyond the notes, Tom is calibrating the
  ergonomics himself, in use.
