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
// make sure you saw it, not to talk you out of it.
//
// Three ways out, each of which does something. A fourth — "code more of this"
// — recorded an intention and changed nothing, and nobody could say how it
// differed from Keep, which is the test a verdict has to pass in a queue you
// work at speed.
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
    // verdicts about a code that goes on existing: dealt with, do not re-ask.
    // "remove" belongs here — rejecting a code's excerpts leaves the code in
    // the book with none, which is exactly the shape the queue is looking for,
    // and asking about the code you just withdrew is the definition of nagging.
    if (d.kind === "unpark") { d.codes.forEach((c) => seen.delete(c)); continue; }
    if (["keep", "park", "remove"].includes(d.kind)) d.codes.forEach((c) => seen.add(c));
    // A merge marks NOBODY as read. The name folded away is out of the book,
    // and the survivor just had someone else's excerpts poured into it — if it
    // is still thin after that, it is thin with evidence nobody has read, which
    // is exactly what this queue is for. Deleted names go unmarked for the
    // other reason: they are gone, and a code someone types later with the same
    // name is a new code that deserves its turn. A name is not an identity.
  }
  return seen;
}

/** the verdict a code currently carries, if any — the last one that still stands */
export function lastVerdicts(ledger: Decision[]): Map<string, { kind: Decision["kind"]; at: number }> {
  const out = new Map<string, { kind: Decision["kind"]; at: number }>();
  ledger.forEach((d, at) => {
    if (d.undone) return;
    // bringing a code back is the un-verdict: it leaves the card open again
    if (d.kind === "unpark") { d.codes.forEach((c) => out.delete(c)); return; }
    if (["keep", "park", "remove"].includes(d.kind)) {
      d.codes.forEach((c) => out.set(c, { kind: d.kind, at }));
    } else if (d.kind === "merge" && d.codes.length) {
      // the survivor has been decided about; the folded-away name is gone
      out.set(d.codes[0], { kind: "merge", at });
      d.codes.slice(1).forEach((c) => out.delete(c));
    }
  });
  return out;
}

