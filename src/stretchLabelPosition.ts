// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk

export type StretchLabelPlacement = {
  mode: "flowing" | "pinned" | "parked" | "clipped";
  top: number;
  translateY: number;
  clipHeight?: number;
};

/** Position a gutter label from content geometry and one stable natural height.
    The parked `top` is fixed in content coordinates; only its transform follows
    scroll, so a live box measurement cannot move the handoff threshold. */
export function stretchLabelPlacement(
  start: number,
  end: number,
  scroll: number,
  height: number,
): StretchLabelPlacement {
  const contentTop = start + 2;
  const room = end - contentTop;
  if (room < height) {
    return { mode: "clipped", top: contentTop, translateY: -scroll, clipHeight: Math.max(0, room) };
  }
  if (contentTop - scroll > 4) {
    return { mode: "flowing", top: contentTop, translateY: -scroll };
  }
  const parkedTop = end - height;
  if (parkedTop - scroll <= 4) {
    return { mode: "parked", top: parkedTop, translateY: -scroll };
  }
  return { mode: "pinned", top: 4, translateY: 0 };
}
