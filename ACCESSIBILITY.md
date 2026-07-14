# Accessibility

QuAlly's reason to exist is that qualitative coding — reading a transcript closely,
line by line, for hours — is badly served by tools that assume 11px text, 10px colour
swatches, and a steady hand on a mouse.

This file is the honest ledger: what the app actually does, and what it does not do
yet. It is kept current rather than aspirational, so that the claim in the README can
be checked rather than trusted.

**Audited 2026-07-14.** Target: WCAG 2.2 AA. Not independently verified, and **not yet
tested with real low-vision users** — the most important gap on this page.

---

## What works today

### Magnification
- Transcript text **12–48px**, sidebar **11–36px**, set independently, each with a reset.
  WCAG 1.4.4 asks for 200%; from the 16px default that is 32px, so the range clears it
  with headroom. Scaling the transcript alone means the reading column doesn't shrink,
  which is what happens if you lean on browser zoom instead.
- Browser zoom (`Ctrl` `+`) works and is not hijacked — `Ctrl+0` resets it. (It *was*
  hijacked: the digit-key code handler swallowed it. Fixed.)
- The transcript's tooltips are custom and scale **with the transcript font size**;
  native tooltips are stuck at ~12px.
- The minimap's "simplified" mode enlarges its marks and enforces minimum block sizes.

### Keyboard
- Coding is fully keyboard-operable: `Tab` into the transcript, `↓`/`↑` to select a line,
  `Shift`+arrows to extend, `1`–`9` for the hotbar, `0` for the searchable palette,
  `Ctrl+Z`/`Ctrl+Shift+Z`, `Ctrl+F`, `PageUp`/`PageDown`/`Home`/`End`, `Esc` to back out.
- The selection follows the keyboard: arrowing past the viewport edge scrolls it into view.
- Every focusable control has a visible focus ring (accent + a background gap, so it
  stays visible on any ground, including a coloured lane bar).

### Not by colour alone (WCAG 1.4.1)
| Meaning | Colour channel | Non-colour channel |
|---|---|---|
| Which code a segment is | code hue | one of six **patterns** on the lane bar — **opt-in**, see the caveat below |
| Line is selected | accent tint | a **rail** down the left edge |
| Segment is rejected | faded hue | vertical **stripes** + an outline, and a `REJ` tag in Browse |
| Mixed-speaker excerpt | amber | a **`!`** badge |
| AI: likely mis-transcription | amber | **dotted** underline |
| AI: which noticing lens | lens hue | **underline style** (wavy / double / dashed / thick / boxed) |

**Caveat on code patterns.** These are a **setting, off by default** (Settings → Codes →
*Code patterns*). Solid bars scan faster for a sighted coder, so the default favours them;
turning patterns on is what makes code identity independent of hue. Strictly, that means
QuAlly does not satisfy 1.4.1 for code identity *out of the box* — it satisfies it one
toggle away. Said plainly rather than papered over. The sidebar swatch mirrors whichever
mode is on, so the mapping stays learnable either way.

### Contrast (WCAG 1.4.3)
- Body and muted text meet AA (4.5:1) in both themes. `--muted` is not decoration — it
  colours line numbers, speaker labels, timecodes and code definitions — and it was
  failing at 3.45:1 until this pass.
- Researcher rows are quieted with a dimmer *colour*, not opacity. Opacity composites
  against whatever is beneath it, and the old `opacity: .6` dragged those muted labels to
  roughly 2.6:1 — the interviewer's own labels were the least readable text on screen.
- Honours `prefers-contrast: more` and `prefers-reduced-motion: reduce`.

### Privacy (an accessibility issue too)
Nothing is uploaded. There is no account, no telemetry, and no network call at all unless
you supply your own OpenAI key and approve each request — so no assistive-technology
workaround is ever forced through someone else's server.

---

## What does NOT work yet

Listed plainly, worst first. These are real; do not read the README as claiming otherwise.

1. **Screen readers are not supported.** The transcript is a virtualized list — rows that
   are scrolled away do not exist in the DOM — and it has no `listbox`/`option` semantics,
   no `aria-selected`, and no `aria-activedescendant`. There is no `aria-live` region, so
   applying a code, undoing, or an AI scan finishing is announced to nobody. Modals have no
   `role="dialog"`, no `aria-modal`, and no focus trap. **This is the single biggest gap,
   and it is a genuinely hard one** — virtualization and screen readers are in tension.
2. **Icon-only buttons carry their names in `title` alone.** Search, undo, redo, the eye
   toggle, the video dock, the hotbar. Native tooltips are ~12px, unstyleable, and
   keyboard-inaccessible. They need real labels.
3. **In "short" speaker mode, the full name exists only in a hover tooltip.**
4. **Mouse-only interactions with no keyboard equivalent:** resizing panels and the minimap,
   dragging a segment's edge to resize it, and `Alt`-click to dismiss an AI noticing.
5. **Lane bars and the close-call badge do not scale with the transcript font size.** Set the
   text to 48px and the code lanes stay where they were, unless you separately raise the
   lane-width setting.
6. **Chrome ignores OS text-size preferences.** Toolbar, tabs, settings notes and the video
   dock are hard-coded in px, so a browser minimum-font-size or OS text scaling does nothing
   to them. Browser zoom is the only lever, and it grows everything.
7. **No high-contrast palette.** The five primaries are hue choices, not contrast choices.
   (They *do* all clear AA against the text drawn on them — teal and green were failing at
   3.96 and 4.26 and have been darkened, with a test that now blocks a regression — but
   none of them is a genuine high-contrast mode.)
8. **The minimap still encodes codes by hue alone** — it is a canvas, so the CSS patterns
   don't reach it. (Speakers *are* now on their own rail there, and it follows the
   quiet/normal/bold weight you set rather than a hardcoded "R".)
9. **The patterns that vary vertically restart at each row boundary** within a multi-line
   segment. A minor seam, but visible.
10. **Tabbing through the transcript walks every rendered timecode button.** Focusable
    timecodes are useful (play from here, no mouse), but there is no skip-past.

## If you use QuAlly with low vision

Please open an issue and tell us what breaks. The list above is what we *know* is wrong;
the useful list is the one we haven't found yet.
