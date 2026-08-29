---
target: uncommitted working-tree UI changes (sidebar header/sort chip/icon counts, Codebook View menu, .segmented, anchored add-event card, dock Mark, palette sizing)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 5
timestamp: 2026-08-17T00-35-48Z
slug: src-components
---
Method: dual-agent (A: design review · B: detector + browser evidence, both isolated sub-agents)

Target: the uncommitted working-tree UI changes (`git diff`, 36 files, +501/−291) — sidebar code list header + sort chip + icon counts, Codebook View menu, unified `.segmented` control, anchored add-event card, video dock Mark button, palette sizing.

**Working-tree moved mid-run.** Assessment B flagged concurrent edits to `AddEventModal.tsx`. I re-verified every finding against HEAD-of-worktree before writing. Two of Assessment A's originally-P0 findings are now **already fixed** and are recorded below as resolved, not as live issues.

---

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | `updateMarker` (`store.ts:1148`) never `announce()`s; `addMarker` (`:1141`) silently no-ops on a duplicate — success and refusal are the same silence. The dock's Mark button confirms nothing. |
| 2 | Match System / Real World | 3 | "Mark" (`VideoDock.tsx`) collides with the app's existing *mark* (`AboutButton`: "`M` — Open the selected line's AI mark"). Two referents, one domain word, both keyboard-bound. |
| 3 | User Control and Freedom | 3 | `safeClose` now protects a typed note from an outside click, but Escape still discards it unconditionally (`AddEventModal.tsx:52-53`), there is no Cancel button, and nothing enters undo. |
| 4 | Consistency and Standards | 2 | One state (`ui.codeSort`) driven by three control types — cycling chip, `.segmented sortseg`, native radios. Two count vocabularies coexist (icon-pair vs `{n}·{pids}`). Two tooltip systems deliberately interleaved in one row. |
| 5 | Error Prevention | 2 | `Enter` commits from a `rows={3}` textarea whose placeholder invites prose (`AddEventModal.tsx:114`). The `E` keypath omits the transcript guard the Mark button applies. |
| 6 | Recognition Rather Than Recall | 2 | The cycling `.sortchip` hides two of three orders behind an unlabeled state machine. The icon-count legend is native `title` on non-focusable `<span>`s — mouse-only, OS-sized, unscalable. |
| 7 | Flexibility and Efficiency | 3 | `E`-at-playhead and the dock Mark button are real accelerators; `ui.codeSort` persisting across three surfaces is a genuine saving. Undercut by the missing `vidPid === pid` guard on the keyboard path. |
| 8 | Aesthetic and Minimalist Design | 3 | The ~15-file copy compression is the best work in the diff. Offset by a sidebar that gained a header row and roughly doubled its per-row atom count, with no switch to hide either. |
| 9 | Error Recovery | 1 | `.ctxerr` is scoped `.ctxmenu .ctxerr` (`menu.css:37`). `AddEventModal.tsx:138` renders `<div className="ctxerr">` outside any `.ctxmenu` — the only error state in this flow paints as unstyled default body text, un-reddened, un-sized, and un-`announce()`d. **Verified live.** |
| 10 | Help and Documentation | 3 | `AboutButton` gained the `E` line. The dock's Mark button, the chip's third sort state, and the icon-count vocabulary appear in no help surface. |
| **Total** | | **24/40** | **Acceptable — significant improvements needed** |

---

## Design Specificity Verdict

**Authored in intent, category-interchangeable in execution.**

**LLM assessment.** The reasoning is legible and product-specific: the comments in `base.css:69-90`, `sidebar.css:19-43` and `events.css:96-125` read as someone who has actually sat at 32px and found the interface in the way. `codeStats.ts` unifying one sort order across three surfaces is the right instinct. `chromeFor(fs)`/`widthFor(fs)` (`AddEventModal.tsx:22-23`) and the palette's px→em conversion (`CommandPalette.tsx:32-35`) are that instinct applied to geometry.

But the visual language that emerges is the generic one. `.segmented` (`base.css:74-83`) is the stock iOS/Bootstrap segmented control: 8px radius, hairline divider, accent fill, 600 weight. `.sortchip` is the stock pill. The icon-count pair is the stock GitHub repo-row stat. Nothing in the composition says *qualitative coding*, and nothing says *low vision* — the low-vision commitment lives entirely in the token layer and the scaling maths, never in the form. Swap the words and this sidebar is a Jira backlog panel.

Three specific coherence failures:

