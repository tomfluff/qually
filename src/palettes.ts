// Primary-color options. Each has a light- and dark-theme accent so the app
// swaps to the matching one on theme switch. Everything chromatic in the UI
// (--sel, --row-sel*, buttons, tabs, highlights) derives from --accent, so
// changing this recolors the whole app. See index.css :root color-mix tints.
export interface Palette { id: string; name: string; light: string; dark: string; }

// violet is the brand purple and the default — first here so it's also the fallback.
//
// Accent-filled controls (the primary button, the active tab) hardcode WHITE text, so
// every LIGHT value here has to clear 4.5:1 against white or picking that primary
// silently breaks contrast app-wide. Teal was 3.96 and green 4.26 — both failing, both
// darkened. Dark-theme values pair with dark text (see .btn.primary) and are checked
// the other way. a11y.test.ts asserts all of this, so a future palette can't regress it.
export const PALETTES: Palette[] = [
  { id: "violet", name: "Violet", light: "#6d28d9", dark: "#a78bfa" },
  { id: "blue",   name: "Blue",   light: "#3b6ea5", dark: "#7aa7d6" },
  { id: "teal",   name: "Teal",   light: "#0f766e", dark: "#4fbcb0" },
  { id: "green",  name: "Green",  light: "#2f7a41", dark: "#63b877" },
  { id: "rose",   name: "Rose",   light: "#b8496b", dark: "#e389a1" },
];

export const DEFAULT_ACCENT = PALETTES[0].id;

export const accentFor = (id: string, dark: boolean): string => {
  const p = PALETTES.find((x) => x.id === id) ?? PALETTES[0];
  return dark ? p.dark : p.light;
};