/** every thin code, decided or not — the thing you walk back and forth through */
export function tailSequence(
  codebook: Record<string, { def: string; parked?: boolean }>,
  stats: Record<string, { segs: number; pids: number }>,
  limit: TailLimit,
): string[] {
  // parked codes stay IN the sequence: setting one aside is a verdict you must
  // be able to walk back to and change, and it is the only surface that offers
  // the way back short of hunting for it in the Codebook
  return Object.keys(codebook)
    .filter((c) => (stats[c]?.segs ?? 0) <= limit)
    .sort((a, b) => (stats[a]?.segs ?? 0) - (stats[b]?.segs ?? 0) || a.localeCompare(b));
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
  const seq = useMemo(() => tailSequence(codebook, stats, limit), [codebook, stats, limit]);
  const verdicts = useMemo(() => lastVerdicts(ledger), [ledger]);
  const thin = seq.length;
  const done = seq.filter((c) => verdicts.has(c)).length;
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
            : `${done} of ${thin} decided. ${thin - done} still open.`}
        </p>
      </div>
      <p className="dvNote">
        A code resting on one excerpt is not a fault — this just makes sure you have seen each one.
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
  // Triage, not a conveyor: the sequence holds every thin code, decided or
  // not, and you move through it in both directions. A card you have already
  // decided shows its verdict and lets you change it — which is what "I
  // pressed a key before I understood what it did" actually needs.
  const seq = useMemo(() => tailSequence(codebook, stats, limit), [codebook, stats, limit]);
  const verdicts = useMemo(() => lastVerdicts(ledger), [ledger]);
  const [folding, setFolding] = useState(false);
  const [foldQuery, setFoldQuery] = useState("");
  // a fold changes data, so its way back is the history stack rather than a
  // verdict swap; this remembers whether that undo is still ours to offer
  const [lastFold, setLastFold] = useState<{ code: string; into: string; depth: number } | null>(null);
  // null = follow the work: sit on the first card with no verdict yet
  const [cursor, setCursor] = useState<number | null>(null);

  const firstOpen = seq.findIndex((c) => !verdicts.has(c));
  const at = cursor === null
    ? (firstOpen === -1 ? Math.max(0, seq.length - 1) : firstOpen)
    : Math.min(cursor, Math.max(0, seq.length - 1));
  const code = seq[at];
  const verdict = code ? verdicts.get(code) : undefined;
  const left = seq.filter((c) => !verdicts.has(c)).length;
  useEffect(() => { setFolding(false); setFoldQuery(""); }, [code]);

  const go = useCallback((delta: number) => {
    setCursor((cur) => {
      const from = cur === null ? at : cur;
      return Math.max(0, Math.min(seq.length - 1, from + delta));
    });
  }, [at, seq.length]);

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

  const act = useCallback((what: "keep" | "park" | "fold", into?: string) => {
    if (!code) return;
    const st = useStore.getState();
    if (what === "fold" && !into) { setFolding(true); return; }
    // changing your mind: the verdict this card already carries is taken back
    // first, so a code never holds two
    const cur = lastVerdicts(st.ledger).get(code);
    if (cur?.kind === "keep") st.retractVerdict(cur.at);
    if (cur?.kind === "park" && what !== "park") st.setParked(code, false);

    if (what === "fold") {
      const depth = st.undoStack.length;
      // (from, into): the THIN code is the one folded away, into the one that
      // already carries the evidence
      st.mergeCode(code, into!, `Folded in after reading its ${segs.length || "one"} excerpt${segs.length === 1 ? "" : "s"}`, "you");
      setLastFold({ code, into: into!, depth: depth + 1 });
      earcon.join();
    } else if (what === "park") {
      if (cur?.kind !== "park") st.setParked(code, true);
      earcon.evict();
    } else {
      st.noteVerdict(code);
      earcon.accept();
    }
    // move on to the next card with no verdict yet, or simply the next one
    const after = seq.findIndex((c, i) => i > at && !lastVerdicts(useStore.getState().ledger).has(c));
    setCursor(after === -1 ? Math.min(at + 1, seq.length - 1) : after);
  }, [code, segs.length, seq, at]);

  /** take the verdict off this card and leave it undecided */
  const clearVerdict = useCallback(() => {
    if (!code || !verdict) return;
    const st = useStore.getState();
    if (verdict.kind === "keep") st.retractVerdict(verdict.at);
    else if (verdict.kind === "park") st.setParked(code, false);
    else { announce("That one was a merge — use Undo in the toolbar to take it back", { assertive: true }); return; }
    earcon.undo();
  }, [code, verdict]);

  // A fold moved excerpts, so its way back is the history stack — offered only
  // while nothing else has pushed onto it since.
  const undoFold = useCallback(() => {
    if (!lastFold) return;
    const st = useStore.getState();
    if (st.undoStack.length !== lastFold.depth) {
      announce("Something else has changed since — use Undo in the toolbar", { assertive: true });
      return;
    }
    st.undo();
    earcon.undo();
    setLastFold(null);
  }, [lastFold]);

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
      // while the fold picker is open, the card's own keys go quiet: Enter
      // must not "keep" the code someone is halfway through folding away
      if (folding) {
        if (e.key === "Escape") { e.preventDefault(); setFolding(false); }
        return;
      }
      const k = e.key.toLowerCase();
      if (e.key === "Enter") { e.preventDefault(); act("keep"); }
      else if (k === "f") { e.preventDefault(); act("fold"); }
      else if (k === "p") { e.preventDefault(); act("park"); }
      // walking the queue: both directions, freely, decided or not
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "Backspace") { e.preventDefault(); verdict ? clearVerdict() : go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [code, act, folding, go, verdict, clearVerdict]);

  if (!code) {
    return (
      <div className="tqCard">
        <p className="empty" style={{ padding: 0 }}>
          Nothing in the tail at this size. Widen what counts as thin on the
          left, or carry on coding.
        </p>
      </div>
    );
  }
  const n = stats[code]?.segs ?? 0;
  const where = stats[code]?.pids ?? 0;
  const VERDICT_SAID: Partial<Record<string, string>> = {
    keep: "You kept this one.",
    park: "You set this aside — its excerpts are untouched, and the Codebook keeps it under Set aside.",
    remove: "You withdrew this code's excerpts.",
    merge: "This one absorbed another code.",
  };
  return (
    <div className="tqCard">
      {/* where you are, and the way in both directions. Triage is walking a
          pile twice as often as it is walking it once. */}
      <div className="tqNav">
        <button className="nBtn" onClick={() => go(-1)} disabled={at === 0}
          title="The one before (←)">← Back</button>
        <span className="tqPos">{at + 1} of {seq.length}{left ? ` · ${left} still open` : " · all decided"}</span>
        <button className="nBtn" onClick={() => go(1)} disabled={at >= seq.length - 1}
          title="The one after (→)">Next →</button>
      </div>
      {verdict && (
        <div className="tqLast" role="status">
          <span>{VERDICT_SAID[verdict.kind] ?? "You decided about this one."}</span>
          <button className="nBtn" onClick={clearVerdict}>Take it back <kbd>⌫</kbd></button>
        </div>
      )}
      {lastFold && !verdict && (
        <div className="tqLast" role="status">
          <span>“{lastFold.code}” folded into “{lastFold.into}”. Its excerpts moved across.</span>
          <button className="nBtn" onClick={undoFold}>Undo that</button>
        </div>
      )}
      <div className="tqHead">
        <h2 className="tqName">{code}</h2>
        <button className="nBtn"
          onClick={() => { preselectBrowse([code]); useStore.getState().setActive("browse"); }}
          title="Open this code in the Codebook">See it in the Codebook</button>
      </div>
      <p className="dvNote">
        {n === 0 ? "No accepted excerpts" : `${n} excerpt${n === 1 ? "" : "s"} in ${where} transcript${where === 1 ? "" : "s"}`}
        {(codebook[code]?.def ?? "").trim() ? "" : " · no definition written"}
        {codebook[code]?.parked ? " · set aside" : ""}
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