**(a) The unification is nominal.** `.segmented` claims to be "the app's ONE 'pick one of two to four' control" (`base.css:70`). It has six behavioural forks that change flex model, wrapping, clipping, font-size and padding: `.sortseg`, `.searchscope`, `.aSuggestBy` (which *disables* the shared dividers and *reverses* the shared nowrap-and-clip), `.wseg` (which disables the shared `overflow:hidden` outright), `.fontseg`/`.loopseg`, `.aimodels`. `.aSuggestBy .seg { min-width:min(max-content,100%); overflow-wrap:anywhere }` exists *because* the base rule's `white-space:nowrap` + container `overflow:hidden` clips labels — the base rule is known-broken at large text and every site that matters patches around it. A control whose shared rule must be countermanded by every consumer has been renamed, not unified.

**(b) The justification for the three-mechanism split is false, and checkable in this repo.** `base.css:71-73` says the cycling `.sortchip` exists because "a three-way segment does not fit a 250px sidebar." `browse.css:228` styles `.defScope .seg` with its own comment reading "three segments in one narrow column" — that control lives in `browse-left`, whose resizer clamps to **160–520px** against `#sidebar`'s **160–560px** (`App.tsx:255`). Same width envelope, opposite decision.

**(c) The sidebar got denser in the panel Principle 3 says must shed density.** The code list previously had no header and one right-aligned number per row. It now has a permanent header (`CodeSidebar.tsx:86-94`) and seven visual atoms per row. "Abstract the clutter" is a stated first-class capability; there is no control anywhere to hide the counts or the header.

**Missed opportunity.** The counts are the one place this diff had real domain material — *how much evidence stands behind this code* is the central anxiety of first-cycle coding. It was rendered as two 10px stock glyphs and two 10.4px digits: the smallest type on screen, in a product whose named enemy is "too small to read."

**Deterministic scan.** `detect.mjs --json src/components` → exit 0, **clean, 0 findings**. `detect.mjs --json src` → exit 2, **2 findings**, both `slop`/`warning`, both the `side-tab` rule, both in **unmodified files** (`summary.css:43`, `transcript.css:41`) and both **false positives**: the first is a code-identity colour bar (a data channel), the second is the reserved transparent selection rail that exists precisely to avoid conveying selection by tint alone. Removing either would *create* a WCAG 1.4.1 failure. Nothing the CLI detector found is attributable to this diff.

**Browser evidence.** Live inspection succeeded against the already-running `vite preview` on `127.0.0.1:4173` (no server started, none killed; a fresh tab was opened and closed). `window.impeccableScan()` returned 15 element-findings across 6 rules. Most are false positives (the app-chrome top rule, the brand accent hue, three text-occlusions caused by the overlay the scan itself opened, "Roboto 83%" which is only the Linux fallback in `system-ui, Segoe UI, Roboto`). **One is real and this diff caused it:** `flat-type-hierarchy` enumerated **16+ distinct rendered sizes on one screen** — 12, 12.4, 12.5, 13, 13.3, 14, 15, 15.8, 16, 16.7, 17.6, 17.8, 18, 18.7, 19.8, 20.9px — the compounding cost of `.cnt{.8em}` × `.sortchip{.85em}` × `.evgrouphead{.95em}` × `.addev-hint{.92em}` layered on two independent px ramps. `npx tsc --noEmit`: clean, zero errors.

---

## Overall Impression

This diff does something genuinely hard well — it consolidates one sort order across three surfaces, and its comments reason honestly about low vision. Then it spends that credit on a segmented control that fails its own 24px hit-target floor everywhere below 14px panel text, a count badge that renders at **8.8px** at the panel minimum, and a settings refactor that quietly dropped ~40 labels from 16.9:1 to 5.33:1 contrast.

The single biggest opportunity: **the new controls are all just under the floor this product exists to clear.** Not one of them is dramatically wrong; every one of them is 1–3px or 0.5 contrast-points short. That is the signature of a refactor measured in `git diff --stat` rather than in rendered pixels. `a11y.test.ts` already knows how to compute contrast — it should be computing hit-targets and minimum rendered sizes too.

---

## What's Working

1. **`ui.codeSort` as one shared, persisted setting** (`store.ts:91,1645`; `codeStats.ts:29-44`; wired in `CodeSidebar.tsx:22,45`, `BrowseView.tsx:78`, `AssistView.tsx:103-104`). The hardest and most correct move in the diff. Removing `defSort` from `AssistView`'s `remembered` object so it *cannot* diverge is exactly right. For a researcher who orders their codebook by evidence weight, "the list is sorted the way I sort it" holding across three tabs removes a re-orientation cost that repeats every tab switch, for hours.

