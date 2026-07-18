// Screen-reader announcements. The app's feedback is almost entirely visual
// (a lane bar appears, a count ticks up); this is the audible twin. Two polite-
// and assertive live regions, created lazily so tests (node, no DOM) and the
// initial render cost nothing. Clear-then-set inside a frame so repeating the
// SAME message (coding line after line with the same code) still announces every
// time. Pass { assertive: true } for errors/alerts that must interrupt whatever
// the reader is currently saying instead of queueing behind it.
const regions: Record<"polite" | "assertive", HTMLElement | null> = { polite: null, assertive: null };

export function announce(msg: string, opts?: { assertive?: boolean }): void {
  if (typeof document === "undefined") return;
  const kind = opts?.assertive ? "assertive" : "polite";
  let region = regions[kind];
  if (!region) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("aria-live", kind);
    if (kind === "assertive") region.setAttribute("role", "alert");
    document.body.appendChild(region);
    regions[kind] = region;
  }
  region.textContent = "";
  const el = region;
  requestAnimationFrame(() => { el.textContent = msg; });
}
