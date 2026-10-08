import { PdfDoc, textWidth, fit } from "./pdf";
import type { ReportData } from "./types";

/** Meeting-ready PDF (A4 landscape): headline numbers + trend chart, then the breakdown donut, then the table. */

const INK = "#16181d", MUTED = "#636b78", GRID = "#eceef2", TILE = "#f1f3f6", ACCENT = "#3b5bdb", LINE = "#e2e5ea";
const M = 40; // page margin
const fmt = (v: number) => v.toLocaleString("en-US");
const dateStr = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function header(doc: PdfDoc, d: ReportData, title: string, sub?: string) {
  doc.rect(0, 0, doc.W, 6, { fill: ACCENT });
  doc.text(M, 44, title, { font: "Helvetica-Bold", size: 20 });
  doc.text(M, 62, sub ?? d.subtitle, { size: 10, color: MUTED });
  doc.text(doc.W - M, 44, "Website history report", { size: 9, color: MUTED, align: "right" });
  doc.text(doc.W - M, 58, `Generated ${dateStr(d.generated)}`, { size: 9, color: MUTED, align: "right" });
}
function niceTicks(max: number) {
  if (max <= 4) return Array.from({ length: Math.max(1, max) + 1 }, (_, i) => i);
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => Math.round(i * step));
}

function lineChart(doc: PdfDoc, d: ReportData, X: number, Y: number, W: number, H: number) {
  const n = d.buckets.length;
  const max = Math.max(1, ...d.buckets.flatMap((b) => b.values));
  const ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
  const L = X + 34, R = X + W - 110, T = Y + 26, B = Y + H - 22;
  const x = (i: number) => (n <= 1 ? (L + R) / 2 : L + (i * (R - L)) / (n - 1));
  const y = (v: number) => B - ((B - T) * v) / top;
  // legend (top-left of the chart)
  let lx = L;
  d.series.forEach((s) => {
    doc.rect(lx, Y + 6, 9, 9, { fill: s.color, radius: 2 });
    lx += 14 + doc.text(lx + 14, Y + 14, s.label, { size: 9, color: INK }) + 18;
  });
  ticks.forEach((t) => {
    doc.line(L, y(t), R, y(t), { stroke: GRID, width: 0.7 });
    doc.text(L - 6, y(t) + 3, fmt(t), { size: 8, color: MUTED, align: "right" });
  });
  const every = Math.max(1, Math.ceil(n / 12));
  d.buckets.forEach((b, i) => { if ((n - 1 - i) % every === 0) doc.text(x(i), B + 14, i === n - 1 && d.partialLast ? `${b.label} (${d.partialWord || "so far"})` : b.label, { size: 8, color: MUTED, align: "center" }); });
  d.series.forEach((s, si) => {
    const pts = d.buckets.map((b, i) => [x(i), y(b.values[si])] as [number, number]);
    const solid = d.partialLast && n > 1 ? pts.slice(0, -1) : pts;
    doc.polyline(solid, { stroke: s.color, width: 1.8 });
    if (d.partialLast && n > 1) doc.polyline(pts.slice(-2), { stroke: s.color, width: 1.8, dash: [3, 3] });
    if (n <= 24) pts.forEach(([px, py]) => doc.circle(px, py, 2.4, { fill: s.color, stroke: "#ffffff", width: 1 }));
  });
  // end labels, nudged apart so equal values don't overlap
  const last = d.buckets[n - 1];
  if (last) {
    const ls = d.series.map((s, si) => ({ s, v: last.values[si], y: y(last.values[si]) + 3 })).sort((a, b) => a.y - b.y);
    // short names at the line ends (the legend above has the full names)
    for (let i = 1; i < ls.length; i++) if (ls[i].y - ls[i - 1].y < 11) ls[i].y = ls[i - 1].y + 11;
    const over = ls.length ? ls[ls.length - 1].y - (B + 3) : 0;
    if (over > 0) ls.forEach((l) => (l.y -= over));
    ls.forEach((l) => doc.text(x(n - 1) + 7, l.y, fit(`${l.s.short || l.s.label} ${fmt(l.v)}`, "Helvetica", 8, 100), { size: 8, color: INK }));
  }
}

function donut(doc: PdfDoc, d: ReportData, cx: number, cy: number, r: number) {
  const total = d.breakdown.reduce((n, b) => n + b.value, 0);
  if (!total) { doc.circle(cx, cy, r, { stroke: LINE, width: 1 }); doc.text(cx, cy + 4, "No sites in this period", { size: 10, color: MUTED, align: "center" }); return; }
  let a = 0;
  const gap = d.breakdown.filter((b) => b.value).length > 1 ? 0.012 : 0;
  d.breakdown.forEach((b) => {
    if (!b.value) return;
    const sweep = (b.value / total) * Math.PI * 2;
    doc.slice(cx, cy, r, r * 0.6, a + gap, a + sweep - gap, { fill: b.color });
    a += sweep;
  });
  doc.text(cx, cy - 2, fmt(total), { font: "Helvetica-Bold", size: 22, align: "center" });
  doc.text(cx, cy + 14, "sites", { size: 10, color: MUTED, align: "center" });
}