2. **The accent-ink contrast guarantee is real, and I verified all ten pairs.** `.seg.on` white-on-light-accent: violet 7.10, blue 5.30, teal 5.47, green 5.28, rose 5.00. `#12161a` on dark accent: violet 6.68, blue 7.21, teal 7.92, green 7.49, rose 7.23. All ten clear 4.5:1. The comment at `base.css:79-83` is accurate — though it reads as if `--accent` were one fixed lavender, when the guarantee is actually enforced by `palettes.ts:12-15` and `a11y.test.ts` across five user-selectable accents. Point the comment at the test; a future palette is the thing that would break it.

3. **The distinct-icon count pair is a net accessibility gain.** Replacing the ambiguous `"12·3"` with two different glyph shapes (`message-2` vs `notes`) plus both numbers spelled into the row's `aria-label` ("…14 excerpts in 2 transcripts") is a genuine non-colour, non-positional encoding improvement. The execution has problems (below); the idea is right.

4. **Already fixed mid-run, and worth naming.** `#sidebar { container-type:inline-size }` would have made the sidebar the containing block for the `position:fixed` code menu and the AI consent modals rendered inside it (`overflow:hidden`), clipping the app's highest-stakes surfaces to a 250px column. It is gone, replaced by `flex-wrap:wrap` and an explicit warning comment (`sidebar.css:29-33`). Likewise `AddEventModal` gained `safeClose`, an honest `aria-modal={true}`, and an IME `isComposing` guard. Both were the right calls.

---

## Priority Issues

### [P1] `.cnt` renders at 8.8px — the smallest text the app can produce, in the app whose named enemy is small text

**What.** `.cnt { font-size:.8em }` (`base.css:89`). Browser-measured: **8.8px** at the 11px panel minimum, 10.4px at the 13px default, 28.8px at the 36px maximum. `cntIcon = Math.max(10, round(sidebarFontSize * 0.8))` (`CodeSidebar.tsx`, `BrowseView.tsx`) pins the glyph at **10px** for both the 11px and 13px settings, with `.cntpair svg { opacity:.75 }` knocking it down further — contradicting `browse.css:61`'s own rule, "quiet by COLOUR, never opacity."

**Why it matters.** PRODUCT.md's failure mode #1 is verbatim "fixed ~11px text, ~10px colour swatches." At the default setting this diff ships 10.4px digits beside 10px glyphs. And `.cnt` fails AA against a hovered/selected row in the **light theme on all five palettes**: `--muted` on `--sel` measures **3.94** (violet, the default), 4.12–4.19 for the rest, against a 4.5 threshold. `--muted` was tuned against `--bg`; nothing tested it against `--sel`, which `events.css:66` puts directly under `.eventList .cnt`.

**Fix.**
```css
/* base.css:89 — .8em is below the app's own legibility floor at the panel minimum */
.cnt { color:var(--muted); font-size:.9em; font-variant-numeric:tabular-nums; flex-shrink:0; }
/* sidebar.css — quiet by colour, per the app's own rule */
.codeItem .cntpair svg { color:var(--muted); }
```
```tsx
// CodeSidebar.tsx / BrowseView.tsx — never below the app's own 11px panel floor
const cntIcon = Math.max(12, Math.round(sidebarFontSize * 0.9));
```
Darken `--muted` one step in light theme, or give `.cnt` its own `--muted-strong` token, so it clears 4.5:1 on `--sel`. Add the `--sel` pairs to `a11y.test.ts` — it already knows how to compute these.

**Suggested command:** `/impeccable typeset`

---

### [P1] Every new control lands just under the 24×24 hit-target floor — and one cannot be enlarged at all

**What.** Browser-measured with `getBoundingClientRect()`:

