// Primary-color options. Each has a light- and dark-theme accent so the app
// swaps to the matching one on theme switch. Everything chromatic in the UI
// (--sel, --row-sel*, buttons, tabs, highlights) derives from --accent, so
// changing this recolors the whole app. See index.css :root color-mix tints.
export interface Palette { id: string; name: string; light: string; dark: string; }

export const PALETTES: Palette[] = [
  { id: "blue",   name: "Blue",   light: "#3b6ea5", dark: "#7aa7d6" },
  { id: "teal",   name: "Teal",   light: "#178f86", dark: "#4fbcb0" },
  { id: "violet", name: "Violet", light: "#6a4fc4", dark: "#a08ae8" },
  { id: "green",  name: "Green",  light: "#3a8a4e", dark: "#63b877" },
  { id: "rose",   name: "Rose",   light: "#b8496b", dark: "#e389a1" },
];

export const accentFor = (id: string, dark: boolean): string => {
  const p = PALETTES.find((x) => x.id === id) ?? PALETTES[0];
  return dark ? p.dark : p.light;
};
