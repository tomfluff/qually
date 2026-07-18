// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
import { useEffect, useState } from "react";
import { useStore, type SegUpdate } from "../state/store";
import { useDialogFocus } from "../useDialogFocus";
import { Icon } from "./Icon";

// Shown when a re-imported CSV would land on a transcript that already has coding.
// The preview is the safety net: the counts are shown before anything is applied.
export function ImportModal() {
  const pending = useStore((s) => s.pendingImports[0]);
  const resolve = useStore((s) => s.resolveImport);
  const dialogRef = useDialogFocus();
  if (!pending) return null;

  const { pid, preview: p } = pending;
  const pct = Math.round(p.overlap * 100);

  return (
    <div className="about-backdrop" onMouseDown={() => resolve("cancel")}>
      <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="import-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="import-title">“{pid}” is already imported</h2>
          <button className="btn iconbtn" onClick={() => resolve("cancel")} title="Cancel (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>

        {p.different ? (
          <>
            <div className="imp-warn">
              <b>This looks like a different transcript.</b> Only {pct}% of the coded transcript's
              lines appear in the new file. Updating would throw away most of your coding for
              little gain — import it as a separate transcript instead.
            </div>
            <p className="about-lede">
              It has <b>{p.total} coded segment{p.total === 1 ? "" : "s"}</b>, of which only{" "}
              <b>{p.remapped}</b> could be re-anchored.
            </p>
          </>
        ) : (
          <>
            <p className="about-lede">
              It has <b>{p.total} coded segment{p.total === 1 ? "" : "s"}</b>. Matching them against
              the new file ({pct}% of lines in common):
            </p>
            <div className="imp-stats">
              <div><b>{p.remapped}</b> re-anchor onto the new lines</div>
              {p.dropped > 0 && (
                <div className="imp-drop">
                  <b>{p.dropped}</b> have no matching line left and would be dropped
                </div>
              )}
            </div>
          </>
        )}

        <div className="imp-actions">
          <button className={"btn" + (p.different ? "" : " primary")} onClick={() => resolve("update")}>
            Update — keep the {p.remapped} matched code{p.remapped === 1 ? "" : "s"}
          </button>
          <button className={"btn" + (p.different ? " primary" : "")} onClick={() => resolve("new")}>
            Import as new — keep both, name it “{pid} (2)”
          </button>
          <button className="btn danger" onClick={() => resolve("replace")}>
            Replace — discard all {p.total} code{p.total === 1 ? "" : "s"}
          </button>
          <button className="btn" onClick={() => resolve("cancel")}>Cancel</button>
        </div>
        <div className="imp-note">Undo can't reach across an import — this preview is your last check.</div>
      </div>
    </div>
  );
}

// Shown when an imported coded-segments.csv carries different status/notes for
// segments that already exist here — e.g. re-importing an old export after
// reviewing in the app. Applying silently would erase that review work.
const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
// both versions, same shape, so the eye can compare line against line
const sideOf = (v: SegUpdate["from"], withNotes: boolean) =>
  v.status + (withNotes ? (v.notes ? ` · “${clip(v.notes)}”` : " · no note") : "");

// Shown when an import brings in coded segments that carry no coder — signed
// "(default)" in the file, or blank. Offers to attribute them to a name you supply
// (you may know whose file this is), touching ONLY the rows that just arrived.
export function ImportSignModal() {
  const pending = useStore((s) => s.pendingImportSign);
  const resolve = useStore((s) => s.resolveImportSign);
  const [name, setName] = useState("");
  const dialogRef = useDialogFocus();
  const done = (nm: string | null) => { resolve(nm); setName(""); };

  useEffect(() => {
    if (!pending) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  if (!pending) return null;

  const n = pending.sids.length;
  const it = n === 1 ? "it" : "them";
  return (
    <div className="about-backdrop" onMouseDown={() => done(null)}>
      <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="import-sign-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="import-sign-title">{n} imported code{n === 1 ? "" : "s"} {n === 1 ? "is" : "are"} unsigned</h2>
          <button className="btn iconbtn" onClick={() => done(null)} title="Keep as (default) (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="about-lede">
          {n === 1 ? "This code" : "These codes"} came in signed <code>(default)</code> — whoever coded {it}{" "}
          never set a name. If you know whose {n === 1 ? "it is" : "they are"}, sign {it} now; otherwise
          keep <code>(default)</code>.
        </p>
        <label className="signfield"><span>Their name</span>
          <input className="signinput" autoFocus value={name} placeholder="their name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) done(name); }} />
        </label>
        <div className="imp-actions">
          <button className="btn primary" disabled={!name.trim() || name.trim() === "(default)"}
            onClick={() => done(name)}>Sign {it} as “{name.trim() || "…"}”</button>
          <button className="btn" onClick={() => done(null)}>Keep as (default)</button>
        </div>
        <div className="imp-note">Only these {n} imported {n === 1 ? "row" : "rows"} — your own codes aren't touched. One undo step.</div>
      </div>
    </div>
  );
}

export function SegUpdateModal() {
  const updates = useStore((s) => s.pendingSegUpdates);
  const resolve = useStore((s) => s.resolveSegUpdates);
  const dialogRef = useDialogFocus();
  if (!updates.length) return null;
  const n = updates.length;

  return (
    <div className="about-backdrop" onMouseDown={() => resolve(false)}>
      <div className="about imp" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="seg-update-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="seg-update-title">The file disagrees with {n} segment{n === 1 ? "" : "s"} here</h2>
          <button className="btn iconbtn" onClick={() => resolve(false)} title="Keep mine (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="about-lede">
          New segments were imported. But for {n === 1 ? "one segment" : `${n} segments`} you already
          have, the file carries a different status or note{n === 1 ? "" : "s"}:
        </p>
        <div className="imp-stats">
          {updates.slice(0, 5).map((u) => {
            const withNotes = !!(u.from.notes || u.to.notes);
            return (
              <div key={u.sid} className="segdiff">
                <div><b>{u.ref}</b> {u.code}</div>
                <div className="segdiff-side segdiff-yours"><span className="segdiff-k">yours</span>{sideOf(u.from, withNotes)}</div>
                <div className="segdiff-side segdiff-file"><span className="segdiff-k">file</span>{sideOf(u.to, withNotes)}</div>
              </div>
            );
          })}
          {n > 5 && <div>…and {n - 5} more</div>}
        </div>
        <div className="imp-actions">
          <button className="btn" onClick={() => resolve(true)}>
            Overwrite with the file's version
          </button>
          <button className="btn primary" onClick={() => resolve(false)}>
            Keep mine — import only the new rows
          </button>
        </div>
        <div className="imp-note">Overwriting is one undo step, so it can be taken back.</div>
      </div>
    </div>
  );
}