| Control | @ panel 11 | @ default 13 | 24×24 (SC 2.5.8 AA) |
|---|---|---|---|
| `.segmented .seg` (`padding:4px 2px`, no `min-height`) | **21px** | ≈23px | FAIL until F ≥ 14 |
| `.segmented.searchscope .seg` (`font-size:12px` **fixed**, `search.css:67`) | **≈22px** | ≈22px | **FAIL at every setting** |
| `.sortchip` (`font-size:.85em; padding:1px 8px`) | **15px** | ≈17px | FAIL until F ≈ 19 |
| `.rowMenu` (`Icon size={sidebarFontSize}`, `padding:0 5px`) | **21 × 11px** | — | FAIL until F ≥ 24 |
| `.codeItem` row (`role="button"`, the primary apply-code target) | **224 × 22.9px** | — | FAIL at minimum |
| `.set-modal .swatchbtn` (`1.375em` of a pinned 1rem) | **22 × 22px** | 22 × 22 | **FAIL at every setting** |
| `.tab .x` (this diff: bare `×` → `Icon size={round(fs*0.85)}`) | ≈21px | ≈23px | regression from ≈27px |

The spacing exception in 2.5.8 does not apply to `.segmented .seg`: `+ .seg` are edge-to-edge contiguous, so no 24px circle around one segment can avoid its neighbour.

**Why it matters.** Two of these are *unreachable by the app's own remedy*. `search.css:67` hard-codes `font-size:12px` inside "the shared control" — the search scope switch is the one control in the app that cannot be enlarged by the panel setting, a direct breach of the binding independent-scaling constraint, carried over unfixed by the very change that claimed to unify it. And `settings.css:94-95` says in its own words *"'find a 10px colour swatch' is the exact competitor failure this app exists to fix, so the swatches cannot be the one control that stays 22px forever"* — yet since dialogs were pinned to `1rem` (commit `54e174a`), `1.375em × 16px` is permanently 22px. **The comment describes behaviour the code no longer has.** The Settings dialog — the one place magnification is configured — is the one place magnification does not apply.

**Fix.**
```css
/* base.css:76 — the floor, not a suggestion */
.segmented .seg { ... padding:4px 2px; min-height:24px; }
/* search.css:67 — em, so it rides the panel ramp like every other control */
.segmented.searchscope .seg { flex:0 0 auto; padding:.3em .7em; font-size:.92em; }
/* events.css:72 — clears 24px at the 11px panel minimum */
.sortchip { ... padding:4px 10px; }
```
Give `.set-modal` its own text-scale knob, or scale `.swatchbtn` off `sidebarFontSize` rather than the pinned `1rem`. Add a hit-target assertion to `a11y.test.ts` alongside the contrast ones.

**Suggested command:** `/impeccable audit`

---

### [P1] One sort state, three control mechanisms, justified by a claim this repo disproves

**What.** `ui.codeSort` is set by a cycling chip (`CodeSidebar.tsx:89-93`), a 3-segment `.segmented sortseg` (`AssistView.tsx:742`, `DescribeModal.tsx:221`), and 3 native radio rows (`BrowseView.tsx:339-345`). `base.css:71-73` justifies the split on width; `browse.css:228` runs a three-way segment in a sidebar with the same 160–520px envelope. The chip also carries the recall cost: two of three orders are invisible, and reaching "Transcripts" from "Excerpts" means clicking past "A–Z" and re-reading the label to confirm where you landed. Its `aria-label` mutates under focus with no `announce()`, so re-announcement is AT-dependent.

**Why it matters.** Cycling controls are the canonical recognition-over-recall failure, and this one sits in a panel a researcher looks at for hours. The three-mechanism split means the same setting is learned three times.

**Fix.** Use the three-segment control the Assist sidebar already runs at the same width, with the wrapping variant that survives large text:
```tsx
// CodeSidebar.tsx:89-93 — replace the .sortchip button
<div className="segmented aSuggestBy codeSortSeg" role="radiogroup" aria-label="Sort codes">
  {SORTS.map((s) => (
    <button key={s.id} role="radio" className={"seg" + (codeSort === s.id ? " on" : "")}
      aria-checked={codeSort === s.id} onClick={() => setUi({ codeSort: s.id })}>{s.label}</button>
  ))}
</div>
```
```css
#sidebar .codeSortSeg { width:100%; margin-bottom:5px; }
#sidebar .codeSortSeg .seg { min-height:24px; }
```
Then delete or rewrite the claim at `base.css:71-73` to describe what actually remains. If the chip stays for `eventSort`, raise it to `padding:4px 10px`.

**Suggested command:** `/impeccable distill`

---

### [P1] The segmented refactor silently dropped ~40 Settings labels from 16.9:1 to 5.33:1

