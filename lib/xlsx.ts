import { unzipSync, strFromU8 } from "fflate";

/**
 * Minimal, tolerant XLSX reader. Jira's exports use inline strings and rows without
 * row numbers, which some libraries reject — this reads them as-is.
 * Caller must run the zip-bomb check (lib/parse.ts) before calling.
 */

export type Sheet = { name: string; rows: string[][] };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? _
  );

/** Concatenates every <t> inside a string item (handles rich text runs). */
const textOf = (xml: string) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

function colIndex(ref: string) {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() || "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buf: Uint8Array, maxSheets = 20): Sheet[] {
  const files = unzipSync(buf, { filter: (f) => f.name.startsWith("xl/") && /\.(xml|rels)$/.test(f.name) && f.originalSize < 30_000_000 });
  const get = (p: string) => (files[p] ? strFromU8(files[p]) : "");

  const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map([...get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1] || "";
    const target = m[1].match(/\bTarget="([^"]+)"/)?.[1] || "";
    return [id, target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "")];
  }));

  const sheets: Sheet[] = [];
  for (const m of get("xl/workbook.xml").matchAll(/<sheet\b([^>]*)\/?>/g)) {
    if (sheets.length >= maxSheets) break;
    const name = decode(m[1].match(/\bname="([^"]*)"/)?.[1] || `Sheet${sheets.length + 1}`);
    const rid = m[1].match(/\br:id="([^"]+)"/)?.[1] || "";
    const xml = get(rels.get(rid) || `xl/worksheets/sheet${sheets.length + 1}.xml`);
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const row: string[] = [];
      let next = 0;
      for (const c of (r[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || "";
        const ref = attrs.match(/\br="([A-Z]+\d*)"/i)?.[1];
        const idx = ref ? colIndex(ref) : next;
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = "";
        if (type === "s") val = shared[Number(v)] ?? "";
        else if (type === "inlineStr") val = textOf(inner);
        else if (type === "b") val = v === "1" ? "TRUE" : "FALSE";
        else val = v !== undefined ? decode(v) : "";
        row[idx] = val.trim();
        next = idx + 1;
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
