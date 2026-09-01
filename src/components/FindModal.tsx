// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// F8 of AI-ASSIST.md: find passages across the corpus.
//
// Every other AI read in this app is anchored to one transcript. This one flips
// the axis — say what you are looking for, then say where to look — which makes
// it the first run that can span a whole study, and the consent gate carries
// that weight: the cost is broken down per transcript, because one total hides
// which file is expensive.
//
// Two ways to say what you are looking for, ONE landing. Both produce candidate
// codings, reviewed in the machinery that already exists:
//
//   by code     — one or more codes from the codebook. The saturation question:
//                 "where else does this apply?" Goes through ai/suggest.ts, which
//                 already answers exactly this for one transcript.
//   by question — a name and a description for something NOT in the codebook yet.
//                 The researcher writes both, so the code is theirs before the
//                 model reads a line: F3's rule that the AI never invents a code
//                 is kept by construction rather than by a guard.
//
// The second mode deliberately does not invent a third kind of object. An
// earlier draft had "findings" living in their own list with their own dismissal
// memory and their own export column. Naming the thing you are looking for is
// what a codebook entry IS — a name and a definition — so a question search is a
// code search for a code that does not exist yet, and everything downstream
// (the worklist, accept/reject, rejection memory, undo, exports, the ledger)
// works without knowing this feature happened.
import { useEffect, useMemo, useRef, useState } from "react";
import { linesOf, liveCodes, useStore, guessQuiet, type Line } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { norm } from "../contract/segments";
import { chunksOf, estimateSuggestTokens, renderSuggestChunk, suggestChunk,
  overlapsExisting, SUGGEST_EXEMPLARS, type SuggestCode } from "../ai/suggest";
import { findChunksOf, estimateFindTokens, renderFindChunk, findChunk } from "../ai/find";
import { lineSize, WINDOW_PACK } from "../ai/pack";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";
import { CodePickBar, CodePickRow, type CodePick } from "./CodePicker";
import { sortCodes, type SortBy } from "../codeStats";

/** Whose speech may carry a hit, ride along as context, or not be sent at all.
    The third state is not a cost control: it is the only way to keep a
    speaker's words off the wire, which is a consent question. */
type Voice = "code" | "context" | "exclude";

// Opened from the Assist panel (a button that is always there) and from any
// code's own menu (which unmounts the row that opened it). The host captures
// whatever was focused BEFORE the dialog attaches — by the time the modal is
// mounted its own first control has already taken focus and the opener is no
// longer recoverable, which is how a menu-launched dialog drops a keyboard user
// on <body> when it closes. Same pattern, and same reason, as DefineHost.
let openFn: ((codes?: string[]) => void) | null = null;
export function openFind(codes?: string[]) { openFn?.(codes); }

export function FindHost() {
  const [open, setOpen] = useState<{ codes: string[] } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openFn = (codes) => {
      opener.current = document.activeElement as HTMLElement | null;
      setOpen({ codes: codes ?? [] });
    };
    return () => { openFn = null; };
  }, []);
  if (!open) return null;
  return (
    <FindModal initialCodes={open.codes} onClose={() => {
      setOpen(null);
      // The opener is often ALREADY GONE: from a code's menu it is the menu item,
      // which unmounts with the menu in the same commit this dialog mounts. So
      // fall back to a home the way useMenuFocus does, rather than leaving a
      // keyboard user on <body> with Tab restarting from the top of the page.
      if (opener.current?.isConnected) { opener.current.focus(); return; }
      document.querySelector<HTMLElement>(
        ".cbList, .cbSide, .sideList, .codeList, [role=listbox], .mapCanvas")?.focus();
    }} />
  );
}

