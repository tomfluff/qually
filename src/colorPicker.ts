// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// Opens the native color picker for an existing swatch. The input must be in
// the document for click() to open the dialog in Firefox/Safari, so it is
// appended hidden and removed once the picker commits.
// ponytail: a cancelled picker leaves the 1px hidden input behind (no reliable
// cancel event); it's inert and replaced on the next pick.
export function openColorPicker(value: string, onPick: (color: string) => void) {
  const inp = document.createElement("input");
  inp.type = "color";
  inp.value = value;
  inp.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(inp);
  inp.oninput = () => onPick(inp.value);
  inp.onchange = () => inp.remove();
  inp.click();
}