function table(doc: PdfDoc, X: number, Y: number, cols: { label: string; w: number; right?: boolean }[], rows: string[][], o: { totals?: string[]; rowH?: number } = {}) {
  const rh = o.rowH || 18;
  const W = cols.reduce((n, c) => n + c.w, 0);
  doc.rect(X, Y, W, rh + 2, { fill: ACCENT, radius: 3 });
  let cx = X;
  cols.forEach((c) => { doc.text(c.right ? cx + c.w - 8 : cx + 8, Y + 13, c.label, { font: "Helvetica-Bold", size: 9, color: "#ffffff", align: c.right ? "right" : "left" }); cx += c.w; });
  let y = Y + rh + 2;
  rows.forEach((r, i) => {
    if (i % 2) doc.rect(X, y, W, rh, { fill: "#f8f9fb" });
    let x = X;
    r.forEach((v, ci) => { const c = cols[ci]; doc.text(c.right ? x + c.w - 8 : x + 8, y + 12.5, fit(v, "Helvetica", 9, c.w - 14), { size: 9, color: INK, align: c.right ? "right" : "left" }); x += c.w; });
    doc.line(X, y + rh, X + W, y + rh, { stroke: LINE, width: 0.5 });
    y += rh;
  });
  if (o.totals) {
    doc.rect(X, y, W, rh + 2, { fill: TILE });
    let x = X;
    o.totals.forEach((v, ci) => { const c = cols[ci]; doc.text(c.right ? x + c.w - 8 : x + 8, y + 13, v, { font: "Helvetica-Bold", size: 9, align: c.right ? "right" : "left" }); x += c.w; });
    y += rh + 2;
  }
  return y;
}

export function buildPdf(d: ReportData): Uint8Array {
  const doc = new PdfDoc(842, 595);
  const contentW = doc.W - 2 * M;

  // ---------- page 1: headline numbers + trend ----------
  doc.addPage();
  header(doc, d, d.title);
  let y = 76;
  if (d.filters) { y += doc.paragraph(M, y + 8, `Filters: ${d.filters}`, contentW, { size: 9, color: MUTED }); }
  const tiles = d.series.length, gap = 14, tw = (contentW - gap * (tiles - 1)) / tiles;
  const ty = y + 14;
  d.series.forEach((s, i) => {
    const tx = M + i * (tw + gap);
    doc.rect(tx, ty, tw, 70, { fill: TILE, radius: 8 });
    doc.rect(tx + 14, ty + 16, 4, 38, { fill: s.color, radius: 2 });
    doc.text(tx + 28, ty + 42, fmt(d.totals[i]), { font: "Helvetica-Bold", size: 26 });
    doc.text(tx + 28, ty + 58, s.label, { size: 10, color: MUTED });
  });
  const chartY = ty + 88;
  const noteH = 12 * Math.min(3, d.notes.length);
  lineChart(doc, d, M, chartY, contentW, doc.H - chartY - 44 - noteH);
  d.notes.slice(0, 3).forEach((t, i) => doc.text(M, doc.H - 34 - noteH + 12 + i * 12, fit(t, "Helvetica", 8, contentW), { size: 8, color: MUTED }));

  // ---------- page 2: where the sites created in the period are now ----------
  doc.addPage();
  header(doc, d, d.breakdownTitle);
  const total = d.breakdown.reduce((n, b) => n + b.value, 0);
  donut(doc, d, M + 170, 300, 150);
  const tx = M + 380, cols = [{ label: "Where they are now", w: 230 }, { label: "Sites", w: 80, right: true }, { label: "Share", w: 80, right: true }];
  const rowsY = 150;
  table(doc, tx, rowsY, cols, d.breakdown.map((b) => [b.label, fmt(b.value), total ? `${((b.value / total) * 100).toFixed(1)}%` : "—"]), { totals: ["Total", fmt(total), total ? "100%" : "—"], rowH: 26 });
  // colour keys in the first column
  d.breakdown.forEach((b, i) => doc.rect(tx - 16, rowsY + 28 + i * 26 + 8, 10, 10, { fill: b.color, radius: 2 }));
  doc.paragraph(tx, rowsY + 28 + (d.breakdown.length + 1) * 26 + 24, "Of the sites created in the period, where each one is today (from Duda's latest site list and the domain checks). Counts follow the filters shown on page 1.", 390, { size: 9, color: MUTED });

  // ---------- page 3+: the numbers per period ----------
  const rows = [...d.buckets].reverse().map((b, i) => [i === 0 && d.partialLast ? `${b.label} (${d.partialWord || "so far"})` : b.label, ...b.values.map(fmt)]);
  const tcols = [{ label: d.unitLabel, w: 200 }, ...d.series.map((s) => ({ label: s.label, w: Math.floor((contentW - 200) / d.series.length), right: true }))];
  const per = 22;
  for (let p = 0; p < Math.max(1, Math.ceil(rows.length / per)); p++) {
    doc.addPage();
    header(doc, d, `By ${d.unitLabel.toLowerCase()}`, `${d.subtitle}${rows.length > per ? ` · part ${p + 1} of ${Math.ceil(rows.length / per)}` : ""}`);
    const last = p === Math.ceil(rows.length / per) - 1;
    table(doc, M, 84, tcols, rows.slice(p * per, (p + 1) * per), { totals: last ? ["Total", ...d.totals.map(fmt)] : undefined });
  }

  return doc.build((pg, page, totalPages) => {
    pg.line(M, pg.H - 26, pg.W - M, pg.H - 26, { stroke: LINE, width: 0.5 });
    pg.text(M, pg.H - 14, "Duda Preview Audit · All Websites", { size: 8, color: MUTED });
    pg.text(pg.W - M, pg.H - 14, `Page ${page} of ${totalPages}`, { size: 8, color: MUTED, align: "right" });
  });
}
export { textWidth };