**What.** The old rule was `.set-modal .seg button { color: var(--fg) }`. `settings.css:78-81` removed it, deferring to `base.css:75`'s `color:var(--muted)`. Affected: every unselected option in Theme, Line numbers, Speaker names, Merge split lines, Merge by pause, Minimap, Loop while editing, Loop speed (5 cells), Reading font (3), Lane width (4), Code patterns, Mixed-speaker badge (4), Hotbar, Code palette, AI model (3).

**Why it matters.** Contrast went from ~16.9:1 (`#1a1a1a` on `#ffffff`) to **5.33:1**. That still passes AA — which is precisely the problem. PRODUCT.md states AA "is the measurable floor… but meeting it does not discharge the constraint." An unselected segment is not helper text; it is *the other choice you are about to make*. Muting it into the same register as `.settings-note` flattens the one hierarchy that matters in a settings row, in the modal a low-vision researcher visits specifically to make things legible. This is the diff's clearest case of a refactor quietly costing the guiding persona something.

Note the file's own comment explains why a naive `--fg` override was removed: it also beat `.seg.on` and printed near-black on the accent. The fix is the `:not(.on)` form the file already uses for hover.

**Fix.**
```css
/* settings.css:79 — restore the explicit ink, without beating .seg.on */
.set-modal .segmented .seg:not(.on) { color:var(--fg); }
```
Better still: make `--fg` the base `.seg` colour in `base.css:75` and let genuinely secondary contexts opt *down*, rather than the reverse.

**Suggested command:** `/impeccable polish`

---

### [P1] An unselected segment is visually indistinguishable from plain text — the border is 1.27:1

**What.** `.segmented` is bordered `1px solid var(--line)` on `background:var(--bg)` — the same colour as the page behind it. Computed non-text contrast:

| Pair | Ratio | Threshold | Verdict |
|---|---|---|---|
| `#e4e4e4` on `#ffffff` (light, on `--bg`) | **1.27** | 3.0 | **FAIL** |
| `#e4e4e4` on `#f6f6f6` (light, on `--panel`) | **1.18** | 3.0 | **FAIL** |
| `#2c333a` on `#161a1e` (dark, on `--bg`) | **1.37** | 3.0 | **FAIL** |
| `#2c333a` on `#1e242a` (dark, on `--panel`) | **1.22** | 3.0 | **FAIL** |
| `#767676` on `#ffffff` (`prefers-contrast:more`) | 4.54 | 3.0 | PASS |

**Why it matters.** WCAG 2.1 SC 1.4.11. At default settings the only thing marking an unselected segment as a *control* is a hairline at 1.27:1 — below the threshold by a factor of two. The selected half is unmistakable (accent fill at 5.00–7.10); the unselected half reads as muted body text. Same applies to `.segmented .seg + .seg` dividers and to `.sortchip { background:none; border:1px solid var(--line) }`. It clears 3:1 only when the OS `prefers-contrast: more` flag is on — a fallback, not the default path. For the guiding persona this is the difference between "two choices, one selected" and "one label with some grey words beside it."

**Fix.**
```css
/* base.css:74 — the control's own boundary needs 3:1, unlike a divider between rows */
.segmented { border:1px solid var(--muted); border-radius:8px; overflow:hidden; }
.segmented .seg + .seg { border-left:1px solid var(--muted); }
```
`--muted` gives 5.33:1 light / 6.79:1 dark. If that reads too heavy, introduce a `--line-strong` token for interactive boundaries and keep `--line` for passive rules — and add non-text pairs to `a11y.test.ts`, which currently only checks text.

**Suggested command:** `/impeccable colorize`

---

### [P2] The add-event card's only error message renders as unstyled body text

**What.** `.ctxerr` exists solely as `.ctxmenu .ctxerr` (`menu.css:37`). `AddEventModal.tsx:138` renders `<div className="ctxerr">{err}</div>` outside any `.ctxmenu`. **Verified live in the current worktree.** So an invalid timecode produces default-coloured, default-sized text with no `role="alert"`, no `aria-live`, no `aria-invalid` / `aria-describedby` link to the time field, and no `announce()`.

**Why it matters.** This is the only error state in the flow and it is invisible as an error to a sighted user scanning the card and inaudible to a screen-reader user. Heuristic 9 scores 1/4 almost entirely on this one line.

**Fix.** Unscope the rule (`menu.css:37` → `.ctxerr { color:#e0554f; font-size:.9em; padding:0 2px; }`, checking the two `Tabs.tsx` call sites still look right), add `role="alert"`, and wire `aria-invalid` + `aria-describedby` from the time input.

**Suggested command:** `/impeccable harden`

