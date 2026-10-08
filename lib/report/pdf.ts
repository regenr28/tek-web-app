import { WIDTHS } from "./fontmetrics";

/**
 * Tiny vector PDF writer for reports: Helvetica text (exact widths for alignment), lines, rectangles, circles and
 * donut slices. Coordinates are in points from the TOP-left of the page. No dependencies, runs in the browser.
 */

export type Font = "Helvetica" | "Helvetica-Bold";
type Paint = { fill?: string; stroke?: string; width?: number; dash?: number[] };

const WIN: Record<string, number> = { "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "©": 0xa9, "°": 0xb0, "·": 0xb7, "×": 0xd7, "→": 0x3e, "↑": 0x5e, "✓": 0x76 };
function codes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) out.push(c);
    else if (WIN[ch] !== undefined) out.push(WIN[ch]);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(0x3f); // "?"
  }
  return out;
}
export function textWidth(s: string, font: Font, size: number) {
  const w = WIDTHS[font];
  return codes(s).reduce((n, c) => n + (w[c - 32] || 556), 0) * size / 1000;
}
/** Shortens text with "…" until it fits. */
export function fit(s: string, font: Font, size: number, max: number) {
  if (textWidth(s, font, size) <= max) return s;
  let t = s;
  while (t.length > 1 && textWidth(t + "…", font, size) > max) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}
const pdfStr = (s: string) => "(" + codes(s).map((c) => (c === 0x28 || c === 0x29 || c === 0x5c ? "\\" + String.fromCharCode(c) : c < 128 ? String.fromCharCode(c) : "\\" + c.toString(8).padStart(3, "0"))).join("") + ")";
const n = (v: number) => (Math.round(v * 100) / 100).toString();
function rgb(hex: string) {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => n(parseInt(v.slice(i, i + 2), 16) / 255)).join(" ");
}

export class PdfDoc {
  readonly W: number; readonly H: number;
  private pages: string[][] = [];
  constructor(width = 842, height = 595) { this.W = width; this.H = height; }
  get pageCount() { return this.pages.length; }
  addPage() { this.pages.push([]); return this.pages.length - 1; }
  private get ops() { if (!this.pages.length) this.addPage(); return this.pages[this.pages.length - 1]; }
  private y(v: number) { return this.H - v; }
  private paint(p: Paint, path: string) {
    const o = this.ops;
    o.push("q");
    if (p.fill) o.push(`${rgb(p.fill)} rg`);
    if (p.stroke) o.push(`${rgb(p.stroke)} RG ${n(p.width ?? 1)} w 1 J 1 j`);
    if (p.dash) o.push(`[${p.dash.map(n).join(" ")}] 0 d`);
    o.push(path);
    o.push(p.fill && p.stroke ? "B" : p.fill ? "f" : "S");
    o.push("Q");
  }

