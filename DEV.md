# QuAlly developer guide

QuAlly is a React 19 + TypeScript qualitative-coding app. Vite and
`vite-plugin-singlefile` build the whole application into one HTML file that can
be opened offline. The repository root is the application root; there is no
separate `tools/coding-app-src` tree and no Python parity layer.

## Commands

From the repository root:

```bash
npm ci
npm run dev        # Vite development server
npm run test       # Vitest once
npm run build      # typecheck, then build dist/index.html
npm run release    # build, then copy the artifact to docs/index.html
```

For a focused check while developing, run a test file directly, for example:

```bash
npx vitest run src/project.test.ts
npx tsc --noEmit
```

`docs/index.html` is the release artifact served by GitHub Pages. It is generated;
make source changes under `src/`, then use `npm run release` when a release artifact
is required.

## Runtime architecture

- `src/App.tsx` and `src/main.tsx` assemble and boot the application.
- `src/state/store.ts` owns project state, UI state, actions, undo/redo, imports,
  exports, and persisted-state hydration migrations.
- `src/state/persistence.ts` adapts zustand persistence to IndexedDB and handles
  save health, legacy migration, and the synchronous test fallback.
- `src/project.ts` defines and validates the explicit `.qually.json` project-file
  contract. Project export is intentionally not a dump of the zustand store.
- `src/contract/` contains the live CSV, segment-run, and excerpt rules.
- `src/components/` contains the application surfaces. Component CSS is split by
  area under `src/styles/` and imported in cascade order by `src/index.css`.
- `src/ai/` contains the optional OpenAI request, redaction, estimation, and reply
  sanitization paths. AI is off by default and is the only feature that needs a
  network.
- `src/video/`, `src/markers.ts`, `src/stretches.ts`, and the map modules contain
  the media, session-event, section, and code-map domains.
- Tests are colocated under `src/`; pure helpers deliberately exported for tests
  are part of the test seams, even when production does not import them.

The transcript uses Virtua's `VList` today; do not add a second virtualization
library. The Code map uses `@xyflow/react`. Both are already installed and exercised
by the current UI.

## Persistence and recovery

The persisted zustand project lives under `coding-app-state` in IndexedDB when the
browser provides it. Writes are throttled and flushed when the page is hidden or
unloaded. If IndexedDB is unavailable, the adapter falls back to localStorage;
localStorage is also the one-time migration source for builds that predate IndexedDB
and the synchronous storage used by tests.

Some secondary state has a separate lifetime:

- transcript scroll anchors and video-dock geometry use their own localStorage keys;
- the OpenAI key is outside the project store, in sessionStorage by default or
  localStorage only when the researcher explicitly asks the app to remember it;
- media contents are not persisted, though project metadata can remember a filename
  and offset;
- exported project files omit personal display preferences and the API key, while
  retaining study data such as speaker mappings and event colours.

Treat hydration and project-file compatibility as data-safety code. Old optional
fields must be defaulted or migrated, unknown persisted UI keys must not be carried
forward, and historical project fields that still have readers must remain readable
even after their writer UI is removed.

## Data contracts

Transcript CSV requires `line_id` and `text`; `timestamp`, `end_timestamp`,
`speaker`, and semicolon-separated `codes` are optional. Rows are sorted by numeric
line ID after validation. See `DATA-FORMAT.md` and the in-app File format dialog for
the full transcript and event formats; their duplicated conversion prompt must stay
in sync.

Coding exports use segment references of the form `PID:start` or `PID:start-end`.
Run collapse is per code over sorted line IDs, and overlapping codes are legal.
The current dominant-speaker excerpt rule lives in `src/contract/excerpt.ts` and is
covered by Vitest. There are no Python scripts to mirror.

Transcripts are editable. `editLine` records the imported wording in `Line.orig`,
supports undo/redo, and keeps corrections in project files and the edits export.
Search replacement uses the same provenance path. Segment references remain tied to
line IDs; editing wording must not silently move or delete coding.

The `.qually.json` format is the lossless handoff and backup format. Add project
fields explicitly in `Project`, export, parsing/defaulting, and tests. A newer file
version must be refused when an older build cannot interpret it safely.

## Offline and single-file constraints

- The built app must remain a self-contained HTML file with no CDN dependency or
  runtime backend.
- Fonts, icons, styles, workers, and other required assets must be inlined by the
  build. Optional AI calls may use the network only after the existing consent gate.
- Do not couple the project-file schema to incidental store shape.
- Avoid new runtime dependencies unless the capability cannot reasonably be built
  with the existing stack and the offline bundle cost is understood.

## Change and verification checklist

Keep changes scoped and preserve user data first. Comments should explain why a rule
exists, especially around persistence, undo history, accessibility, virtualization,
and import/export boundaries.

Before handoff:

1. Run the focused tests for the changed behavior.
2. Run `npx tsc --noEmit`.
3. Run `npx vitest run`.
4. For release work, run `npm run release` and verify `docs/index.html` is the
   newly generated single-file artifact.
5. Manually exercise interaction changes that unit tests cannot establish, including
   keyboard focus, pointer affordances, text scaling, and both themes where relevant.

`FUTURE.md` is the current parked-work and roadmap record. `BUG-REPORT.md` records
known defects. Neither should be treated as proof that the current tree still has a
problem: re-verify against the implementation before changing it.
