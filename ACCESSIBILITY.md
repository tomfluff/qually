# Accessibility

QuAlly's reason to exist is that qualitative coding — reading a transcript closely,
line by line, for hours — is badly served by tools that assume 11px text, 10px colour
swatches, and a steady hand on a mouse.

This file is the honest ledger: what the app actually does, and what it does not do
yet. It is kept current rather than aspirational, so that the claim in the README can
be checked rather than trusted.

**Audited 2026-07-14; keyboard + screen-reader pass 2026-07-17.** Target: WCAG 2.2 AA.
Built and used by a low-vision researcher
(the author) for real qualitative coding — but not independently audited, and **broader
testing across more low-vision users and assistive technologies** is still the most
valuable next step.

---

## What works today

### Magnification
- Transcript text **12–48px**, sidebar **11–36px**, set independently, each with a reset.
  WCAG 1.4.4 asks for 200%; from the 16px default that is 32px, so the range clears it
  with headroom. Scaling the transcript alone means the reading column doesn't shrink,
  which is what happens if you lean on browser zoom instead.
- Browser zoom (`Ctrl` `+`) works and is not hijacked — `Ctrl+0` resets it. (It *was*
  hijacked: the digit-key code handler swallowed it. Fixed.)
- Tooltips are custom and app-wide (one shared bubble, portaled above every panel, so
  nothing clips it) and scale **with the sidebar text size**, opening on keyboard focus
  as well as hover; native tooltips are stuck at ~12px.
- The minimap's "simplified" mode enlarges its marks and enforces minimum block sizes.

### Reading font
- The transcript and Browse excerpts can be set to **Atkinson Hyperlegible** (Braille
  Institute, SIL OFL), a face drawn so easily-confused letters (b/d, I/l/1, O/0) stay
  distinct. It ships embedded in the file — no CDN — so it works fully offline. System
  and serif are the other options; the chrome stays on the system font either way.
- The segment popover (click a lane bar) now scales with the **sidebar** text size, so
  its notes and buttons grow with the rest of the panel chrome.

### Keyboard
- Coding is fully keyboard-operable: `Tab` into the transcript, `↓`/`↑` to select a line,
  `Shift`+arrows to extend, `1`–`9` for the hotbar, `0` for the searchable palette,
  `Ctrl+Z`/`Ctrl+Shift+Z`, `Ctrl+F`, `PageUp`/`PageDown`/`Home`/`End`, `Esc` to back out,
  `Enter` to play the loaded media from the selected line, `Space` to play/pause it and
  `[`/`]` to change its speed (all three stand down while typing), `M` to open the selected
  line's AI mark (apply its suggested fix when one is offered, or dismiss it; pressing
  again cycles the line's marks).
- So is everything around the coding: tabs switch and close from the keyboard; sidebar
  and Browse code rows apply on `Enter`; every code-management action (rename, recolor,
  merge, pin, delete) is reachable through a per-row `⋯` button (or `Shift+F10` — on
  hotbar tiles too), not right-click alone; a segment's lane bar is a real button — `Enter` opens its popover
  (notes, reject, delete, copy); panel dividers resize with arrow keys; search results
  are focusable and `Enter` jumps.
- The selection follows the keyboard: arrowing past the viewport edge scrolls it into view.
- Every focusable control has a visible focus ring (accent + a background gap, so it
  stays visible on any ground, including a coloured lane bar).

### Screen readers (new, and honestly provisional)
Wired in this pass; **not yet tested with real screen-reader users**, which is the next
most valuable thing anyone could do for this project:
- The transcript is a `listbox` with `option` rows (`aria-selected`,
  `aria-setsize`/`aria-posinset`, `aria-activedescendant` following the selection head).
  The list is virtualized, so rows scrolled far away genuinely do not exist in the DOM;
  set-size/position keep the counts truthful and the active row is always rendered while
  you drive it, but a screen reader's own document-cursor walk will only see the
  rendered window. This is the compromise, stated plainly.
- A polite live region announces the things the eye gets for free: a code applied
  ("Coded lines 8 to 10 as workarounds"), undo/redo, segment status changes and
  deletions, import results, search-match position, AI-scan completion.
- Every modal is a labelled `role="dialog"` with `aria-modal`, a focus trap, and focus
  restoration to the opener. Popovers (segment editor, code menu, AI mark, color picker,
  settings) are labelled dialogs too, and `Esc` always closes and hands focus back
  (in the code menu's sub-forms it steps back to the menu first).
- Every icon-only control carries an accessible name; the tab strip is a `tablist`;
  the hotbar a labelled `toolbar`; code rows announce as "Apply code …, hotkey n,
  k segments" instead of a soup of child text; the code inputs are proper comboboxes;
  the minimap (a visual duplicate of the list) is hidden from the tree.
- In "short" speaker mode the full name rides along visually hidden, so a screen
  reader never gets stuck with the three-letter label.

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

1. **Screen-reader support is wired but unproven.** The semantics, names, live
   announcements, and focus management described above are new and have been verified
   only against the accessibility tree and by keyboard simulation — not by an actual
   NVDA/JAWS/VoiceOver user doing real coding. Virtualization remains a structural
   tension: rows scrolled far away do not exist in the DOM, so document-cursor browsing
   sees a window, not the whole transcript. Treat "supported" as unearned until someone
   who relies on a screen reader has coded a real transcript with it.
2. **Mouse-only interactions with no keyboard equivalent:** dragging a segment's edge to
   resize it (the popover has no range editor yet) and the minimap (navigation duplicate;
   keyboard has Home/End/PageUp and back-to-selection). `Alt`-click dismissal of an AI
   mark left this list: `M` now opens the selected line's mark popover, which carries
   the dismiss (and apply-fix) buttons.
3. **Lane bars and the close-call badge do not scale with the transcript font size.** Set the
   text to 48px and the code lanes stay where they were, unless you separately raise the
   lane-width setting.
4. **Chrome ignores OS text-size preferences.** Toolbar, tabs, settings notes and the video
   dock are hard-coded in px, so a browser minimum-font-size or OS text scaling does nothing
   to them. Browser zoom is the only lever (the toolbar now wraps instead of clipping at
   high zoom), and it grows everything.
5. **No high-contrast palette.** The five primaries are hue choices, not contrast choices.
   (They *do* all clear AA against the text drawn on them — teal and green were failing at
   3.96 and 4.26 and have been darkened, with a test that now blocks a regression — but
   none of them is a genuine high-contrast mode.)
6. **The minimap still encodes codes by hue alone** — it is a canvas, so the CSS patterns
   don't reach it. (Speakers *are* now on their own rail there, and it follows the
   quiet/normal/bold weight you set rather than a hardcoded "R". It is now hidden from
   screen readers as a duplicate view.)
7. **The patterns that vary vertically restart at each row boundary** within a multi-line
   segment. A minor seam, but visible.

## If you use QuAlly with low vision

Please open an issue and tell us what breaks. The list above is what we *know* is wrong;
the useful list is the one we haven't found yet.
