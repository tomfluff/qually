// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Consent gate for the code-suggestion run (F3 of AI-ASSIST.md) — same contract
// as the scan/ground/merge modals. Scope: ONE transcript, chunked into windows,
// each sent with the codebook (name + def + a couple of exemplars).
// Applies proposals as CANDIDATE segments (proposedBy "AI · <model>") for review;
// skips any range already carrying that code (accepted or rejected).
// Two callers, two scopes: the transcript's own code sidebar locks the scope to that
// transcript (its menu says "AI for this transcript"), while the Assist tab passes
// `choose` and picks from the corpus in here — Assist has no active transcript.
import { useEffect, useMemo, useRef, useState } from "react";
import { AI_PROPOSED_BY_PREFIX, guessQuiet, linesOf, liveCodes, useStore } from "../state/store";
import { getKey } from "../ai/key";
import { modelOf, estimateTokens, costOf, AiError, runKey } from "../ai/openai";
import { redactor } from "../ai/redact";
import { segExcerpt } from "../contract/excerpt";
import { chunksOf, renderSuggestChunk, estimateSuggestTokens, suggestChunk, overlapsExisting,
  SUGGEST_EXEMPLARS, type SuggestCode } from "../ai/suggest";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { AiModal, LangFact, ModelPicker } from "./AiModal";
import { CodePickBar, CodePickRow, type CodePick } from "./CodePicker";
import { sortCodes, type SortBy } from "../codeStats";

