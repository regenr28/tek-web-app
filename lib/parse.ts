/** Parse Jira exports (PDF / XLSX / CSV / TXT) into plain text + rows. Nothing is stored except the result. */

import { HttpError } from "./security";

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // PK..

/** Reads the ZIP central directory and rejects archives that would inflate to something huge (zip bombs). */
function assertSafeZip(b: Uint8Array, maxTotal = 40 * 1024 * 1024, maxEntries = 2000) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(400, "That XLSX file looks damaged");
  const entries = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true), total = 0;
  if (entries > maxEntries) throw new HttpError(400, "XLSX file has too many parts");
  for (let n = 0; n < entries; n++) {
    if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) throw new HttpError(400, "That XLSX file looks damaged");
    const comp = dv.getUint32(off + 20, true), size = dv.getUint32(off + 24, true);
    total += size;
    if (total > maxTotal || (comp > 0 && size / comp > 500)) throw new HttpError(400, "XLSX file expands too much to be a normal spreadsheet");
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
}

export async function parseUpload(file: File): Promise<{ text: string; rows: string[][] }> {
  const name = file.name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  // Trust the file's bytes, not its name or the browser's MIME type.
  if (name.endsWith(".pdf") && !isPdf(buf)) throw new HttpError(400, "That file isn't a real PDF");
  if ((name.endsWith(".xlsx") || name.endsWith(".xlsm")) && !isZip(buf)) throw new HttpError(400, "That file isn't a real XLSX");
  if (!/\.(pdf|xlsx|xlsm|csv|txt)$/.test(name)) throw new HttpError(400, "Upload a PDF, XLSX, CSV or TXT file");
  if (/\.(csv|txt)$/.test(name) && buf.includes(0)) throw new HttpError(400, "That file isn't plain text");
  if (isZip(buf)) assertSafeZip(buf);

  if (name.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { text: pages.join("\n\n"), rows: [] };
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf.buffer as ArrayBuffer);
    const rows: string[][] = [];
    const lines: string[] = [];
    wb.eachSheet((ws) => {
      lines.push(`## ${ws.name}`);
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = (row.values as unknown[]).slice(1).map(cellText);
        rows.push(vals);
        lines.push(vals.filter(Boolean).join(" | "));
      });
    });
    const t = transposeHeaderRows(rows);
    return { text: lines.join("\n"), rows: t.length ? t : rows };
  }

  const text = new TextDecoder().decode(buf);
  if (name.endsWith(".csv")) {
    const rows = parseCsv(text);
    const t = transposeHeaderRows(rows);
    return { text: rows.map((r) => r.join(" | ")).join("\n"), rows: t.length ? t : rows };
  }
  return { text, rows: [] };
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("text" in o) return String(o.text);
    if ("richText" in o && Array.isArray(o.richText)) return o.richText.map((r: { text: string }) => r.text).join("");
    if ("result" in o) return String(o.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("hyperlink" in o) return String(o.hyperlink);
  }
  return String(v).trim();
}

/** A Jira export is often one header row + one data row. Turn that into [label, value] pairs. */
function transposeHeaderRows(rows: string[][]): string[][] {
  if (rows.length < 2 || rows.length > 6 || rows[0].filter(Boolean).length < 3) return [];
  const [head, ...data] = rows;
  const out: string[][] = [];
  for (const r of data) head.forEach((h, i) => { if (h && r[i]) out.push([h, r[i]]); });
  return out;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