export function FindModal({ initialCodes = [], onClose }: {
  initialCodes?: string[]; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const lang = useStore((s) => s.ui.lang);
  const ai = useStore((s) => s.ai);
  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  const [mode, setMode] = useState<"codes" | "question">("codes");
  // Every transcript ticked to start with. SuggestModal deliberately preselects
  // NOTHING, "so a reflex click can't spend money" — waived here on purpose,
  // because the corpus IS the point of this run and an empty selection would
  // make the common case a chore. What keeps the principle is that Send always
  // carries the request count, and the per-transcript rows say where it comes
  // from before anything is sent.
  const [pids, setPids] = useState<Set<string>>(() => new Set(Object.keys(transcripts)));
  const [focus, setFocus] = useState<Set<string>>(() => new Set(initialCodes));
  const [codeQuery, setCodeQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; skipped: number; unusable: number; cost: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const runSeq = useRef(0);
  // Send disables itself the instant it is pressed, so the focused element
  // vanishes and focus falls to <body> — and the dialog's trap listens on the
  // dialog, so Tab then walks the page BEHIND an aria-modal dialog for the whole
  // run. Hand focus to whatever replaced it: Stop while running, Done at the end.
  const stopRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (busy) stopRef.current?.focus(); }, [busy]);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);
  useEffect(() => () => abort.current?.abort(), []);

  const all = useMemo(() => Object.keys(transcripts).sort(), [transcripts]);
  const chosen = useMemo(() => all.filter((p) => pids.has(p)), [all, pids]);

  // One speaker setting across the whole selection, keyed by label. Speakers are
  // consistent between files of a study far more often than not (P and R), and a
  // per-transcript matrix would be a grid to operate at a large text size for a
  // distinction almost nobody draws. A label absent from a transcript simply
  // does not apply there.
  const voices = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of chosen) {
      for (const l of linesOf(transcripts, lang, p)) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [chosen, transcripts, lang]);
  const [voice, setVoice] = useState<Record<string, Voice>>({});
  // Default the interviewer to context by the same whole-label guess the speaker
  // map uses. Recomputed as the selection grows, but never over a choice already
  // made — changing what a researcher set is worse than leaving a new label at
  // its default.
  useEffect(() => {
    const quiet = new Set(guessQuiet(voices.map(([s]) => s)));
    setVoice((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const [s] of voices) {
        if (next[s]) continue;
        next[s] = quiet.has(s) ? "context" : "code";
        changed = true;
      }
      return changed ? next : cur;
    });
  }, [voices]);

  const context = useMemo(
    () => new Set(Object.entries(voice).filter(([, v]) => v === "context").map(([s]) => s)), [voice]);
  const excluded = useMemo(
    () => new Set(Object.entries(voice).filter(([, v]) => v === "exclude").map(([s]) => s)), [voice]);

  // The codebook as the model reads it — definitions plus a couple of real
  // excerpts to anchor each code's meaning.
  //
  // The exemplars are DRAWN FROM SCOPE, which SuggestModal does not have to
  // worry about because it only ever reads one transcript. Here the scope is a
  // choice the researcher made, and an exemplar is participant speech: pulling
  // one from the whole project would send quotes out of transcripts they did not
  // tick, and out of the mouth of a speaker they set to "not sent", inside the
  // codebook that rides every request. The gate promises what leaves; this is
  // what makes the promise true rather than nearly true.
  const bookFor = useMemo(() => (names: string[]): SuggestCode[] => names.map((n) => {
    const ex: string[] = [];
    for (const s of segments) {
      if (s.status !== "accepted" || s.code !== n) continue;
      if (!pids.has(s.pid) || !transcripts[s.pid]) continue;          // only where they chose to look
      const ls = linesOf(transcripts, lang, s.pid);
      // and never a quote whose speech they withheld
      if (ls.some((l) => l.id >= s.start && l.id <= s.end && excluded.has(l.speaker.trim()))) continue;
      const e = segExcerpt(s, ls).excerpt;
      if (e) ex.push(e);
      if (ex.length === SUGGEST_EXEMPLARS) break;
    }
    return { name: n, def: codebook[n]?.def ?? "", excerpts: ex };
  }), [segments, transcripts, lang, codebook, pids, excluded]);

  // In question mode the code does not exist yet, so it has no excerpts to
  // anchor it — the researcher's own description is the whole definition, which
  // is why the field is not optional.
  const codes = useMemo<SuggestCode[]>(() => (mode === "codes"
    ? bookFor([...focus])
    : [{ name: name.trim(), def: about.trim(), excerpts: [] }]), [mode, focus, bookFor, name, about]);

  // ONE construction, used by the estimate, the preview and the request. They
  // were built separately and differed by the trim, so the gate previewed bytes
  // that were not quite the bytes that left.
  const question = `${name.trim()}\n${about.trim()}`;

  // Per transcript: the lines that will actually be sent, and how they pack.
  const perPid = useMemo(() => chosen.map((p) => {
    const lines = linesOf(transcripts, lang, p).filter((l) => !excluded.has(l.speaker.trim()));
    // A transcript where every remaining speaker is context-only cannot yield
    // anything: the sanitizer drops a hit made only of background speech, so the
    // request would be paid for and its answer thrown away. Not sent at all.
    const omitted = new Set(linesOf(transcripts, lang, p)
      .filter((l) => excluded.has(l.speaker.trim())).map((l) => l.id));
    const usable = lines.some((l) => !context.has(l.speaker.trim()));
    if (!usable) return { pid: p, lines: [] as Line[], chunks: [] as Line[][], tok: 0, usable, omitted };
    // Withholding a speaker leaves GAPS, and a range must never span one — that
    // would code speech the researcher deliberately kept off the wire. The first
    // version enforced it by BREAKING the window at every gap, which is correct
    // and ruinous: withholding an interleaved speaker turned 150 surviving lines
    // into 150 one-line requests, each paying the full system prompt and prefix
    // — 3 requests and 7.8k tokens became 150 and 70k, for half the transcript.
    // The rule now lives in the sanitizer (`omitted`), where it costs nothing,
    // and the prompt tells the model ids may skip. The window stays whole.
    const chunks = mode === "codes"
      ? chunksOf(lines as Line[], red, context)
      : findChunksOf(lines as Line[], red, context);
    const tok = chunks.reduce((n, c) => n + (mode === "codes"
      ? estimateSuggestTokens(c, codes, red, context)
      : estimateFindTokens(c, question, red, context)), 0);
    return { pid: p, lines, chunks, tok, usable, omitted };
  }), [chosen, transcripts, lang, excluded, mode, red, context, codes, question]);

  const requests = requestCount(perPid);
  const inTok = perPid.reduce((n, x) => n + x.tok, 0);
  const sentLines = perPid.reduce((n, x) => n + x.lines.length, 0);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(sentLines * 6)));
  // What the STABLE half of each request substitutes — the codebook in one mode,
  // the researcher's own name and description in the other. Defined once so the
  // gate, the success row and the failure row cannot disagree about it.
  const askedRedactions = useMemo(() => (mode === "codes"
    ? codes.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0)
    : red.count(question)), [mode, codes, red, question]);
  const redactions = useMemo(() => perPid.reduce((n, x) =>
    n + x.lines.reduce((m, l) => m + red.count(l.text) + red.count(l.speaker), 0), 0)
    // the stable half rides EVERY request, so the gate counts it per request
    + askedRedactions * requestCount(perPid), [perPid, red, askedRedactions]);

  // A single line whose own rendered size passes the hard cap is still sent —
  // dropping it would lose coverage — but it goes alone and may not fit the
  // model's context. packRun names these; nothing was surfacing them, so the
  // gate enabled Send on a request that could only fail after consent.
  const oversize = useMemo(() => perPid.flatMap((x) =>
    x.lines.filter((l) => lineSize(l, red, context) > WINDOW_PACK.hardCap)
      .map((l) => `${x.pid}:${l.id}`)), [perPid, red, context]);

  const first = perPid.find((x) => x.chunks.length);
  const preview = !first ? ""
    : mode === "codes"
      ? renderSuggestChunk(first.chunks[0].slice(0, 6), codes, red, context)
      : renderFindChunk(first.chunks[0].slice(0, 6), question, red, context);

  // Every live code with what it rests on. Counts come from ACCEPTED segments
  // in loaded transcripts, the same basis the Draft-definitions list uses, so
  // the two dialogs cannot disagree about how big a code is.
  const rows = useMemo<CodePick[]>(() => {
    const by = new Map<string, { segs: number; pids: Set<string> }>();
    for (const s of segments) {
      if (s.status !== "accepted" || !transcripts[s.pid]) continue;
      const e = by.get(s.code) ?? { segs: 0, pids: new Set<string>() };
      e.segs++; e.pids.add(s.pid);
      by.set(s.code, e);
    }
    return liveCodes(codebook).map((name: string) => ({
      name, def: codebook[name]?.def ?? "",
      segs: by.get(name)?.segs ?? 0, pids: by.get(name)?.pids.size ?? 0,
    }));
  }, [segments, transcripts, codebook]);

  const shown = useMemo(() => {
    const q = codeQuery.trim().toLowerCase();
    const stats = Object.fromEntries(rows.map((r) => [r.name, { segs: r.segs, pids: r.pids }]));
    const order = sortCodes(rows.map((r) => r.name), stats, sortBy);
    // a ticked code is always listed, whatever the filter says — narrowing the
    // list must never hide a choice already made
    return order.map((n) => rows.find((r) => r.name === n)!)
      .filter((r) => !q || focus.has(r.name) || r.name.toLowerCase().includes(q));
  }, [rows, codeQuery, focus, sortBy]);

  const named = name.trim().length > 0 && about.trim().length > 0;
  // norm() is the store's collision rule (trim, collapse spaces, lowercase), so
  // a raw lookup let "Giving Up" through beside an existing "giving up" and
  // ensureCode then had to reconcile two names for one code.
  const clash = mode === "question"
    && Object.keys(codebook).some((c) => norm(c) === norm(name));
  const ready = chosen.length > 0 && requests > 0
    && (mode === "codes" ? focus.size > 0 : named && !clash);

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null); setProgress(0);
    announce(`Searching ${chosen.length} transcript${chosen.length === 1 ? "" : "s"} across ${requests} request${requests === 1 ? "" : "s"}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    const by = `AI · ${model.name}`;
    const cacheKey = `find:${model.id}:${runSeq.current++}`;
    // The code is the researcher's, written before the model read anything —
    // created here so a hit has somewhere to land, and left behind empty if the
    // search finds nothing, exactly like any code they make and never use.
    let added = 0, skipped = 0, unusable = 0, cost = 0, pushed = false, sent = 0;
    let label = mode === "codes" ? null : name.trim();
    if (label) {
      // Up front, not on the first hit: the claim this feature rests on is that
      // the code is yours before the model reads a line. Made here, a search
      // that finds nothing leaves an empty code behind — the same thing that
      // happens whenever anyone makes a code and does not use it, and far
      // better than the name they typed vanishing.
      const st = useStore.getState();
      st.pushUndo(); pushed = true;
      // one step: setDef pushes an undo of its own, so creating and defining
      // separately made the run two entries with a def-less code between them
      // the CANONICAL name: createDefined resolves "giving   up" onto an
      // existing "Giving Up" and returns that, and coding under the raw string
      // would land segments on a codebook key that does not exist
      label = st.createDefined(label, about.trim());
    }
    let job: { pid: string; chunk: Line[] } | null = null;
    try {
      for (const t of perPid) {
        for (const c of t.chunks) {
          if (abort.current.signal.aborted) return;
          job = { pid: t.pid, chunk: c };
          let props: { startLine: number; endLine: number; code: string }[];
          let rejected: number, usage;
          if (mode === "codes") {
            const r = await suggestChunk({
              key, model: model.id, lines: c, codes, redaction: red, context, omitted: t.omitted,
              cacheKey: requests > 1 ? cacheKey : undefined, signal: abort.current.signal,
            });
            props = r.proposals; rejected = r.rejected; usage = r.usage;
          } else {
            const r = await findChunk({
              key, model: model.id, lines: c, question,
              redaction: red, context, omitted: t.omitted,
              cacheKey: requests > 1 ? cacheKey : undefined, signal: abort.current.signal,
            });
            props = r.hits.map((h) => ({ startLine: h.startLine, endLine: h.endLine, code: label! }));
            rejected = r.rejected; usage = r.usage;
          }
          unusable += rejected;
          for (const p of props) {
            const st = useStore.getState();
            if (!pushed) { st.pushUndo(); pushed = true; }   // one undo entry for the whole run
            if (!st.codebook[p.code]) { skipped++; continue; }   // renamed or deleted mid-run
            if (overlapsExisting(st.segments, t.pid, p)) { skipped++; continue; }
            st.addSegment(t.pid, p.startLine, p.endLine, p.code, by, "candidate");
            added++;
          }
          useStore.getState().logAiCall({
            at: new Date().toISOString(), model: model.id, task: "find", pid: t.pid,
            lines: c.length,
            redactions: c.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0) + askedRedactions,
            inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
            costUsd: +usage.costUsd.toFixed(5),
          });
          cost += usage.costUsd;
          setProgress(++sent);
        }
      }
      setDone({ added, skipped, unusable, cost });
      earcon.aiDone();
      announce(`Search complete: ${added} candidate coding${added === 1 ? "" : "s"} added.`);
    } catch (e) {
      // Only the request in flight: the earlier ones logged themselves on
      // success and the later ones never left, so logging the whole run here
      // would count the first twice and disclose the second falsely.
      if (job) useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "find", pid: job.pid,
        lines: job.chunk.length,
        redactions: job.chunk.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
          + askedRedactions,
      });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg); earcon.error();
      announce(`Search failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title="Find passages across transcripts" busy={busy} onClose={onClose}>
      {done ? (
        <>
          <div className="ai-body">
            <p className="about-lede">
              {done.added === 0
                ? <>Nothing new found{done.skipped > 0 && <> ({done.skipped} already coded)</>}.
                  {mode === "question" && <> <b>{name.trim()}</b> is in your codebook.</>}</>
                : <>Added <b>{done.added} candidate coding{done.added === 1 ? "" : "s"}</b>
                  {done.skipped > 0 && <> ({done.skipped} already coded)</>} — review them in{" "}
                  <b>Assist → Suggest codes</b>.</>}
            </p>
            {done.unusable > 0 && (
              <p className="about-lede">
                {done.unusable} unusable answer{done.unusable === 1 ? "" : "s"} discarded.
              </p>
            )}
            <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
          </div>
          <div className="imp-actions">
            <button ref={doneRef} className="btn primary" onClick={onClose}>Done</button>
            {/* naming before seeing evidence is the cost of this mode; undoing
                that has to be one gesture from here, not a hunt in the codebook */}
            {done.added === 0 && mode === "question" && !!useStore.getState().codebook[name.trim()] && (
              <button className="btn" onClick={() => { useStore.getState().deleteCode(name.trim()); onClose(); }}>
                Delete “{name.trim()}”
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="ai-body nicescroll">
            {sentLines > 0 && (
              <div className="ai-warn">
                <b>This sends {sentLines.toLocaleString()} lines from {chosen.length} transcript
                {chosen.length === 1 ? "" : "s"} to OpenAI.</b> Interview transcripts are participant
                data — make sure this is allowed by your consent form and ethics approval.
              </div>
            )}

            {/* role=group with aria-pressed, not a radiogroup: role="radio"
                promises arrow-key navigation and a roving tabindex, and a
                keyboard user who presses Down on a radio that does not move
                concludes the control is broken. Same pattern as AssistView's
                segmented controls, which make no promise they cannot keep. */}
            <div className="segmented findMode" role="group" aria-label="What to look for">
              <button className={"seg" + (mode === "codes" ? " on" : "")}
                aria-pressed={mode === "codes"} disabled={busy} onClick={() => setMode("codes")}>
                Codes I already have
              </button>
              <button className={"seg" + (mode === "question" ? " on" : "")}
                aria-pressed={mode === "question"} disabled={busy} onClick={() => setMode("question")}>
                Something new
              </button>
            </div>

            {mode === "codes" ? (
              <>
                <div className="eyebrow">Look for</div>
                {Object.keys(codebook).length === 0 ? (
                  <p className="about-lede">Your codebook is empty — switch to <b>Something new</b> to
                    describe what you are looking for.</p>
                ) : (
                  <>
                    {/* A real codebook runs to a hundred-odd codes, and a bare
                        checkbox list of those is a scroll hunt. Ticked codes are
                        always shown, whatever the filter, so narrowing the list
                        can never hide a choice already made. */}
                    <input className="findName" value={codeQuery} disabled={busy}
                      placeholder="Filter codes…" aria-label="Filter the code list by name"
                      onChange={(e) => setCodeQuery(e.target.value)} />
                    {/* with a filter on, the ticked codes may be the only thing
                        NOT on screen — say how many are picked, and offer the
                        way back without hunting for them */}
                    {/* the same bar as Draft definitions: bulk picks on the
                        left, sort on the right, ticks surviving a re-sort */}
                    <CodePickBar sortBy={sortBy} onSort={setSortBy} onPick={[
                      { label: "All shown", run: () => setFocus(new Set(shown.map((c) => c.name))) },
                      { label: "None", run: () => setFocus(new Set()) },
                    ]}>
                      {focus.size > 0 && <span className="tMeta">{focus.size} picked</span>}
                    </CodePickBar>
                  <div className="ai-cbox" role="group" aria-label="Codes to look for">
                    {shown.length === 0 && (
                      <p className="settings-note" style={{ margin: "6px 8px" }}>
                        No code matches “{codeQuery.trim()}”.
                      </p>
                    )}
                    {shown.map((c) => (
                      <CodePickRow key={c.name} code={c} color={codebook[c.name]?.color ?? ""}
                        on={focus.has(c.name)} onToggle={() => setFocus((f) => {
                          const n = new Set(f); n.has(c.name) ? n.delete(c.name) : n.add(c.name); return n;
                        })} />
                    ))}
                  </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="eyebrow">Look for</div>
                {/* Name and description, because that IS a codebook entry. The
                    code is made before the model reads anything, so nothing it
                    returns can have named it. */}
                <input className="findName" value={name} disabled={busy} placeholder="Name it, e.g. giving up"
                  aria-label="Name for what you are looking for" onChange={(e) => setName(e.target.value)} />
                <textarea className="sumCtx" value={about} disabled={busy} rows={3}
                  aria-label="Describe what you are looking for"
                  placeholder="Describe it — where a participant stops trying, abandons a task, or says it is not worth it."
                  onChange={(e) => setAbout(e.target.value)} />
                {clash && (
                  <div className="settings-note" role="alert">
                    <b>{name.trim()}</b> is already in your codebook — switch to{" "}
                    <b>Codes I already have</b> and tick it, or give this one another name.
                  </div>
                )}
                {/* The app has a second free-text box — Assist → Ask — with a
                    different contract: Ask answers FROM work already coded, this
                    reads the raw transcript. Two question boxes that behave
                    differently is a trap, so each says which it is. */}
                <p className="settings-note">
                  Kept as a code of your own; hits land under it as candidates.
                  <em> Ask answers from work you have already coded — this reads the transcripts.</em>
                </p>
              </>
            )}

            <div className="eyebrow">Where to look</div>
            <div className="ai-tlist" role="group" aria-label="Transcripts to search">
              {all.map((p) => {
                const row = perPid.find((x) => x.pid === p);
                return (
                <label key={p} className={"ai-trow" + (pids.has(p) ? " on" : "")}>
                  <input type="checkbox" checked={pids.has(p)} disabled={busy}
                    onChange={() => setPids((s) => {
                      const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n;
                    })} />
                  <span className="tName">{p}</span>
                  {/* per transcript, not just a total: this is the one run that
                      can span a study, and one number hides which file is dear */}
                  <span className="tMeta">
                    {row?.chunks.length
                      ? <>{row.chunks.length} request{row.chunks.length === 1 ? "" : "s"} ·{" "}
                        {row.tok.toLocaleString()} tokens</>
                      /* every speaker in it is context-only or withheld, so the
                         guard would drop any hit — sending it would cost money
                         for an answer that cannot be used */
                      : <em>nothing to search</em>}
                  </span>
                </label>
                );
              })}
            </div>
            <div className="ai-rowbtns">
              <button className="btn" disabled={busy} onClick={() => setPids(new Set(all))}>All</button>
              <button className="btn" disabled={busy} onClick={() => setPids(new Set())}>None</button>
            </div>

            {voices.length > 0 && (
              <>
                <div className="eyebrow">Whose speech</div>
                {/* A native select, not a button cycling three states. This is
                    one-of-three, which is what a select IS: it announces the
                    change on pick (a cycling button changes its own name and a
                    screen reader may never say so), it has the platform's own
                    keyboard handling, and it grows with browser zoom without
                    any of this code knowing. */}
                <div className="ai-voices">
                  {voices.map(([s, n]) => (
                    <label key={s} className={"voice " + (voice[s] ?? "code")}>
                      <span className="vName">{s}</span>
                      <span className="vN">{n} lines</span>
                      <select value={voice[s] ?? "code"} disabled={busy}
                        aria-label={`What to do with ${s}'s speech`}
                        onChange={(e) => setVoice((v) => ({ ...v, [s]: e.target.value as Voice }))}>
                        <option value="code">searched</option>
                        <option value="context">context only</option>
                        <option value="exclude">not sent</option>
                      </select>
                    </label>
                  ))}
                </div>
              </>
            )}

            <ModelPicker modelId={modelId} onPick={setModelId} disabled={busy} />

            {requests > 0 && (
              <>
                <div className="ai-payload">
                  <div className="ai-payload-head">
                    <span className="eyebrow">Exactly what leaves your device</span>
                    <span className="ai-model">{model.id}</span>
                  </div>
                  <pre className="nicescroll">{preview}{"\n…"}</pre>
                  <p className="ai-payload-more">
                    First of <b>{requests}</b> request{requests === 1 ? "" : "s"} across{" "}
                    <b>{chosen.length}</b> transcript{chosen.length === 1 ? "" : "s"}.
                  </p>
                </div>
                <div className="ai-facts">
                  <span>lines <b>{sentLines.toLocaleString()}</b></span>
                  <span>requests <b>{requests}</b></span>
                  <span>redacted <b>{redactions}</b></span>
                  <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                  <span>≈ <b>${estCost.toFixed(4)}</b></span>
                  <LangFact />
                </div>
              </>
            )}
          </div>

          {oversize.length > 0 && (
            <div className="ai-warn" role="alert">
              <b>{oversize.length === 1 ? "One line is" : `${oversize.length} lines are`} too long to fit
              a request</b> ({oversize.slice(0, 3).join(", ")}{oversize.length > 3 ? "…" : ""}).
              {oversize.length === 1 ? " It goes" : " Each goes"} in a request of its own and may be
              refused by the model. Splitting {oversize.length === 1 ? "it" : "them"} in the transcript
              is the fix.
            </div>
          )}

          {err && <div className="ai-err">{err}</div>}

          <div className="imp-actions">
            <button className="btn primary" onClick={run} disabled={busy || !ready}>
              {busy ? `Searching… ${progress}/${requests}`
                : ready ? `Send ${requests} request${requests === 1 ? "" : "s"} to OpenAI`
                  : mode === "codes" && !focus.size ? "Pick at least one code"
                    : mode === "question" && !named ? "Name it and describe it"
                      : !chosen.length ? "Pick at least one transcript"
                        /* transcripts ARE picked; every speaker in them is
                           context-only, so nothing in them can be a hit */
                        : "Set at least one speaker to searched"}
            </button>
            <button ref={stopRef} className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
              {busy ? "Stop" : "Cancel — send nothing"}
            </button>
          </div>
        </>
      )}
    </AiModal>
  );
}

const requestCount = (per: { chunks: unknown[] }[]) => per.reduce((n, x) => n + x.chunks.length, 0);