export function SuggestModal({ pid: initial, choose, onClose }: {
  pid?: string; choose?: boolean; onClose: () => void;
}) {
  const transcripts = useStore((s) => s.transcripts);
  const lang = useStore((s) => s.ui.lang);
  const tabs = useStore((s) => s.tabs);
  const aiLog = useStore((s) => s.aiLog);
  // `choose` shows the picker (Assist); without it the scope is whatever the caller
  // passed and can't be changed here. "" means nothing picked yet.
  const [picked, setPicked] = useState(initial ?? "");
  const pid = picked;
  const allLines = useMemo(() => linesOf(transcripts, lang, pid), [transcripts, lang, pid]);
  // Lines the researcher had selected on THIS transcript, if any. Scoping a run to
  // a passage is the point of the selection they already made; the toggle lives in
  // the gate so the payload preview, the token count and the price answer to it.
  const selection = useStore((s) => s.selection);
  const selIds = useMemo(
    () => (selection.pid === pid && selection.lines.size ? selection.lines : null),
    [selection, pid]);
  const [onlySel, setOnlySel] = useState(true);
  const scoped = !!selIds && onlySel;
  const lines = useMemo(
    () => (scoped ? allLines.filter((l) => selIds!.has(l.id)) : allLines),
    [allLines, scoped, selIds]);

  // Whose speech may CARRY a code. Every line is still sent (the exchange needs
  // its questions), but unticked speakers ride as [context] — never coded, and a
  // proposal landing only on them is dropped (sanitizeSuggestReply). Defaults to
  // the researcher unticked, by the same whole-label guess the speaker map uses;
  // per transcript, so a change of pid recomputes rather than carrying names over.
  const speakers = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLines) m.set(l.speaker.trim(), (m.get(l.speaker.trim()) ?? 0) + 1);
    return [...m.entries()];
  }, [allLines]);
  const [context, setContext] = useState<Set<string>>(() => new Set(guessQuiet([...new Set(allLines.map((l) => l.speaker.trim()))])));
  const pickPid = (p: string) => {
    setPicked(p);
    const ls = linesOf(transcripts, lang, p);
    setContext(new Set(guessQuiet([...new Set(ls.map((l) => l.speaker.trim()))])));
  };
  const toggleSpeaker = (sp: string) =>
    setContext((prev) => {
      const n = new Set(prev);
      n.has(sp) ? n.delete(sp) : n.add(sp);
      return n;
    });
  const segments = useStore((s) => s.segments);
  const codebook = useStore((s) => s.codebook);
  const ai = useStore((s) => s.ai);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; skipped: number; unusable: number; cost: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const red = useMemo(() => redactor(ai.redactTerms), [ai.redactTerms]);
  const [modelId, setModelId] = useState(ai.model);
  const model = modelOf(modelId);

  // the codebook as the model sees it: name + def + up to N exemplar excerpts (from
  // this study's accepted segments), which anchor what each code actually means
  const book = useMemo<SuggestCode[]>(() => {
    // a set-aside code is not offered to the model either — it would come
    // back as candidate codings for a code you took out of the analysis
    return liveCodes(codebook).map((name) => {
      const excerpts: string[] = [];
      for (const s of segments) {
        if (excerpts.length >= SUGGEST_EXEMPLARS) break;
        if (s.status !== "accepted" || s.code !== name || !transcripts[s.pid]) continue;
        const ex = segExcerpt(s, linesOf(transcripts, lang, s.pid)).excerpt;
        if (ex) excerpts.push(ex);
      }
      return { name, def: codebook[name]?.def ?? "", excerpts };
    });
  }, [codebook, segments, transcripts, lang]);

  // Which of them the model may propose. Defaults to ALL, so the run is what it
  // has always been until you narrow it — and narrowing is worth doing: the
  // codebook rides every window, so a run over six codes instead of sixty is a
  // fraction of the tokens as well as a narrower question.
  const [pick, setPick] = useState<Set<string> | null>(null);
  const chosen = useMemo(() => (pick ? book.filter((c) => pick.has(c.name)) : book), [book, pick]);
  // A selection is a list of NAMES, and a rename while this dialog is open
  // leaves one pointing at nothing: the code is still in the book under its new
  // name, but silently stops being part of the run. Say so rather than quietly
  // sending less than the researcher chose.
  const stale = useMemo(() => (pick
    ? [...pick].filter((n) => !book.some((c) => c.name === n))
    : []), [pick, book]);
  const [codeQuery, setCodeQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");

  // the same rows Draft definitions and Find show: colour, definition, and how
  // much evidence the code already rests on
  const rows = useMemo<CodePick[]>(() => {
    const by = new Map<string, { segs: number; pids: Set<string> }>();
    for (const s of segments) {
      if (s.status !== "accepted" || !transcripts[s.pid]) continue;
      const e = by.get(s.code) ?? { segs: 0, pids: new Set<string>() };
      e.segs++; e.pids.add(s.pid);
      by.set(s.code, e);
    }
    return book.map((c) => ({
      name: c.name, def: c.def,
      segs: by.get(c.name)?.segs ?? 0, pids: by.get(c.name)?.pids.size ?? 0,
    }));
  }, [book, segments, transcripts]);

  const shownCodes = useMemo(() => {
    const q = codeQuery.trim().toLowerCase();
    const stats = Object.fromEntries(rows.map((r) => [r.name, { segs: r.segs, pids: r.pids }]));
    return sortCodes(rows.map((r) => r.name), stats, sortBy)
      .map((n) => rows.find((r) => r.name === n)!)
      // "a ticked code stays listed" applies to an EXPLICIT selection only.
      // With the default (null = all ticked) it kept every code, so typing in
      // the filter did nothing at all until you had unticked something.
      .filter((r) => !q || pick?.has(r.name) || r.name.toLowerCase().includes(q));
  }, [rows, codeQuery, sortBy, pick, book]);

  const on = (name: string) => (pick ? pick.has(name) : true);
  const toggle = (name: string) => setPick((cur) => {
    const next = new Set(cur ?? book.map((c) => c.name));
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  // What you pick between, when the caller didn't decide: every LOADED transcript
  // (open tabs first, the store's own order for "all transcripts"), each with what
  // decides the pick — its size, whether a run already happened, and what it yielded.
  const choices = useMemo(() => {
    if (!choose) return [];
    const pids = [...tabs, ...Object.keys(transcripts).filter((p) => !tabs.includes(p))];
    return pids.filter((p) => transcripts[p]).map((p) => {
      const last = aiLog.filter((c) => c.task === "suggest" && c.pid === p).at(-1);
      return {
        pid: p, n: transcripts[p].lines.length, at: last?.at.slice(0, 10) ?? null,
        cands: segments.filter((s) => s.pid === p && s.status === "candidate").length,
      };
    });
  }, [choose, tabs, transcripts, aiLog, segments]);

  // A discontiguous selection leaves gaps, and a proposal must never bridge one
  // — the model would be answering across lines it was never shown. That used to
  // be enforced by splitting the selection into one window per run of adjacent
  // lines, which is correct and ruinously expensive: every other line selected
  // in a 300-line transcript meant 150 requests, each repeating the system
  // prompt and the whole codebook. The rule lives in sanitizeSuggestReply now
  // (`omitted`), so the selection packs normally.
  const chunks = useMemo(() => chunksOf(lines, red, context), [lines, red, context]);
  const omitted = useMemo(() => (scoped
    ? new Set(allLines.filter((l) => !selIds!.has(l.id)).map((l) => l.id))
    : undefined), [scoped, allLines, selIds]);
  const inTok = useMemo(() => chunks.reduce((n, c) => n + estimateSuggestTokens(c, chosen, red, context), 0), [chunks, chosen, red, context]);
  const redactions = useMemo(() => {
    const perBook = chosen.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0);
    const win = lines.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0);
    return perBook * chunks.length + win; // the codebook rides every chunk
  }, [chosen, lines, red, chunks.length]);
  const estCost = costOf(model, inTok, estimateTokens(" ".repeat(lines.length * 6)));
  const preview = chunks.length ? renderSuggestChunk(chunks[0].slice(0, 8), chosen, red, context) : "";
  const ready = chosen.length > 0 && lines.length > 0;

  const run = async () => {
    const key = getKey();
    if (!key) {
      const m = "No API key set. Add one in Settings → AI.";
      setErr(m); announce(m, { assertive: true }); return;
    }
    setBusy(true); setErr(null);
    announce(`Suggesting codes for ${pid} across ${chunks.length} window${chunks.length === 1 ? "" : "s"}…`);
    earcon.aiStart();
    abort.current = new AbortController();
    const by = AI_PROPOSED_BY_PREFIX + model.name;
    // stable for this run, distinct between runs: the codebook is what is
    // cached, so a run with a different book must not land on the same entry
    // OPAQUE. This string is a request field, and it was carrying the pid —
    // which is a filename the researcher chose and is very often a participant
    // identifier. Redaction never touched it, the payload preview never showed
    // it, and the gate's "redacted N" never counted it, so a transcript called
    // "Jane Doe" left the device in the clear from a dialog promising otherwise.
    // The key only has to group one run's requests, and a nonce does that.
    const cacheKey = runKey();
    let added = 0, skipped = 0, unusable = 0, cost = 0, pushed = false;
    // hoisted out of the loop so the catch can name the one chunk in flight
    let i = 0;
    try {
      for (; i < chunks.length; i++) {
        // Stop landing between chunks: the next fetch would reject as an
        // AbortError without dispatching, and the catch would then disclose
        // lines that never left. Nothing more is sent, so nothing more is logged.
        if (abort.current.signal.aborted) return;
        const { proposals, rejected, usage } = await suggestChunk({
          key, model: model.id, lines: chunks[i], codes: chosen, redaction: red, context, omitted,
          // only across a run of more than one request: a cache write bills at
          // 1.25x, so asking on a single request costs more than not asking.
          // Keyed on the run so its windows reach the same machine.
          cacheKey: chunks.length > 1 ? cacheKey : undefined,
          signal: abort.current.signal,
        });
        unusable += rejected;
        for (const p of proposals) {
          // read live each time: catches candidates added earlier in THIS run and
          // any the user accepted/added in another view during the async run
          const st = useStore.getState();
          // hasOwn, not truthiness: a code legitimately named "toString" or
            // "constructor" still resolves through Object.prototype after it is
            // deleted, so the check passed and a candidate landed for a code
            // that is no longer in the book. Parked counts as gone too — a
            // proposal for a code you set aside is one you asked not to see.
            if (!Object.hasOwn(st.codebook, p.code) || st.codebook[p.code]?.parked) { skipped++; continue; }              // code renamed/deleted mid-run
          if (overlapsExisting(st.segments, pid, p)) { skipped++; continue; }
          if (!pushed) { st.pushUndo(); pushed = true; }                  // one undo entry for the whole run
          st.addSegment(pid, p.startLine, p.endLine, p.code, by, "candidate");
          added++;
        }
        useStore.getState().logAiCall({
          at: new Date().toISOString(), model: model.id, task: "suggest", pid,
          // text AND speaker, plus the codebook that rides every chunk —
          // count what the renderer actually replaces
          lines: chunks[i].length,
          redactions: chunks[i].reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
            + chosen.reduce((n, c) => n + red.count(c.def) + c.excerpts.reduce((m, e) => m + red.count(e), 0), 0),
          inTok: usage.inTok, outTok: usage.outTok, cachedTok: usage.cachedTok, writeTok: usage.writeTok,
          costUsd: +usage.costUsd.toFixed(5),
        });
        cost += usage.costUsd;
        setProgress(i + 1);
      }
      setDone({ added, skipped, unusable, cost });
      earcon.aiDone();
      announce(`Suggestions complete: ${added} candidate coding${added === 1 ? "" : "s"} added.`);
    } catch (e) {
      // The request was dispatched, so the data left whether or not an answer
      // came back — the provenance log says so (see logAiIncomplete). Only the
      // chunk in flight: the earlier chunks logged themselves on success, and
      // the later ones never left, so logging the whole run here would count
      // the first twice and disclose the second falsely.
      const c = chunks[i];
      if (c) useStore.getState().logAiIncomplete(e, {
        model: model.id, task: "suggest", pid,
        // the SAME count the success row uses: the codebook rides every chunk,
        // so a failure row that counts only the transcript reports zero
        // redactions for a request that carried a redacted definition
        lines: c.length,
        redactions: c.reduce((n, l) => n + red.count(l.text) + red.count(l.speaker), 0)
          + chosen.reduce((n, cd) => n + red.count(cd.def) + cd.excerpts.reduce((m, e2) => m + red.count(e2), 0), 0),
      });
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      setErr(msg);
      earcon.error();
      announce(`Suggestion run failed: ${msg}`, { assertive: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AiModal title={pid ? <>Suggest codes for “{pid}”</> : <>Suggest codes</>} busy={busy} onClose={onClose}>

        {done ? (
          <>
            <div className="ai-body">
              <p className="about-lede">
                {done.added === 0
                  ? <>No new codings proposed{done.skipped > 0 && <> ({done.skipped} skipped — those ranges already carry the code)</>}.</>
                  : <>Added <b>{done.added} candidate coding{done.added === 1 ? "" : "s"}</b>
                    {done.skipped > 0 && <> ({done.skipped} skipped as already coded)</>} — review them in the{" "}
                    <b>Assist</b> tab's <b>Suggest codes</b> panel, or striped in the transcript.</>}
              </p>
              {/* A proposal the guard could not verify — a line id outside the
                  window, a code that is not in the book — is dropped, and
                  dropping it in silence reads as "nothing here". Say it, so a
                  window too wide for the model to answer accurately looks like
                  what it is rather than like an empty transcript. */}
              {done.unusable > 0 && (
                <p className="about-lede">
                  {done.unusable} answer{done.unusable === 1 ? " was" : "s were"} discarded as
                  unusable — the model named a line or a code that was not in the request.
                </p>
              )}
              <div className="imp-stats"><div>Cost: <b>${done.cost.toFixed(4)}</b> · logged to the AI log</div></div>
            </div>
            <div className="imp-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="ai-body nicescroll">
              <p className="about-lede">
                The AI reads {pid ? <b>{pid}</b> : "one transcript"} against your codebook and
                proposes where each existing code might apply. They arrive as <b>candidate
                codings</b> for you to accept or reject — it never invents a code.
              </p>
              {/* above the controls, not below them: at a normal window size this box
                  scrolled out of the scrolling body while Send stayed visible and
                  enabled -- backwards for the one sentence naming participant data */}
              {ready && (
                <div className="ai-warn">
                  <b>This sends {lines.length} {scoped ? "selected " : ""}line{lines.length === 1 ? "" : "s"} of “{pid}” plus your{" "}
                  {chosen.length}-code codebook (once per window) to OpenAI.</b> Interview transcripts
                  are participant data — make sure this is allowed by your consent form and ethics approval.
                </div>
              )}
              {choose && (
                <>
                  {/* Nothing is preselected when the caller didn't name a transcript: the
                      primary button stays disabled until you pick, so a reflex click can't
                      spend money sending the wrong participant's speech. */}
                  <div className="ai-sec">Transcript <span className="ai-sec-hint">the run reads this one, start to end</span></div>
                  <div className="ai-tlist" role="radiogroup" aria-label="Transcript to suggest codes for">
                    {choices.map((c) => (
                      <label key={c.pid} className={"ai-trow" + (picked === c.pid ? " on" : "")}>
                        <input type="radio" name="suggest-pid" checked={picked === c.pid}
                          onChange={() => pickPid(c.pid)} disabled={busy} />
                        <span className="tName">{c.pid}</span>
                        <em>{c.n} lines
                          {c.at ? ` · run ${c.at}` : " · not run yet"}
                          {c.cands > 0 ? ` · ${c.cands} candidate${c.cands === 1 ? "" : "s"}` : ""}</em>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {selIds && (
                <label className="ai-spk" style={{ margin: "8px 0" }}>
                  <input type="checkbox" checked={onlySel} onChange={() => setOnlySel((v) => !v)} />
                  <span>Only the {selIds.size} line{selIds.size === 1 ? "" : "s"} you selected{" "}
                  <em>suggestions land only there, and the rest of {pid} is not sent</em></span>
                </label>
              )}
              <ModelPicker modelId={modelId} onPick={setModelId} />

              {stale.length > 0 && (
                <div className="settings-note" role="alert">
                  {stale.length === 1
                    ? <>You picked <b>{stale[0]}</b>, and it has since been renamed or removed —
                      it is not in this run.</>
                    : <>{stale.length} codes you picked have since been renamed or removed and are
                      not in this run: {stale.join(", ")}.</>}
                </div>
              )}
              {book.length > 0 && (
                <>
                  <div className="ai-sec">Codes the AI may propose{" "}
                    <span className="ai-sec-hint">all of them unless you narrow it</span></div>
                  <input className="findName" value={codeQuery} disabled={busy}
                    placeholder="Filter codes…" aria-label="Filter the code list by name"
                    onChange={(e) => setCodeQuery(e.target.value)} />
                  <CodePickBar sortBy={sortBy} onSort={setSortBy} disabled={busy} onPick={[
                    { label: "All", run: () => setPick(null) },
                    { label: "None", run: () => setPick(new Set()) },
                  ]}>
                    <span className="tMeta">{chosen.length} of {book.length}</span>
                  </CodePickBar>
                  <div className="ai-cbox" role="group" aria-label="Codes the AI may propose">
                    {shownCodes.length === 0 && (
                      <p className="settings-note" style={{ margin: "6px 8px" }}>
                        No code matches “{codeQuery.trim()}”.
                      </p>
                    )}
                    {shownCodes.map((c) => (
                      <CodePickRow key={c.name} code={c} color={codebook[c.name]?.color ?? ""}
                        on={on(c.name)} disabled={busy} onToggle={() => toggle(c.name)} />
                    ))}
                  </div>
                </>
              )}
              {/* every line still goes (the exchange needs its questions); unticking
                  only stops a speaker's lines from CARRYING a code */}
              {pid && speakers.length > 1 && (
                <>
                  <div className="ai-sec">Whose speech gets coded{" "}
                    <span className="ai-sec-hint">unticked speakers are sent as context, never coded</span></div>
                  <div className="ai-spks">
                    {speakers.map(([sp, n]) => (
                      <label key={sp} className="ai-spk">
                        <input type="checkbox" checked={!context.has(sp)} onChange={() => toggleSpeaker(sp)} disabled={busy} />
                        <span>{sp} <em>{n}</em></span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {!ready ? (
                <p className="about-lede" style={{ marginTop: 10 }}>
                  {book.length === 0
                    ? "Your codebook is empty — add some codes first, and the AI can suggest where they apply."
                    : !pid
                      ? "Pick a transcript above and the payload, the token count and the price appear here."
                      // the codes are all unticked: a run with nothing to propose
                      // FROM is not a transcript with nothing in it, and saying
                      // the latter sends you looking in the wrong place
                      : chosen.length === 0
                        ? "No codes ticked — the AI has nothing to propose from. Tick at least one above."
                        : "This transcript has no lines to scan."}
                </p>
              ) : (
                <>
                  <div className="ai-payload">
                    <div className="ai-payload-head">
                      <span className="eyebrow">Exactly what leaves your device</span>
                      <span className="ai-model">{model.id}</span>
                    </div>
                    <pre className="nicescroll">{preview}{chunks[0].length > 8 || chunks.length > 1 ? "\n…" : ""}</pre>
                    {/* the box is headed "exactly what leaves your device" and shows
                        ONE request; with variable packing two singleton chunks used to
                        render with no ellipsis and no hint that more was going */}
                    {chunks.length > 1 && (
                      <p className="ai-payload-more">First of <b>{chunks.length}</b> requests — the rest carry the same shape.</p>
                    )}
                  </div>
                  <div className="ai-facts">
                    <span>lines <b>{lines.length}</b></span>
                    <span>codes <b>{chosen.length}</b></span>
                    <span>windows <b>{chunks.length}</b></span>
                    <span>redacted <b>{redactions}</b></span>
                    <span>≈ <b>{inTok.toLocaleString()}</b> tokens</span>
                    <span>≈ <b>${estCost.toFixed(4)}</b></span>
                    <LangFact />
                  </div>
                  {model.id.includes("luna") && (
                    <div className="settings-note" style={{ marginTop: 6 }}>
                      The priciest run. <b>Terra</b> usually codes better than Luna. Pick it above.
                    </div>
                  )}
                </>
              )}
            </div>

            {err && <div className="ai-err">{err}</div>}

            {!ready ? (
              <div className="imp-actions">
                {chosen.length > 0 && !pid && <button className="btn primary" disabled>Pick a transcript</button>}
                <button className="btn" onClick={onClose}>Close</button>
              </div>
            ) : (
              <div className="imp-actions">
                <button className="btn primary" onClick={run} disabled={busy}>
                  {busy ? `Suggesting… ${progress}/${chunks.length}` : `Send ${chunks.length} request${chunks.length === 1 ? "" : "s"} to OpenAI`}
                </button>
                <button className="btn" onClick={() => { abort.current?.abort(); onClose(); }}>
                  {busy ? "Stop" : "Cancel — send nothing"}
                </button>
              </div>
            )}
          </>
        )}
    </AiModal>
  );
}
