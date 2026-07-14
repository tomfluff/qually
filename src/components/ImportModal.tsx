import { useStore } from "../state/store";
import { Icon } from "./Icon";

// Shown when a re-imported CSV would land on a transcript that already has coding.
// The preview is the safety net: the counts are shown before anything is applied.
export function ImportModal() {
  const pending = useStore((s) => s.pendingImports[0]);
  const resolve = useStore((s) => s.resolveImport);
  if (!pending) return null;

  const { pid, preview: p } = pending;
  const pct = Math.round(p.overlap * 100);

  return (
    <div className="about-backdrop" onMouseDown={() => resolve("cancel")}>
      <div className="about imp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2>“{pid}” is already imported</h2>
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
