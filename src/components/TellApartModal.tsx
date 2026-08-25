// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// "Can you say what separates them?" — the oldest test in the methods
// literature, made into a surface: if you cannot write the sentence that tells
// two codes apart, they are one code.
//
// It runs in this order on purpose. Shown a model's answer first, you evaluate
// it; made to write your own first, you analyse. That ordering is the entire
// design, and it costs one textarea.
//
// It is also where definitions come from. Most codes never get one — the
// sentence you write to keep two codes apart IS the definition of both, so the
// work of deciding leaves the artefact the codebook was missing rather than
// evaporating into a merge you cannot explain later.
import { useEffect, useMemo, useState } from "react";
import { useStore, type DecisionSource } from "../state/store";
import { segExcerpt } from "../contract/excerpt";
import { norm } from "../contract/segments";
import { earcon } from "../earcons";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";
import { withSubs } from "../markup";

export function TellApartModal({ codes, survivor, newName, source, model, onClose, onDecided }: {
  /** exactly two codes: the pair under the question */
  codes: [string, string];
  /** the direction the capsule already proposed — the merge answer honours it,
      so the researcher is never shown one direction and given another */
  survivor?: string;
  /** the name the capsule promised the merged code would take, if it was renamed */
  newName?: string;
  /** whose idea the capsule was — the merge answer carries the SAME provenance
      accepting it on the map would, not a hard-coded "you" */
  source?: DecisionSource;
  model?: string;
  onClose: () => void;
  /** either answer settles the question the caller was holding open */
  onDecided?: (outcome: "kept" | "merged") => void;
}) {
  const codebook = useStore((s) => s.codebook);
  const segments = useStore((s) => s.segments);
  const transcripts = useStore((s) => s.transcripts);
  const fontSize = useStore((s) => s.ui.sidebarFontSize);
  const [a, b] = codes;
  const [sentence, setSentence] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const dialogRef = useDialogFocus();
  // every dialog in the app carries its own Escape: App's global handler bails
  // out on .about-backdrop (see AiModal)
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [onClose]);

  const readOf = useMemo(() => (code: string) => segments
    .filter((s) => norm(s.code) === norm(code) && s.status === "accepted" && transcripts[s.pid])
    .map((s) => ({ pid: s.pid, ...segExcerpt(s, transcripts[s.pid].lines) }))
    .filter((x) => x.excerpt), [segments, transcripts]);
  const left = useMemo(() => readOf(a), [readOf, a]);
  const right = useMemo(() => readOf(b), [readOf, b]);

  // Enter is deliberately not a submit here: the answer is a sentence, and a
  // sentence that ends when a finger slips is not an answer.
  const written = sentence.trim();
  const keepBoth = () => {
    // one act: the sentence is the line between them, and it only means
    // anything read from either side
    useStore.getState().defineBoth(a, b, written, source, model);
    earcon.accept();
    onDecided?.("kept");
    setDone("Saved as the definition of both codes. The next pass — yours or a model's — now reasons from your sentence instead of guessing from the names.");
  };
  const merge = () => {
    const st = useStore.getState();
    // the capsule's own survivor wins when the caller passed one — the card
    // said "merge into X", and this answer must not quietly flip that to Y.
    // Without one, the evidence rule: whichever side carries more excerpts.
    const [from, into] = survivor === a ? [b, a]
      : survivor === b ? [a, b]
      : left.length > right.length ? [b, a] : [a, b];
    st.mergeCode(from, into, "Could not write a sentence that separates them", source ?? "you", model);
    // the capsule may have been renamed on the map, and the card above says
    // what the merged code will be called — so it is called that
    const named = newName && newName !== into && !st.codebook[newName] ? newName : null;
    // part of the SAME gesture as the merge above — mergeCode pushed the one
    // undo entry, so the rename rides it instead of pushing a second
    if (named) useStore.getState().renameCode(into, named, "The name this merge was proposed under", source ?? "you", model, false);
    earcon.join();
    onDecided?.("merged");
    setDone(`Merged into “${named ?? into}”, with “could not write a sentence that separates them” as the reason.`);
  };

  const column = (code: string, rows: { pid: string; excerpt: string; speaker: string }[]) => (
    <div className="taCol">
      <h3>{code}</h3>
      <p className="dvNote">
        {rows.length} excerpt{rows.length === 1 ? "" : "s"}
        {(codebook[code]?.def ?? "").trim() ? " · has a definition" : " · no definition"}
      </p>
      <div className="taEx nicescroll">
        {rows.length === 0 && <p className="dvNote">Nothing accepted under this code yet.</p>}
        {rows.map((r, i) => (
          <blockquote key={i}><span className="tqWho">{r.pid} · {r.speaker}</span>{withSubs(r.excerpt)}</blockquote>
        ))}
      </div>
    </div>
  );

  return (
    <div className="about-backdrop" onMouseDown={onClose}>
      <div className="about imp taModal" role="dialog" aria-modal="true" aria-labelledby="ta-title"
        ref={dialogRef} style={{ fontSize }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="ta-title">What separates these two?</h2>
          <button className="btn iconbtn" onClick={onClose} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
        <p className="about-lede">
          Read both sides, then write the line between them. If you cannot, that is an answer too.
        </p>
        {/* the reading and the writing scroll together; the verdict buttons
            stay put below, so a raised text size scrolls the excerpts rather
            than clipping the answer (the modal itself is capped at 84vh) */}
        <div className="about-body taBody">
          <div className="taCols">{column(a, left)}{column(b, right)}</div>
          {done ? (
            <p className="taDone">{done}</p>
          ) : (
            <label className="taField">
              <span>In one sentence: when does an excerpt belong to “{a}” rather than “{b}”?</span>
              <textarea rows={3} value={sentence} onChange={(e) => setSentence(e.target.value)}
                placeholder={`An excerpt belongs to “${a}” when…`} />
            </label>
          )}
        </div>
        {done ? (
          <div className="taActs"><button className="btn primary" onClick={onClose}>Close</button></div>
        ) : (
          <div className="taActs">
            <button className="btn primary" disabled={written.length < 8} onClick={keepBoth}
              title={written.length < 8
                ? "Write the sentence first — it becomes both definitions"
                : "Keep both codes, and save this as the definition of each"}>
              That is the difference — keep both
            </button>
            <button className="btn" onClick={merge}
              title="Fold them together, recording that no sentence separated them">
              I cannot separate them — merge
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
