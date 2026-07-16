// Screen-reader announcements. The app's feedback is almost entirely visual
// (a lane bar appears, a count ticks up); this is the audible twin. One polite
// live region, created lazily so tests (node, no DOM) and the initial render
// cost nothing. Clear-then-set inside a frame so repeating the SAME message
// (coding line after line with the same code) still announces every time.
let region: HTMLElement | null = null;

export function announce(msg: string): void {
  if (typeof document === "undefined") return;
  if (!region) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = "";
  requestAnimationFrame(() => { if (region) region.textContent = msg; });
}
