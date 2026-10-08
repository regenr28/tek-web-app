/** Spreadsheet text (tab- or comma-separated, Excel-style "quoted" cells with "" escapes and line breaks) → rows of cells. */
export function parseDelimited(text: string, delim = "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** One CSV cell, always quoted (quotes escaped). */
export const csvCell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
