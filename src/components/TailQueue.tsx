// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The thin tail, read one code at a time.
//
// Half a first-cycle codebook usually rests on a single excerpt, and the only
// way to know what those codes are is to read them. So this is a reading
// queue, not a cleanup wizard: one code per screen, its excerpts at full size,
// and four ways out. It never shows a list, because a list is what you
// accept-all your way through.
//
// The default is KEEP, and it is the fastest key. A thin code is not a fault —
// it is often the most interesting thing in the study, and the queue exists to
// make sure you saw it, not to talk you out of it. "Code more of this" is the
// outcome tools forget: thin can mean under-applied rather than unimportant,
// and that verdict sends you back to the transcripts rather than to a merge.
//
// What you decided is remembered in the ledger, which is also what keeps a
// second pass from asking again.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, liveCodes, type Decision, type Segment } from "../state/store";
import { codeStats } from "../codeStats";
import { segExcerpt } from "../contract/excerpt";
import { norm } from "../contract/segments";
import { scoreSimilar } from "../similar";
import { announce } from "../announce";
import { earcon } from "../earcons";
import { preselectBrowse } from "./BrowseView";

/** how thin is thin — the researcher's call, not the tool's */
// The rail is narrow and this ramp scales with the text setting, so the
// buttons carry the number and the label above them carries the noun.
export const TAIL_LIMITS = [
  { id: 1, label: "1", said: "One excerpt" },
  { id: 2, label: "2", said: "Two or fewer" },
  { id: 3, label: "3", said: "Three or fewer" },
] as const;
export type TailLimit = (typeof TAIL_LIMITS)[number]["id"];

/** codes this queue has already had a verdict on — the ledger is the memory */
export function triaged(ledger: Decision[]): Set<string> {
  const seen = new Set<string>();
  for (const d of ledger) {
    if (d.undone) continue;
    // every kind that constitutes "I have dealt with this code", including the
    // ones reached from elsewhere: a code merged away in the Consolidate view
    // must not turn up here afterwards
    if (["keep", "promote", "park", "merge", "delete", "remove"].includes(d.kind)) {
      d.codes.forEach((c) => seen.add(c));
    }
  }
  return seen;
}

export function tailQueue(
  codebook: Record<string, { def: string; parked?: boolean }>,
  stats: Record<string, { segs: number; pids: number }>,
  ledger: Decision[],
  limit: TailLimit,
): string[] {
  const done = triaged(ledger);
  const thin = liveCodes(codebook as never)
    .filter((c) => (stats[c]?.segs ?? 0) <= limit && !done.has(c));
  // thinnest first, so the queue front-loads the codes with least to read
  return thin.sort((a, b) => (stats[a]?.segs ?? 0) - (stats[b]?.segs ?? 0) || a.localeCompare(b));
}

