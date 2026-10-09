"use client";
import { useMemo, useRef, useState } from "react";
import type { ReportData } from "@/lib/report/types";

/** The fields of an All Websites row this chart needs. */
export type HistRow = { site_name: string; domain: string; duda_status: string; created_at: string | null; first_publish: string | null; last_publish: string | null; missing: number; unpublished_at: string | null; removed_at: string | null };

type Unit = "week" | "month" | "year";
type Key = "created" | "published" | "unpublished";
const SERIES: { key: Key; label: string; short: string; color: string; hint: string }[] = [
  { key: "created", label: "Created", short: "Created", color: "var(--series-1)", hint: "Sites created in Duda (creation date)" },
  { key: "published", label: "First published", short: "Published", color: "var(--series-2)", hint: "First time the site went live (first publish date)" },
  { key: "unpublished", label: "Unpublished for good", short: "Unpublished", color: "var(--series-3)", hint: "Sites that had been live and are now unpublished or gone from Duda's export" },
];
const STAGING = /\.(tekmetric\.site|shopgenie\.site|multiscreensite\.com|dudaone\.com|mydudapreview\.com)$/i;
const RANGES: Record<Unit, [string, number][]> = {
  week: [["Last 12 weeks", 12], ["Last 26 weeks", 26], ["Last 52 weeks", 52]],
  month: [["Last 12 months", 12], ["Last 24 months", 24], ["All time", 0]],
  year: [["All time", 0]],
};
/** Light-mode hex of the series (PDF / Excel are printed on white) — same as --series-1..4 in globals.css */
const HEX = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
/** Donut: where the sites created in the period are now. Order matches the validated colour ring (1→2→3→4→1). */
const OUTCOMES = [
  { key: "temp", label: "Live on temporary domain", color: "var(--series-1)", hex: HEX[0] },
  { key: "own", label: "Live on own domain", color: "var(--series-2)", hex: HEX[1] },
  { key: "gone", label: "Unpublished for good", color: "var(--series-3)", hex: HEX[2] },
  { key: "never", label: "Never published", color: "var(--series-4)", hex: HEX[3] },
] as const;
type Outcome = (typeof OUTCOMES)[number]["key"];
const DAY = 86_400_000;
const MON_ = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateLabel = (d: Date) => `${MON_[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Start of the bucket a date falls in (weeks start on Monday, UTC). */
function bucketStart(d: Date, unit: Unit): Date {
  if (unit === "year") return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  if (unit === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}
function nextBucket(d: Date, unit: Unit): Date {
  const x = new Date(d);
  if (unit === "year") x.setUTCFullYear(x.getUTCFullYear() + 1);
  else if (unit === "month") x.setUTCMonth(x.getUTCMonth() + 1);
  else x.setUTCDate(x.getUTCDate() + 7);
  return x;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function label(d: Date, unit: Unit, long = false) {
  if (unit === "year") return String(d.getUTCFullYear());
  if (unit === "month") return `${MON[d.getUTCMonth()]}${long || d.getUTCMonth() === 0 ? ` ${d.getUTCFullYear()}` : ""}`;
  return `${long ? "Week of " : ""}${MON[d.getUTCMonth()]} ${d.getUTCDate()}${long ? `, ${d.getUTCFullYear()}` : ""}`;
}
/** 0, 1, 2, 5, 10, 20, 25, 50… — a round top for the y-axis with ~4 ticks */
function niceTicks(max: number) {
  if (max <= 4) return Array.from({ length: Math.max(1, max) + 1 }, (_, i) => i);
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => Math.round(i * step));
}

/** "Unpublished for good": had been live, now not published (or deleted from Duda). Date: when the import saw it, else its last publish date. */
export function unpublishedDate(r: HistRow): { at: string; estimated: boolean } | null {
  if (!r.first_publish) return null;
  if (r.duda_status === "PUBLISHED" && !r.missing) return null;
  const exact = r.unpublished_at || r.removed_at;
  if (exact) return { at: exact.replace(" ", "T") + (exact.endsWith("Z") ? "" : "Z"), estimated: false };
  return r.last_publish ? { at: r.last_publish, estimated: true } : null;
}


/** Where a site is today (for the donut). */
function outcomeOf(r: HistRow): Outcome {
  if (unpublishedDate(r)) return "gone";
  if (r.duda_status === "PUBLISHED" && !r.missing) return STAGING.test(r.domain) ? "temp" : "own";
  return "never";
}

export default function SitesHistory({ rows, filters = "", appName }: { rows: HistRow[]; filters?: string; appName?: string }) {
  const [unit, setUnit] = useState<Unit>("month");
  const [range, setRange] = useState<number | "custom">(12);
  const today = iso(new Date());
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 90 * DAY)));
  const [to, setTo] = useState(today);
  const [ownDomain, setOwnDomain] = useState(true);
  const [hidden, setHidden] = useState<Key[]>([]);
  const [view, setView] = useState<"line" | "pie" | "table">("line");
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const now = new Date();
    const custom = range === "custom";
    // the exact window: custom dates (whole days), else whole periods up to today
    const fromD = custom ? new Date(`${from}T00:00:00Z`) : null;
    const toD = custom ? new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY) : null; // end is exclusive
    const okDates = custom && fromD && toD && !isNaN(fromD.getTime()) && !isNaN(toD.getTime()) && fromD.getTime() < toD.getTime();
    const events: { key: Key; at: Date }[] = [];
    let estimated = 0;
    for (const r of rows) {
      if (r.created_at) events.push({ key: "created", at: new Date(r.created_at) });
      if (r.first_publish && (!ownDomain || !STAGING.test(r.domain))) events.push({ key: "published", at: new Date(r.first_publish) });
      const u = unpublishedDate(r);
      if (u) { events.push({ key: "unpublished", at: new Date(u.at) }); if (u.estimated) estimated++; }
    }
    const valid = events.filter((e) => !isNaN(e.at.getTime()));
    let start: Date, end: Date;
    if (okDates) { start = bucketStart(fromD!, unit); end = bucketStart(new Date(toD!.getTime() - 1), unit); }
    else {
      end = bucketStart(now, unit);
      const r = typeof range === "number" ? range : 12;
      if (r > 0) { start = new Date(end); for (let i = 1; i < r; i++) start = unit === "week" ? new Date(start.getTime() - 7 * DAY) : unit === "month" ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)) : new Date(Date.UTC(start.getUTCFullYear() - 1, 0, 1)); }
      else start = bucketStart(new Date(Math.min(now.getTime(), ...valid.map((e) => e.at.getTime()))), unit);
    }
    const winStart = okDates ? fromD! : start;
    const winEnd = okDates ? new Date(Math.min(toD!.getTime(), now.getTime() + DAY)) : now;
    const winEndMs = okDates ? toD!.getTime() : now.getTime() + DAY;
    const inWin = (d: Date) => d.getTime() >= winStart.getTime() && d.getTime() < winEndMs;
    const buckets: { start: Date; created: number; published: number; unpublished: number }[] = [];
    for (let b = start; b <= end && buckets.length < 600; b = nextBucket(b, unit)) buckets.push({ start: b, created: 0, published: 0, unpublished: 0 });
    const idx = new Map(buckets.map((b, i) => [b.start.getTime(), i]));
    for (const e of valid) { if (!inWin(e.at)) continue; const i = idx.get(bucketStart(e.at, unit).getTime()); if (i !== undefined) buckets[i][e.key]++; }
    const totals = { created: 0, published: 0, unpublished: 0 };
    for (const b of buckets) for (const s of SERIES) totals[s.key] += b[s.key];
    // the last period isn't complete when it contains today or the custom end date cuts it short
    const lastEnd = buckets.length ? nextBucket(buckets[buckets.length - 1].start, unit) : now;
    const partialLast = winEnd.getTime() < lastEnd.getTime();
    // donut: sites created in the window, by where they are now
    const outcome: Record<Outcome, number> = { temp: 0, own: 0, gone: 0, never: 0 };
    for (const r of rows) { if (!r.created_at) continue; const c = new Date(r.created_at); if (!isNaN(c.getTime()) && inWin(c) && c.getTime() >= start.getTime()) outcome[outcomeOf(r)]++; }
    const rangeText = `${dateLabel(winStart)} – ${dateLabel(new Date(winEnd.getTime() - (okDates ? DAY : 0)))}`;
    // "so far" while the period is still running; "partial" when custom dates cut a past period short
    const partialWord = okDates && toD!.getTime() <= now.getTime() ? "partial" : "so far";
    return { buckets, totals, estimated, partialLast, partialWord, outcome, rangeText, inWin, custom: !!okDates, badDates: custom && !okDates };
  }, [rows, unit, range, from, to, ownDomain]);

  const lab = (s: (typeof SERIES)[number]) => (s.key === "published" && ownDomain ? "First published (own domain)" : s.label);
  const shown = SERIES.filter((s) => !hidden.includes(s.key));
  const max = Math.max(1, ...data.buckets.flatMap((b) => shown.map((s) => b[s.key])));
  const ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
  const W = 900, H = 260, L = 40, R = 120, T = 12, B = 28;
  const n = data.buckets.length;
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const every = Math.max(1, Math.ceil(n / 12)); // ~12 x labels at most, counted back from the latest period
  // end-of-line labels: keep them at least 14px apart so equal values don't print on top of each other
  const endLabels = (() => {
    const last = data.buckets[n - 1];
    if (!last) return [] as { s: (typeof SERIES)[number]; y: number }[];
    const ls = shown.map((s) => ({ s, y: y(last[s.key]) + 4 })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ls.length; i++) if (ls[i].y - ls[i - 1].y < 14) ls[i].y = ls[i - 1].y + 14;
    const over = ls.length ? ls[ls.length - 1].y - (H - B + 4) : 0;
    if (over > 0) ls.forEach((l) => (l.y -= over));
    return ls;
  })();
  const toggle = (k: Key) => setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : shown.length > 1 ? [...h, k] : h));
  const hb = hover !== null ? data.buckets[hover] : null;
  const unitWord = unit === "week" ? "Weekly" : unit === "month" ? "Monthly" : "Yearly";
  const outcomeTotal = OUTCOMES.reduce((t, o) => t + data.outcome[o.key], 0);

  /** The same numbers as on screen, for the PDF / Excel download. */
  function report(): ReportData {
    const seriesLabel = (s: (typeof SERIES)[number]) => lab(s);
    const sites = rows.map((r) => {
      const c = r.created_at ? new Date(r.created_at) : null, p = r.first_publish ? new Date(r.first_publish) : null, u = unpublishedDate(r);
      const ud = u ? new Date(u.at) : null;
      const inC = !!c && data.inWin(c), inP = !!p && data.inWin(p) && (!ownDomain || !STAGING.test(r.domain)), inU = !!ud && data.inWin(ud);
      return { r, c, p, ud, u, inC, inP, inU };
    }).filter((x) => x.inC || x.inP || x.inU).map((x) => ({
      name: x.r.site_name, domain: x.r.domain, status: x.r.duda_status, created: x.c, firstPublished: x.p, unpublished: x.ud, estimated: !!x.u?.estimated,
      now: OUTCOMES.find((o) => o.key === outcomeOf(x.r))!.label, inCreated: x.inC, inPublished: x.inP, inUnpublished: x.inU,
    }));
    return {
      title: "Website history", subtitle: `${unitWord} · ${data.rangeText}`, filters, generated: new Date(), appName,
      unitLabel: unit === "week" ? "Week" : unit === "month" ? "Month" : "Year",
      series: SERIES.map((s, i) => ({ label: seriesLabel(s), short: s.short, color: HEX[i] })),
      buckets: data.buckets.map((b) => ({ label: label(b.start, unit, true), start: b.start, values: SERIES.map((s) => b[s.key]) })),
      totals: SERIES.map((s) => data.totals[s.key]), partialLast: data.partialLast, partialWord: data.partialWord,
      breakdownTitle: "Sites created in this period — where they are now",
      breakdown: OUTCOMES.map((o) => ({ label: o.label, value: data.outcome[o.key], color: o.hex })),
      notes: [
        `“Unpublished for good” = had been live, and is now unpublished in Duda or gone from its export${data.estimated ? `; ${data.estimated.toLocaleString()} older date(s) are estimates (last publish date)` : ""}.`,
        ownDomain ? "“First published (own domain)” counts only sites now on the shop's own domain (not tekmetric.site)." : "",
        data.partialLast ? (data.partialWord === "so far" ? "The last period isn't over yet, so its numbers are “so far” (dashed line)." : "The last period is cut short by the chosen end date (dashed line).") : "",
      ].filter(Boolean),
      sites,
    };
  }
  async function download(kind: "pdf" | "xlsx") {
    setBusy(kind);
    try {
      const d = report();
      const bytes = kind === "pdf" ? (await import("@/lib/report/historyPdf")).buildPdf(d) : (await import("@/lib/report/xlsx")).buildXlsx(d);
      const blob = new Blob([bytes as BlobPart], { type: kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `website-history-${unit}-${iso(new Date())}.${kind}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally { setBusy(""); }
  }

  return (
    <div className="card stack viz" style={{ boxShadow: "none", gap: 10 }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div><h3 style={{ margin: 0 }}>Website history</h3>
          <div className="muted small">{unitWord} · {data.rangeText}{filters ? ` · Filters: ${filters}` : " · all websites"}</div></div>
        <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="row" style={{ gap: 2 }}>{(["line", "pie", "table"] as const).map((v) => <button key={v} className={`sm ${view === v ? "primary" : ""}`} onClick={() => setView(v)}>{v === "line" ? "Line" : v === "pie" ? "Donut" : "Table"}</button>)}</span>
          <button className="sm" disabled={!!busy} onClick={() => download("pdf")} title="A presentation-ready PDF: totals, the trend, the donut and the table">{busy === "pdf" ? "Preparing…" : "⬇ PDF"}</button>
          <button className="sm" disabled={!!busy} onClick={() => download("xlsx")} title="Excel workbook: Summary (with charts), By period, Sites">{busy === "xlsx" ? "Preparing…" : "⬇ Excel"}</button>
        </div>
      </div>
      <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
        {(["week", "month", "year"] as Unit[]).map((u) => <button key={u} className={`sm ${unit === u ? "primary" : ""}`} onClick={() => { setUnit(u); if (range !== "custom") setRange(RANGES[u][0][1]); setHover(null); }}>{u === "week" ? "Weekly" : u === "month" ? "Monthly" : "Yearly"}</button>)}
        <select className="sm" style={{ width: "auto" }} value={String(range)} onChange={(e) => { setRange(e.target.value === "custom" ? "custom" : Number(e.target.value)); setHover(null); }}>
          {RANGES[unit].map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          <option value="custom">Custom dates…</option>
        </select>
        {range === "custom" && <>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} aria-label="From" />
          <span className="muted">to</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} aria-label="To" />
          {data.badDates && <span className="badge warning">Pick a start date before the end date</span>}
        </>}
        <label className="row" style={{ gap: 4 }} title="Count a first publish only when the site is now on the shop's own domain (not tekmetric.site)"><input type="checkbox" checked={ownDomain} onChange={(e) => setOwnDomain(e.target.checked)} style={{ width: "auto" }} /> Published on own domain only</label>
      </div>

      {/* totals for the range = legend (click to hide/show a line) */}
      {view !== "pie" && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {SERIES.map((s) => (
          <button key={s.key} className="stat" title={`${s.hint} — click to ${hidden.includes(s.key) ? "show" : "hide"}`} onClick={() => toggle(s.key)}
            style={{ textAlign: "left", cursor: "pointer", minWidth: 170, opacity: hidden.includes(s.key) ? 0.45 : 1, border: "2px solid transparent" }}>
            <b>{data.totals[s.key].toLocaleString()}</b><span><span className="viz-key" style={{ background: s.color }} />{lab(s)}</span>
          </button>
        ))}
      </div>}

      {view === "pie" ? <Donut outcome={data.outcome} total={outcomeTotal} /> : view === "table" ? (
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          <table className="t small">
            <thead><tr><th>{unit === "week" ? "Week of" : unit === "month" ? "Month" : "Year"}</th>{SERIES.map((s) => <th key={s.key} style={{ textAlign: "right" }}>{lab(s)}</th>)}</tr></thead>
            <tbody>{[...data.buckets].reverse().map((b) => <tr key={b.start.getTime()}><td>{label(b.start, unit, true)}</td>{SERIES.map((s) => <td key={s.key} style={{ textAlign: "right" }}>{b[s.key].toLocaleString()}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={box} style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Websites ${SERIES.map((s) => `${lab(s).toLowerCase()} ${data.totals[s.key]}`).join(", ")} per ${unit}`} style={{ display: "block", overflow: "visible" }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
                <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{t.toLocaleString()}</text>
              </g>
            ))}
            {data.buckets.map((b, i) => (n - 1 - i) % every === 0 && (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{label(b.start, unit)}{i === n - 1 && data.partialLast ? ` (${data.partialWord})` : ""}</text>
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />}
            {shown.map((s) => {
              // the current period isn't over yet: its segment is dashed so a partial count doesn't read as a drop
              const pts = (data.partialLast ? data.buckets.slice(0, -1) : data.buckets).map((b, i) => `${x(i)},${y(b[s.key])}`).join(" ");
              const tail = n > 1 ? `${x(n - 2)},${y(data.buckets[n - 2][s.key])} ${x(n - 1)},${y(data.buckets[n - 1][s.key])}` : "";
              return (
                <g key={s.key}>
                  {n > (data.partialLast ? 2 : 1) && <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                  {n > 1 && data.partialLast && <polyline points={tail} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" />}
                  {(n <= 1 || n <= 16) && data.buckets.map((b, i) => <circle key={i} cx={x(i)} cy={y(b[s.key])} r={hover === i ? 5 : 3} fill={s.color} stroke="var(--panel)" strokeWidth={2} />)}
                  {n > 16 && hover !== null && <circle cx={x(hover)} cy={y(data.buckets[hover][s.key])} r={5} fill={s.color} stroke="var(--panel)" strokeWidth={2} />}
                </g>
              );
            })}
            {/* direct labels at the line ends (identity never by colour alone) */}
            {endLabels.map(({ s, y: ly }) => <text key={s.key} x={x(n - 1) + 8} y={ly} fontSize={11} fill="var(--text)">{s.short} {data.buckets[n - 1][s.key]}</text>)}
            {/* hover targets: one column per bucket, wider than the marks */}
            {data.buckets.map((_, i) => {
              const w = n <= 1 ? W - L - R : (W - L - R) / (n - 1);
              return <rect key={i} x={x(i) - w / 2} y={T} width={w} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />;
            })}
          </svg>
          {hb && hover !== null && (
            <div className="viz-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: 0, transform: x(hover) > W * 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
              <b>{label(hb.start, unit, true)}{hover === n - 1 && data.partialLast ? ` — ${data.partialWord}` : ""}</b>
              {SERIES.map((s) => <div key={s.key} style={{ opacity: hidden.includes(s.key) ? 0.5 : 1 }}><span className="viz-key" style={{ background: s.color }} />{lab(s)}: <b>{hb[s.key].toLocaleString()}</b></div>)}
            </div>
          )}
        </div>
      )}
      <div className="muted small">
        “Unpublished for good” = had been live, and is now unpublished in Duda or gone from its export. Duda&apos;s export has no unpublish date, so the date is when an import first showed the change
        {data.estimated ? <> — <b>{data.estimated.toLocaleString()}</b> older one(s) use their last publish date instead (an estimate)</> : ""}. Import with “Also update the details of sites already in the list” ticked so changes are caught.
      </div>
    </div>
  );
}

/** Part-to-whole: of the sites created in the period, where each one is today. Labels carry the numbers (never colour alone). */
function Donut({ outcome, total }: { outcome: Record<Outcome, number>; total: number }) {
  const R = 110, r = 66, C = 130;
  let a = 0;
  const arcs = OUTCOMES.map((o) => {
    const v = outcome[o.key], sweep = total ? (v / total) * Math.PI * 2 : 0;
    const a0 = a, a1 = a + sweep; a = a1;
    return { o, v, a0, a1 };
  }).filter((x) => x.v > 0);
  const pt = (rad: number, ang: number) => `${C + rad * Math.sin(ang)} ${C - rad * Math.cos(ang)}`;
  const path = (a0: number, a1: number) => {
    if (a1 - a0 >= Math.PI * 2 - 1e-6) return `M ${pt(R, 0)} A ${R} ${R} 0 1 1 ${pt(R, Math.PI)} A ${R} ${R} 0 1 1 ${pt(R, 0)} M ${pt(r, 0)} A ${r} ${r} 0 1 0 ${pt(r, Math.PI)} A ${r} ${r} 0 1 0 ${pt(r, 0)} Z`;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${pt(R, a0)} A ${R} ${R} 0 ${big} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${big} 0 ${pt(r, a0)} Z`;
  };
  return (
    <div className="row" style={{ gap: 28, flexWrap: "wrap", alignItems: "center" }}>
      <svg viewBox={`0 0 ${C * 2} ${C * 2}`} width={240} height={240} role="img" aria-label={`Sites created in this period: ${OUTCOMES.map((o) => `${o.label} ${outcome[o.key]}`).join(", ")}`}>
        {total ? arcs.map(({ o, a0, a1 }) => <path key={o.key} d={path(a0, a1)} fill={o.color} stroke="var(--panel)" strokeWidth={2} fillRule="evenodd"><title>{`${o.label}: ${outcome[o.key]}`}</title></path>)
          : <circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke="var(--border)" strokeWidth={R - r} />}
        <text x={C} y={C - 2} textAnchor="middle" fontSize={30} fontWeight={700} fill="var(--text)">{total.toLocaleString()}</text>
        <text x={C} y={C + 20} textAnchor="middle" fontSize={13} fill="var(--muted)">sites created</text>
      </svg>
      <div className="stack" style={{ gap: 6, minWidth: 280 }}>
        <b className="small">Sites created in this period — where they are now</b>
        <table className="t small"><tbody>{OUTCOMES.map((o) => (
          <tr key={o.key}><td><span className="viz-key" style={{ background: o.color }} />{o.label}</td>
            <td style={{ textAlign: "right" }}><b>{outcome[o.key].toLocaleString()}</b></td>
            <td style={{ textAlign: "right" }} className="muted">{total ? `${((outcome[o.key] / total) * 100).toFixed(1)}%` : "—"}</td></tr>
        ))}</tbody></table>
        <span className="muted small">Each site counted once, by its status today (Duda list + domain checks).</span>
      </div>
    </div>
  );
}