---

### [P2] The `E` keypath files events against the wrong transcript's playhead

**What.** `playheadSec()` (`src/video/seek.ts:23`) is module-global: it reads whichever `<video>` is currently registered, regardless of which transcript is active. The dock's Mark button guards this — it is hidden when `vidPid !== pid` (`VideoDock.tsx:260`). The keyboard path (`App.tsx:211-215`) has no such guard: it checks `isTranscriptView(s.active)` and an empty selection, then calls `s.setEventAt(playheadSec())`. With picture-in-picture keeping transcript A's video alive (`VideoDock.tsx:85,174`), pressing `E` on transcript B files an event against B at A's playhead.

**Why it matters.** Silent timeline corruption in the exact multi-transcript workflow the product supports, with no feedback that anything is wrong — and `addMarker` (`store.ts:1141`) also returns silently on a duplicate, so pressing `E` twice on paused media produces one event and zero acknowledgement either time.

**Fix.** Apply the dock's guard to the keyboard path, and add `announce()` to `updateMarker` (`store.ts:1148-1154`) and to `addMarker`'s dedupe early-return (`:1140`). Rename one of the two *marks* while you are there — `M` opens an AI mark, `E` files an event; the word currently means both.

**Suggested command:** `/impeccable clarify`

---

## Cognitive Load

**4 of 8 checklist items fail → HIGH cognitive load.**

| Item | Result | Evidence |
|---|---|---|
| Single focus | Pass | The add-event card is one surface with one question. |
| Chunking ≤4 per group | **FAIL** | `.codeItem` renders 7 atoms per row. The Codebook View menu renders 8 controls. |
| Grouping / proximity | Pass | `.codeHead`/`.evhead` as deliberate twins is correct; `.cbMenuGrp` headings do real work. |
| Visual hierarchy | **FAIL** | `settings.css:79` flattened *the alternative choice* into the same register as helper notes across ~40 labels. In the sidebar row the 10px icon out-weighs the 10.4px digit it labels. |
| One thing at a time | Pass | Modals remain single-purpose. |
| ≤4 visible options | **FAIL** | See list below. |
| Working memory | **FAIL** | The cycling chip requires holding "there is a third order" in memory; the icon legend must be recalled between hovers. |
| Progressive disclosure | Pass, with caveat | `.rowMenu { opacity:0 }` is the wrong kind, and contradicts `browse.css:69-71`'s own rule that hover-revealed controls are "unfindable at magnification". |

**Decision points with >4 visible options:**
1. **Codebook → View menu** (`BrowseView.tsx:326-356`): Show rejected + Bold + Wash + Underline + A–Z + Excerpts + Transcripts + Recolour codes… = **8 controls in 4 groups**, in a `min-width:180px` menu.
2. **Settings → Media → Loop speed**: **5 segments** (0.5/0.75/1/1.25/1.5×) — the shared control's own doc comment says it is for "two to four".
3. **Sidebar code row**: **7 atoms**, repeated N times down a scanning list.
4. **Settings → Coding**: five consecutive `.segmented` rows each with its own explanatory note.

---

## Emotional Journey

**Peak.** The copy pass. `"No transcripts loaded yet — import one and the AI can scan it from here."` → `"No transcripts yet. Import one to scan it."` (`AssistView.tsx:345`), and the AI-modal notes losing their lecturing clause. Empty states stopped explaining and started pointing. That is the right register for someone in hour four.

**Second peak.** `E` at the playhead → a card opens *where you were looking*, note field focused, time prefilled. A genuinely well-designed micro-flow, worth protecting.

**Valley 1.** The add-event card looks non-modal and is pointer-modal. Browser-verified: with the card open, `document.elementFromPoint(200, 80)` — far from the card, over the transcript — returns `div.about-backdrop.addev-back.anchored`. The transparent full-viewport backdrop eats clicks *and* the wheel, so the transcript the header comment says "you are still reading" can be neither clicked nor scrolled. `aria-modal={true}` now tells assistive tech the truth; the *visual* signal still lies. And Escape still discards a typed note unconditionally, with no Cancel button and no undo entry.

**Valley 2.** No reassurance where it is most needed: `updateMarker` announces nothing, `addMarker` announces nothing on a refusal, and the dock's Mark button confirms nothing. Success and refusal are the same silence.

**End state.** The last thing you touch is a full-width primary "Add event" button — a clean, unambiguous close. Good peak-end shape, undermined by the valley on the way in.

---

