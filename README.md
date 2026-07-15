# QuAlly

**Thematic analysis, made accessible.** An offline, single-file qualitative coding tool
for interview & session transcripts — built so that low vision doesn't get in the way.

Qualitative coding means reading a transcript closely, line by line, for hours. The
established tools assume you can do that at 11px, find a 10px colour swatch, and hit a
small target with a mouse. QuAlly assumes you might not.

Load a transcript, assign codes to lines with the keyboard, and browse everything by
code — all in one self-contained HTML file that runs in your browser with no server, no
install, and no data ever leaving your machine.

**→ [Open QuAlly](https://tomfluff.github.io/qually/)**  ·  Or download
[`docs/index.html`](docs/index.html) and open it locally.

## Built for low vision

- **Scale the text, not the app.** The transcript scales to **48px** and the sidebar to 36px,
  independently — so the words grow without the chrome eating your reading column. Browser
  zoom works as well, and `Ctrl+0` still resets it.
- **Choose a clearer typeface.** Set the transcript in **Atkinson Hyperlegible** — letterforms
  drawn so easily-confused characters (b/d, I/l/1, O/0) stay distinct — from Settings →
  Appearance, alongside system and serif. It ships inside the app, so it works offline.
- **Code without a mouse.** `Tab` into the transcript, `↓` to select a line, `1`–`9` to apply
  a code, `0` for the searchable palette. Every control has a visible focus ring.
- **Don't depend on colour.** A selected line gets a rail, not just a tint; AI noticings differ
  by underline style; rejected segments are striped and outlined. And if similar code colours
  are hard to tell apart, switch on **code patterns** (Settings → Codes) to give every code a
  texture as well as a hue — the sidebar swatch shows the same one, so it stays learnable.
- **Contrast meets WCAG AA** for text in both themes, on every primary colour, and the app
  honours your system's *increase contrast* and *reduce motion* settings.
- **Less to look at when you need it:** zen mode hides every panel; "merge lines" joins
  fragments into fewer, longer reading units.

Known gaps are tracked honestly in [`ACCESSIBILITY.md`](ACCESSIBILITY.md) — screen-reader
support in particular is **not** there yet.

## What it does

- **Fast keyboard coding** — number keys apply codes to the selected line(s); a hotbar and
  command palette keep your codebook a keystroke away.
- **Browse by code** — filter and read every excerpt for a code across all transcripts.
- **AI that shows, never replaces** *(optional, off by default)* — with your own OpenAI key,
  it can flag likely mis-transcriptions and highlight instances for your review (emotions,
  likes/dislikes, desires…), each mapped to a first-cycle coding method. It marks; you code.
- **Merge partial lines**, line numbers, full/short speaker names, a resizable transcript
  minimap, and "near-balance" speaker warnings on mixed excerpts.
- **Save & continue** — export a `.qually.json` project (transcripts + codebook + corrections)
  and reopen it later, or export everything as CSVs in a zip.
- **Private by default** — everything lives in your browser (localStorage); nothing is
  uploaded.

## Input format

qually reads a simple CSV (`line_id, timestamp, speaker, text, codes`). The in-app
**File format** dialog explains it and includes a ready-to-paste prompt that turns your own
transcript format into that CSV with an AI assistant. See [`DATA-FORMAT.md`](DATA-FORMAT.md).

## Develop

```bash
npm install
npm run dev        # local dev server (Vite)
npm run test       # vitest
npm run release    # build the single file -> docs/index.html (what GitHub Pages serves)
```

Stack: React 19 + TypeScript + zustand, bundled by Vite into one inlined HTML via
`vite-plugin-singlefile`. No CDN, no runtime backend. Design notes live in
[`DEV.md`](DEV.md) and [`FUTURE.md`](FUTURE.md).

## License

GNU AGPL v3 — see [`LICENSE`](LICENSE).
