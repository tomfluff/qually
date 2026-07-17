import { useCallback } from "react";

const FOCUSABLE = "a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex='-1'])";

// The focus half of a modal dialog, shared by every modal (the ARIA role and
// labelling stay in each component's JSX). A callback ref (React 19 ref
// cleanup), so it engages when the dialog ELEMENT appears — whether the
// component mounts per-open (AiCheckModal) or stays mounted and renders its
// dialog conditionally (AboutButton, ImportModal). On attach: move focus
// inside. While up: Tab cycles within the dialog instead of escaping into the
// page beneath. On detach: hand focus back to whatever opened it.
//
// initialFocus "container" parks focus on the dialog element itself (give it
// tabIndex={-1}) instead of its first control — for popovers whose first
// control is an input that would swallow app-level shortcuts (the segment
// popover's notes field vs Ctrl+C-copies-the-segment). Tab still enters the
// controls as the first stop.
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(
  opts?: { initialFocus?: "first" | "container" }
) {
  const initial = opts?.initialFocus ?? "first";
  return useCallback((el: T | null) => {
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (initial === "container" ? el : focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, [initial]);
}
