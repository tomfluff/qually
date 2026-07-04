// Inlined Tabler icon paths (MIT) — kept offline, no CDN (constraint #1).
const PATHS: Record<string, { d: string[]; fill?: boolean }> = {
  "chevron-up": { d: ["M6 15l6 -6l6 6"] },
  "chevron-down": { d: ["M6 9l6 6l6 -6"] },
  "chevron-left": { d: ["M15 6l-6 6l6 6"] },
  play: { d: ["M7 4v16l13 -8z"], fill: true },
  pause: { d: ["M6 5h4v14h-4z", "M14 5h4v14h-4z"], fill: true },
  refresh: { d: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"] },
  undo: { d: ["M9 14l-4 -4l4 -4", "M5 10h11a4 4 0 1 1 0 8h-1"] },
  redo: { d: ["M15 14l4 -4l-4 -4", "M19 10h-11a4 4 0 1 0 0 8h1"] },
  pencil: { d: ["M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4z", "M13.5 6.5l4 4"] },
  text: { d: ["M4 6h16", "M4 12h10", "M4 18h14"] },
  droplet: { d: ["M6.8 11a6 6 0 1 0 10.4 0l-5.2 -9l-5.2 9"] },
  pin: { d: ["M9 4v6l-2 4v2h10v-2l-2 -4v-6", "M12 16v5", "M8 4h8"] },
  merge: { d: ["M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M7 8v8", "M7 8a4 4 0 0 0 4 4h4"] },
  trash: { d: ["M4 7h16", "M10 11v6", "M14 11v6", "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12", "M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"] },
  copy: { d: ["M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z", "M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"] },
  x: { d: ["M18 6l-12 12", "M6 6l12 12"] },
  search: { d: ["M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"] },
  help: { d: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M12 17v.01", "M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4"] },
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  const { d, fill } = PATHS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"}
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block" }}>
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}