## Persona Red Flags

**Sam / Dr. M (low-vision researcher, hour four, 200% zoom, 32px sidebar — the guiding persona).**
- **`.cnt` renders at 8.8px** at the panel minimum — the smallest text the app can produce. It is also the only visual carrier of the excerpt/transcript counts.
- **`.segmented.searchscope .seg` is locked at `font-size:12px`** (`search.css:67`). The one control in the app that the panel-text slider cannot enlarge — a direct breach of the binding independent-scaling constraint, shipped by the change that claimed to unify the control.
- **`.set-modal` is pinned at 16px and its swatches at 22px at every setting** — measured at panel 11, 20 and 36. The one place magnification is configured is the one place it does not apply, and `settings.css:94-95` still carries a comment saying this must not happen.
- **The `.segmented` boundary is 1.27:1.** An unselected segment does not read as a control.
- **`.rowMenu` is 21 × 11px at panel 11** and hidden until hover, in a file whose own comment says hover-revealed controls are "unfindable at magnification" — and it is the one control that can delete a code.
- **`.codeItem` — the primary apply-code target — is 22.9px tall** at the panel minimum.
- **Every unselected Settings option dropped from 16.9:1 to 5.33:1.**
- **`.cnt` fails AA on a hovered row in light theme, all five palettes** (3.94–4.19:1).
- No way to turn off the new sidebar header or the count column. "Abstract the clutter" is a stated first-class capability; this diff added chrome to the densest panel with no switch.

**Alex (power user).**
- `E` on transcript B files against B using transcript A's playhead. The dock button guards it; the keyboard path does not.
- `E` twice on paused media: one event, zero feedback, both times.
- The cycling `.sortchip` costs two clicks to reach the third order and cannot be driven to a known state without reading it.
- `.rowMenu` occupies row width at every size for a button invisible until hover — ~42px of name width at 32px text.

**Riley (stress tester).**
- Type a note, press Escape: gone, no confirm, no undo. (An outside *click* is now guarded by `safeClose`; Escape is not.)
- Once you have typed, the outside-click dismissal silently stops working with no indication — only the hint line says Escape is an exit.
- The card has `max-height:604.8px` (84vh, inherited from `.about`) with **`overflow-y: visible`** — no scroll container anywhere. `.about` is `flex-direction:column`, so an over-tall card compresses the `rows={3}` textarea instead of scrolling. Nothing stops the compression.
- At panel 36 the card is **1044px wide in a 1280px viewport — 81.6% of the screen** for a control its own comment calls "a card anchored to that line, not a dimmed modal."
- An invalid timecode renders as unstyled plain body text.
- Panel 36 + code palette: `LIST_MAX = 240` and the `Math.max(120, …)` floor (`CommandPalette.tsx:36,48`) are still raw px while everything around them went em — a 1044px-wide palette showing a 240px list, roughly four rows.

---

## Minor Observations