  text(x: number, y: number, s: string, o: { font?: Font; size?: number; color?: string; align?: "left" | "center" | "right" } = {}) {
    const font = o.font || "Helvetica", size = o.size || 10;
    const w = textWidth(s, font, size);
    const x0 = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
    this.ops.push(`BT /${font === "Helvetica" ? "F1" : "F2"} ${n(size)} Tf ${rgb(o.color || "#16181d")} rg ${n(x0)} ${n(this.y(y))} Td ${pdfStr(s)} Tj ET`);
    return w;
  }
  /** Wrapped paragraph; returns the height used. */
  paragraph(x: number, y: number, s: string, maxWidth: number, o: { font?: Font; size?: number; color?: string; lineHeight?: number } = {}) {
    const font = o.font || "Helvetica", size = o.size || 9, lh = o.lineHeight || size * 1.35;
    const lines: string[] = [];
    let cur = "";
    for (const word of s.split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (textWidth(next, font, size) > maxWidth && cur) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    lines.forEach((l, i) => this.text(x, y + i * lh, l, { font, size, color: o.color }));
    return lines.length * lh;
  }
  line(x1: number, y1: number, x2: number, y2: number, p: Paint = {}) { this.paint({ stroke: "#000000", ...p }, `${n(x1)} ${n(this.y(y1))} m ${n(x2)} ${n(this.y(y2))} l`); }
  polyline(pts: [number, number][], p: Paint = {}) {
    if (pts.length < 2) return;
    this.paint({ stroke: "#000000", ...p }, pts.map(([x, y], i) => `${n(x)} ${n(this.y(y))} ${i ? "l" : "m"}`).join(" "));
  }
  rect(x: number, y: number, w: number, h: number, p: Paint & { radius?: number } = {}) {
    const r = Math.min(p.radius || 0, w / 2, h / 2);
    if (!r) { this.paint(p, `${n(x)} ${n(this.y(y + h))} ${n(w)} ${n(h)} re`); return; }
    const k = r * 0.5523, X = x, Y = this.y(y + h), R = x + w, T = this.y(y);
    this.paint(p, [
      `${n(X + r)} ${n(Y)} m`, `${n(R - r)} ${n(Y)} l`, `${n(R - r + k)} ${n(Y)} ${n(R)} ${n(Y + r - k)} ${n(R)} ${n(Y + r)} c`,
      `${n(R)} ${n(T - r)} l`, `${n(R)} ${n(T - r + k)} ${n(R - r + k)} ${n(T)} ${n(R - r)} ${n(T)} c`,
      `${n(X + r)} ${n(T)} l`, `${n(X + r - k)} ${n(T)} ${n(X)} ${n(T - r + k)} ${n(X)} ${n(T - r)} c`,
      `${n(X)} ${n(Y + r)} l`, `${n(X)} ${n(Y + r - k)} ${n(X + r - k)} ${n(Y)} ${n(X + r)} ${n(Y)} c`, "h",
    ].join(" "));
  }
  circle(cx: number, cy: number, r: number, p: Paint = {}) { this.slice(cx, cy, r, 0, 0, Math.PI * 2, p); }
  /** Donut / pie slice from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise). inner = 0 for a pie slice. */
  slice(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number, p: Paint = {}) {
    const pt = (r: number, a: number): [number, number] => [cx + r * Math.sin(a), this.y(cy - r * Math.cos(a))];
    const arc = (r: number, from: number, to: number) => {
      const segs = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
      const step = (to - from) / segs, out: string[] = [];
      for (let i = 0; i < segs; i++) {
        const s = from + i * step, e = s + step, k = (4 / 3) * Math.tan((e - s) / 4);
        const [x0, y0] = pt(r, s), [x3, y3] = pt(r, e);
        // PDF-space point (cx + r·sin a, H − cy + r·cos a); its derivative is (r·cos a, −r·sin a)
        const c1: [number, number] = [x0 + k * r * Math.cos(s), y0 - k * r * Math.sin(s)];
        const c2: [number, number] = [x3 - k * r * Math.cos(e), y3 + k * r * Math.sin(e)];
        out.push(`${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(x3)} ${n(y3)} c`);
      }
      return out.join(" ");
    };
    const [sx, sy] = pt(outer, a0);
    let path = `${n(sx)} ${n(sy)} m ${arc(outer, a0, a1)}`;
    if (inner > 0) { const [ix, iy] = pt(inner, a1); path += ` ${n(ix)} ${n(iy)} l ${arc(inner, a1, a0)}`; }
    else path += ` ${n(cx)} ${n(this.y(cy))} l`;
    this.paint(p, path + " h");
  }

  /** The finished file. `footer(page, total)` is drawn on every page last. */
  build(footer?: (doc: PdfDoc, page: number, total: number) => void): Uint8Array {
    if (footer) { const total = this.pages.length; this.pages.forEach((_, i) => { const keep = this.pages; this.pages = [keep[i]]; footer(this, i + 1, total); this.pages = keep; }); }
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add(""), pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const body = ops.join("\n");
      const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    // every character above is a single byte (content streams are ASCII; the header marker is Latin-1)
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
