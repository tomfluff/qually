// Inlined Tabler icon paths (MIT) — kept offline, no CDN (constraint #1).
const PATHS: Record<string, { d: string[]; fill?: boolean }> = {
  "chevron-up": { d: ["M6 15l6 -6l6 6"] },
  "chevron-down": { d: ["M6 9l6 6l6 -6"] },
  "chevron-left": { d: ["M15 6l-6 6l6 6"] },
  play: { d: ["M7 4v16l13 -8z"], fill: true },
  pause: { d: ["M6 5h4v14h-4z", "M14 5h4v14h-4z"], fill: true },
  refresh: { d: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"] },
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