export function TailSide({ limit, setLimit }: { limit: TailLimit; setLimit: (n: TailLimit) => void }) {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const ledger = useStore((s) => s.ledger);
  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const queue = useMemo(() => tailQueue(codebook, stats, ledger, limit), [codebook, stats, ledger, limit]);
  const thin = useMemo(
    () => liveCodes(codebook).filter((c) => (stats[c]?.segs ?? 0) <= limit).length,
    [codebook, stats, limit]);
  const done = thin - queue.length;
  return (
    <>
      <div className="aByLabel" id="tailLimitLabel">Thin means, at most, this many excerpts</div>
      <div className="segmented" role="group" aria-labelledby="tailLimitLabel">
        {TAIL_LIMITS.map((t) => (
          <button key={t.id} className={"seg" + (limit === t.id ? " on" : "")}
            aria-pressed={limit === t.id} aria-label={t.said} title={t.said}
            onClick={() => setLimit(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="tqProgress">
        <div className="tqBar"><span style={{ width: `${thin ? (done / thin) * 100 : 0}%` }} /></div>
        <p className="dvNote">
          {thin === 0
            ? "Nothing in the tail at this size."
            : `${done} of ${thin} read. ${queue.length} left.`}
        </p>
      </div>
      <p className="dvNote">
        A code resting on one excerpt is not a fault. This is a way to make sure
        you have seen each one, and the fastest key is the one that keeps it.
      </p>
    </>
  );
}

export function TailQueue({ limit }: { limit: TailLimit }) {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const ledger = useStore((s) => s.ledger);
  const stats = useMemo(() => codeStats(segments, transcripts), [segments, transcripts]);
  const queue = useMemo(() => tailQueue(codebook, stats, ledger, limit), [codebook, stats, ledger, limit]);
  const [folding, setFolding] = useState(false);
  const [foldQuery, setFoldQuery] = useState("");

  // The queue re-derives after every verdict — the code just decided leaves it
  // — so "the next one" is simply the front of the list. No index to keep in
  // step with a list that changes under it.
  const code = queue[0];
  useEffect(() => { setFolding(false); setFoldQuery(""); }, [code]);

  const segs = useMemo(
    () => (code ? segments.filter((s) => norm(s.code) === norm(code) && s.status === "accepted") : []),
    [segments, code]);
  const excerpts = useMemo(() => segs.map((s: Segment) => {
    const t = transcripts[s.pid];
    if (!t) return null;
    const r = segExcerpt(s, t.lines);
    return { pid: s.pid, speaker: r.speaker, text: r.excerpt };
  }).filter((x): x is { pid: string; speaker: string; text: string } => !!x && !!x.text), [segs, transcripts]);

  // Fold targets: the codes that already carry evidence, closest wording
  // first. Offered only AFTER the excerpt has been read, which is the whole
  // point of the queue — and searchable, because the nearest name is often
  // not the right home.
  const targets = useMemo(() => {
    if (!code) return [];
    const others = liveCodes(codebook).filter((c) => c !== code);
    const q = foldQuery.trim().toLowerCase();
    const ranked = others
      .map((c) => ({ c, s: scoreSimilar({ name: code, def: codebook[code]?.def ?? "" },
        { name: c, def: codebook[c]?.def ?? "" }).score }))
      .sort((a, b) => b.s - a.s || (stats[b.c]?.segs ?? 0) - (stats[a.c]?.segs ?? 0));
    return (q ? ranked.filter((x) => x.c.toLowerCase().includes(q)) : ranked).slice(0, 8).map((x) => x.c);
  }, [code, codebook, stats, foldQuery]);

  const act = useCallback((what: "keep" | "promote" | "park" | "fold", into?: string) => {
    if (!code) return;
    const st = useStore.getState();
    if (what === "fold") {
      if (!into) { setFolding(true); return; }
      // (from, into): the THIN code is the one folded away, into the one that
      // already carries the evidence
      st.mergeCode(code, into, `Folded in after reading its ${segs.length || "one"} excerpt${segs.length === 1 ? "" : "s"}`, "you");
      earcon.join();
      return;
    }
    if (what === "park") { st.setParked(code, true); earcon.evict(); return; }
    st.noteVerdict(what, code);
    earcon.accept();
  }, [code, segs.length]);

  // The keys are the queue: Enter keeps, and the other three sit under the
  // fingers already there. Live only while a card is on screen and nothing
  // else has the caret.
  useEffect(() => {
    if (!code) return;
    const onKey = (e: KeyboardEvent) => {
      // the target is whatever has focus, which is the window itself when
      // nothing does — instanceof, not a cast, or the guard throws on it
      const t = e.target;
      if (t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "Enter") { e.preventDefault(); act("keep"); }
      else if (k === "m") { e.preventDefault(); act("promote"); }
      else if (k === "f") { e.preventDefault(); act("fold"); }
      else if (k === "p") { e.preventDefault(); act("park"); }
      else if (e.key === "Escape" && folding) { e.preventDefault(); setFolding(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [code, act, folding]);

  if (!code) {
    return (
      <div className="empty">
        Nothing left in the tail at this size. Every thin code has been read and
        decided — widen what counts as thin on the left, or carry on coding.
      </div>
    );
  }
  const n = stats[code]?.segs ?? 0;
  const where = stats[code]?.pids ?? 0;
  return (
    <div className="tqCard">
      <div className="tqHead">
        <h2 className="tqName">{code}</h2>
        <button className="nBtn"
          onClick={() => { preselectBrowse([code]); useStore.getState().setActive("browse"); }}
          title="Open this code in the Codebook">See it in the Codebook</button>
      </div>
      <p className="dvNote">
        {n === 0 ? "No accepted excerpts" : `${n} excerpt${n === 1 ? "" : "s"} in ${where} transcript${where === 1 ? "" : "s"}`}
        {(codebook[code]?.def ?? "").trim() ? "" : " · no definition written"}
      </p>
      {(codebook[code]?.def ?? "").trim() && <p className="tqDef">{codebook[code].def}</p>}
      {excerpts.length === 0 ? (
        <p className="dvNote">This code has no accepted excerpt to read — it may have been coded and then rejected.</p>
      ) : excerpts.map((e, i) => (
        <blockquote key={i} className="tqEx">
          <span className="tqWho">{e.pid} · {e.speaker}</span>
          {e.text}
        </blockquote>
      ))}
      <div className="tqActs">
        <button className="nBtn pri" onClick={() => act("keep")}>Keep <kbd>↵</kbd></button>
        <button className="nBtn" onClick={() => act("promote")}>Code more of this <kbd>M</kbd></button>
        <button className="nBtn" onClick={() => act("fold")}>Fold into… <kbd>F</kbd></button>
        <button className="nBtn" onClick={() => act("park")}>Set aside <kbd>P</kbd></button>
      </div>
      {folding && (
        <div className="tqFold">
          <label className="fldRow">
            <span>Fold <b>{code}</b> into</span>
            <input autoFocus value={foldQuery} placeholder="Search your codes…"
              onChange={(e) => setFoldQuery(e.target.value)} />
          </label>
          <div className="tqTargets">
            {targets.map((t) => (
              <button key={t} className="nBtn" onClick={() => act("fold", t)}>
                {t}<span className="cnt">{stats[t]?.segs ?? 0}</span>
              </button>
            ))}
            {!targets.length && <span className="dvNote">No code matches that.</span>}
          </div>
          <button className="nBtn" onClick={() => setFolding(false)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      <p className="tqKeys">
        Keep is the default and the fastest key. Nothing here
        deletes anything: folding merges, setting aside leaves every excerpt where it is.
      </p>
    </div>
  );
}

/** the map's launcher: take me to the queue with this much of the tail in it */
export function openTailQueue(limit?: TailLimit) {
  const st = useStore.getState();
  st.setUi({ assistPanel: "tail", ...(limit ? { tailLimit: limit } : {}) });
  st.setActive("assist");
  announce("The thin tail, one code at a time");
}