- **Missing group semantics across ~13 Settings segmented controls** (`SettingsButton.tsx:104-290`): no `role="group"`, no `aria-labelledby`, no `aria-pressed`, no `<fieldset>`/`<legend>`. "Theme: light/dark" announces as two bare unlabelled buttons with no indication which is active. `.wseg` (`:355`) is the one that gets it right.
- **`AssistView.tsx:1014-1017`** ("Only uncoded / All") has **no `role`, no label, no `aria-pressed`** at all — selection is conveyed only by the `on` class.
- **Every other `.segmented` uses `aria-pressed`** where `role="radiogroup"` + `aria-checked` is correct — these are mutually exclusive choices, not toggles. No roving tabindex or arrow-key navigation either.
- **The Codebook View menu has a role mismatch**: the trigger declares `aria-haspopup="menu"` but the popup is `role="group"`, not `role="menu"`, with no `menuitemradio`/`menuitemcheckbox`. The native checkbox and radio rows inside it are a genuine improvement; the `<div class="cbMenuGrp">Sort codes</div>` heading is not programmatically associated with the radios.
- **The add-event card has no focus return.** Verified in-browser: after Escape, `document.activeElement` is `BODY`, not the row it was opened from. No focus trap either (explicitly documented at `:45-47`).
- **Icon counts' `title`s are unreachable**: they sit on non-focusable `<span>`s inside an `aria-hidden` subtree — mouse-hover-only, OS-sized, unscalable, which is why this app built `Tooltip.tsx`. `CodeSidebar.tsx` even sets `data-tip=""` to *suppress* the app's own scaling tooltip so the unscalable native one can appear. Use `data-tip` instead.
- **The pinned state is absent from the row's `aria-label`**, which was rebuilt in this diff and carries hotkey and counts but not pinning. `title="pinned"` on a non-focusable `<span>` is not a reliable accessible name.
- **Two count vocabularies now coexist**: `CodeSidebar` and `BrowseView` use the icon pair; `AssistView.tsx:367, :489, :779` still render `{n}·{pids}` — the very format `AssistView.tsx:486`'s new comment calls "a glance-stat, not a name". And `:367` is missing `aria-hidden="true"` (unlike `:489`), so a screen reader reads `"142·2"` as two unrelated numbers.
- **`.segmented .seg { font:inherit }` + container `overflow:hidden` + `white-space:nowrap` means labels are cut, not ellipsised.** `browse.css:173-179` and `settings.css:132-142` both exist to escape this. The shared rule should default to safe (`flex-wrap:wrap; overflow:visible`) and let the two places that need clipping opt in.
- **`.cbDot`** (`browse.css:146`) — a 6px unlabeled `aria-hidden` dot — is now the sole indicator that codes are sorted non-default. Shape-and-position-only state encoding, invisible to AT.
- **`.codeItem .cname { text-box:trim-start cap }`** is Chrome 133+/Safari 18.2+ only; Firefox keeps the old box, so row heights differ by ~2–3px between browsers — in a product shipped as one self-contained HTML file where "it looks the same everywhere" is part of the offer.
- **Three hand-tuned em constants estimate a height the browser can measure**: `chromeFor` (`AddEventModal.tsx:23`) and `CHROME`/`FULL` (`CommandPalette.tsx:34-35`). A `ref` + `getBoundingClientRect().height` after first paint removes all three and the class of bug they produce.
- **`.addev-keys`** (`events.css:106`) has `margin-left:auto` inside a `flex-wrap:wrap` row — at large panel text it wraps to its own line beneath the time, where "Esc to cancel" reads as a caption on the time field.
- **The copy pass compressed some sentences past their reason.** `SuggestModal.tsx:275`: "Applying a codebook is interpretive and this is the priciest run" → "The priciest run." The *why* was the part that made the recommendation trustworthy rather than upsell-shaped. Same at `GroundModal.tsx:166` and `MergeModal.tsx:150`. PRODUCT.md's voice commitment is "honest and specific"; this keeps it short and makes it less specific.
- **`Icon.tsx:52-62`** emits `<svg>` with no `aria-hidden="true"` and no `focusable="false"` — decorative icons inside labelled buttons can be announced as "graphic" by some AT.
- **No newly introduced colour-only encoding.** Every new state carries a second channel: `.seg.on` adds `font-weight:600`, `.sortchip`'s text names the order, `.cntpair` uses distinct glyph shapes, `.pindot` is a pin. Verified by grepping every added line in `git diff -- src/styles` for state selectors.

---

## Questions to Consider

1. `base.css:71-73` justifies three controls for one setting on a width claim that `browse.css:228` disproves. If the real reason is "a segment made the sidebar header too tall", say that — but then ask whether the header should exist. What does "Codes 12" tell a researcher that the list below it does not?
2. The sidebar code list had no header for the entire life of this product. What changed about the researcher's task — or did the sort control need a home, and the header was built to hold it?
3. `.cnt` is 8.8px at the panel floor. Would a bar whose *length* is the count — scaling with the row, needing no glyph, no digit, and no legend — serve both the persona and the scanner better than the smallest type on screen?
4. `.segmented` needs six variant overrides, two of which countermand its core `overflow:hidden` and `white-space:nowrap`. At what point does "one control with six exceptions" cost more than two honestly different controls?
5. The add-event card looks non-modal and behaves as a pointer-modal. Which do you want? If non-modal, remove the backdrop and let the transcript scroll under it. If modal, put the dim back. The current state is the only combination that lies.
6. "Mark" now means two unrelated things, both keyboard-bound (`E` files an event, `M` opens an AI mark). PRODUCT.md lists *mark* as domain terminology — which one owns the word, and what is the other called?
7. `settings.css:79` traded ~11 points of contrast on ~40 labels for cascade simplicity, and every new control landed 1–3px under the hit-target floor. `a11y.test.ts` already computes contrast ratios. What would the version that also asserts minimum rendered size, minimum hit-target, and non-text contrast on `--sel` look like — and would this diff have passed it?
