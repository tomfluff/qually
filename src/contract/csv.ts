// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Yotam Sechayk
// RFC4180-ish CSV parse/serialize. Parity with Python's csv module and the
// v1 vanilla app. parse(serialize(x)) round-trips hostile content
// (commas, quotes, newlines). Header cells are trimmed; data cells are not.

export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  let quoted = false; // row had a quoted field: a lone "" is a value, not a blank line
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') { q = true; quoted = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "" || quoted) rows.push(row);
      row = []; quoted = false;
    } else field += c;
  }
  if (field !== "" || row.length || quoted) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) =>
    Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))
  );
}

export function toCSV(rows: Record<string, unknown>[], fields: string[]): string {
  const q = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return (
    [fields.join(",")]
      .concat(rows.map((r) => {
        const line = fields.map((f) => q(r[f])).join(",");
        return line === "" ? '""' : line; // a single-column empty row must survive parse
      }))
      .join("\r\n") + "\r\n"
  );
}
