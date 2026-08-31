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
    const active = document.activeElement as HTMLElement | null;
    // A child that already claimed focus keeps it: refs attach bottom-up, so a
    // dialog whose content carries autoFocus (DefineHost's editor) would
    // otherwise have it yanked to the close button the instant the dialog
    // element attached. Same reason the opener isn't taken from inside — that
    // node dies with the dialog, and focus()ing it on close lands on <body>.
    const inside = !!active && el.contains(active);
    const opener = inside ? null : active;
    const focusables = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!inside) (initial === "container" ? el : focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    // A control that DISABLES itself while focused hands focus to <body>, and
    // this trap listens on the dialog element — a keydown on <body> never
    // reaches it, so Tab then walks the page behind an aria-modal dialog. Every
    // AI consent gate does exactly that: Send is disabled={busy}, so pressing
    // it strands the researcher outside the dialog for the whole run, with Stop
    // — the only way to abort something they are paying for — unreachable by
    // the trap. Catch it where it happens rather than in nine components.
    const onOut = () => {
      // after the browser has moved focus, and only if it went nowhere
      queueMicrotask(() => {
        if (!el.isConnected) return;
        const now = document.activeElement;
        if (now && now !== document.body && el.contains(now)) return;
        if (now && now !== document.body) return;   // something outside claimed it deliberately
        (focusables()[0] ?? el).focus();
      });
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("focusout", onOut);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("focusout", onOut);
      opener?.focus?.();
    };
  }, [initial]);
}
