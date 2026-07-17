// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// The QuAlly mark: a Q whose tail is a highlighter stroke mid-way through
// coding a line — magnifier, letterform and marker in one gesture.
//
// Exported from Figma as two frames (new-icon-light / new-icon-dark), but they
// differed in exactly one fill: the ring. That difference is --fg, so this is
// ONE svg with its three fills bound to the theme instead of two baked copies.
// The tail rides --accent, so the logo re-tints with the user's chosen primary.
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 184 178" fill="none"
      role="img" aria-label="QuAlly" style={{ display: "block", overflow: "visible" }}>
      <rect x="8" y="48" width="108.648" height="33" rx="16.5" fill="var(--muted)" />
      <rect x="8" y="94" width="62" height="33" rx="16.5" fill="var(--muted)" />
      <path fill="var(--fg)" d="M88 0C136.601 0 176 39.3989 176 88C176 136.601 136.601 176 88 176C39.3989 176 0 136.601 0 88C0 39.3989 39.3989 0 88 0ZM88 30C55.9675 30 30 55.9675 30 88C30 120.033 55.9675 146 88 146C120.033 146 146 120.033 146 88C146 55.9675 120.033 30 88 30Z" />
      <rect x="94.9896" y="88" width="108.648" height="33" rx="16.5"
        transform="rotate(35.1308 94.9896 88)" fill="var(--accent)" />
    </svg>
  );
}
