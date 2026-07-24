# AI coding assistance — scope & decisions

Branch: `feat/ai-coding-assist`. Decided 2026-07-24 (Yotam + Claude).

The line that governs all three features: **the AI proposes, the researcher
decides.** Nothing is applied without an explicit accept. This extends the
existing promise ("marks instances, never codes") — the Welcome/README/AI-tab
copy must be updated honestly when F2/F3 ship (see "Copy changes").

Build order: **F1 → F2 → F3** (as originally listed).

## Shared infrastructure (exists today)

- `callJson` structured output, redaction, per-request approval preview
  (AiCheckModal pattern: what's sent, cost estimate), `aiLog` for the methods
  appendix, model tiers (Terra/Sol hinted for interpretive tasks).
- Segments already carry `proposedBy` + `candidate/accepted/rejected`;
  candidate lanes render striped; Accept/Reject lives in the segment popover
  and Browse. Exports carry `proposed_by` (the intercoder column).

## F1 — Grounding highlights (first)

What in a coded segment actually carries its code.

- **Call:** per segment — excerpt + code name + definition → exact quote
  spans (verbatim substrings, same guards as the scan: drop non-substrings).
- **Batch:** one run scans every accepted segment of a transcript (chunked,
  one approval).
- **Storage:** `aiGrounds: Record<sid, { hash, spans: {lineId, quote}[] }>` —
  invalidated by excerpt hash (line edit, resize, recode ⇒ stale, drops out).
- **Display (decided):** Browse excerpts emphasise the grounding quotes;
  segment popover shows them. The reading view is untouched.
- **Cost:** small — excerpts only.

## F2 — Merge near-duplicate codes (second)

- **Call:** one-shot — codebook (names, definitions) + up to N sample
  excerpts per code (token-capped) → merge proposals
  `{ from, into, rationale }`.
- **Flow:** button in Browse (the codebook's home) → approval preview →
  proposals modal → accept per pair → existing merge machinery (undoable).
  No persistent AI state; a rejected proposal is just closed.
- **Guards:** needs ≥2 codes with segments; proposals only, never auto-merge.

## F3 — Suggest codes from the researcher's own codebook (third)

- **Call:** chunked windows (like the scan) with the codebook + a few
  exemplar excerpts per code → proposed segments `{ startLine, endLine,
  code }`, existing codes ONLY (no new code invention — that stays with the
  researcher).
- **Landing (decided):** candidate segments, `proposedBy: "AI · <model
  name>"` (e.g. `AI · Terra`) — review happens in the machinery that already
  exists. Exports then support intercoder-agreement work against a machine
  second coder.
- **Rejection memory:** rejected AI candidates are remembered
  (pid+range+code key, like dismissed marks) so re-runs don't resurface them.
  Skip ranges already carrying the same code.
- **Cost:** the expensive one — window + codebook per chunk. Preview shows
  the estimate; Terra recommended in the modal hint.

## Copy changes (ship with F2/F3, not before)

- Welcome + README: "marks instances only" → "proposes — marks, merges and
  candidate codings — and applies nothing without your decision."
- AI settings intro note: same reframe, one line.
- ACCESSIBILITY.md unaffected (review flows are the existing keyboard paths).

## Out of scope (raised, deliberately not now)

- Embeddings/vector similarity (no infra, LLM judgment suffices at codebook
  scale).
- New-code invention by the AI (crosses "coding stays yours").
- In-transcript grounding underlines (revisit after F1 lands in Browse).
