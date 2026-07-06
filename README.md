# qually

**Offline, single-file qualitative coding tool for interview & session transcripts.**

Load a transcript, assign codes to lines with the keyboard, and browse everything by
code — all in one self-contained HTML file that runs in your browser with no server, no
install, and no data ever leaving your machine.

**→ [Open qually](https://tomfluff.github.io/qually/)**  ·  Or download
[`docs/index.html`](docs/index.html) and open it locally.

## What it does

- **Fast keyboard coding** — number keys apply codes to the selected line(s); a hotbar and
  command palette keep your codebook a keystroke away.
- **Browse by code** — filter and read every excerpt for a code across all transcripts.
- **Merge partial lines**, line numbers, full/short speaker names, a resizable transcript
  minimap, and "near-balance" speaker warnings on mixed excerpts.
- **Themeable** — light/dark, five primary colors, adjustable text sizes, Zen mode.
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
