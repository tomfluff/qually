import { useStore } from "../state/store";
import { CodeCombobox } from "./CodeCombobox";

// Centered overlay opened by the 0 key / dock tile, so coding the current
// selection gives clear feedback right where you're looking.
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const selCount = useStore((s) => s.selection.lines.size);
  const setPalette = useStore((s) => s.setPalette);
  if (!open) return null;
  return (
    <div className="palette-backdrop" onMouseDown={() => setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          {selCount > 0
            ? `Code ${selCount} selected line${selCount > 1 ? "s" : ""}`
            : "No lines selected — this will just create the code"}
        </div>
        <CodeCombobox autoFocus placeholder="Search or create a code…" onClose={() => setPalette(false)} />
      </div>
    </div>
  );
}
