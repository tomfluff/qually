// Pseudonymize before anything leaves the device.
//
// No NER heuristic: guessing at names from capitalization is both noisy and
// quietly unsafe — the miss you don't see is a participant's real name in a
// third party's logs. The researcher already KNOWS their participants' names,
// their sites, and their employers, so they type them in once and we substitute
// exactly. Boring, auditable, and it can't silently under-redact.
//
// ponytail: whole-word, case-insensitive, longest-first. Add fuzzy matching only
// if real transcripts show spelling variants that slip through.

export interface Redaction {
  redact: (text: string) => string;
  restore: (text: string) => string; // map placeholders back for anything shown to the user
  count: (text: string) => number;
  hasPlaceholder: (text: string) => boolean; // did the model quote redacted text back at us?
}

export const PLACEHOLDER_RE = /\[REDACTED_\d+\]/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactor(terms: string[]): Redaction {
  const hasPlaceholder = (t: string) => PLACEHOLDER_RE.test(t);
  const list = terms.map((t) => t.trim()).filter(Boolean);
  if (!list.length) {
    return { redact: (t) => t, restore: (t) => t, count: () => 0, hasPlaceholder };
  }
  // Number by the order they were typed (so a placeholder means the same thing
  // tomorrow), but MATCH longest-first so "Ann Lee" wins over "Ann".
  const placeholder = new Map<string, string>(); // lowercased term -> [REDACTED_n]
  const back = new Map<string, string>();
  list.forEach((t, i) => {
    const p = `[REDACTED_${i + 1}]`;
    placeholder.set(t.toLowerCase(), p);
    back.set(p, t);
  });
  const byLength = [...list].sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${byLength.map(esc).join("|")})\\b`, "gi");
  const backRe = new RegExp(`\\[REDACTED_\\d+\\]`, "g");
  return {
    redact: (text) => text.replace(re, (m) => placeholder.get(m.toLowerCase()) ?? m),
    restore: (text) => text.replace(backRe, (m) => back.get(m) ?? m),
    count: (text) => (text.match(re) ?? []).length,
    hasPlaceholder,
  };
}
