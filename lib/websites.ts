import { timingSafeEqual } from "crypto";
import { all, one, run, batch } from "./db";
import { parseCsv } from "./parse";
import { HttpError } from "./security";
import { sha256, randomToken } from "./secrets";
import { checkWebsite, HEALTH_LABEL, FLAG_LABEL, type Health } from "./health";
import { addPoint, trackIncidents, eventsFor, uptimeStats, launchStatus, DEFAULT_LAUNCH, type UptimePoint, type Incident } from "./monitor";
import { notifyRunFinished } from "./alerts";

/* ---------------- import (Duda "Export site list" CSV) ---------------- */

const COLS: Record<string, string> = {
  "site name": "site_name", "site alias": "alias", "external uid": "external_uid", "site url": "domain", status: "duda_status",
  "creation date": "created_at", "first publish date": "first_publish", "last publish date": "last_publish",
  "auto renew setting": "auto_renew", "next renewal date": "next_renewal", subscription: "subscription", "billing failed": "billing_failed", labels: "labels",
};
const cleanDomain = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
const cleanDate = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? new Date(v.trim()).toISOString() : null);
const cleanLabels = (v: string) => [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 40)))].slice(0, 30).join(",");

export type ImportResult = { importId: number; total: number; added: number; skipped: number; refreshed: number; invalid: string[]; missing: number };

/** Adds new sites by Site Alias. Aliases already in the list are never added twice; with `refresh` their Duda details are updated. */
export async function importSiteList(text: string, refresh: boolean): Promise<ImportResult> {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new HttpError(400, "That CSV has no rows");
  const head = rows[0].map((h) => COLS[h.trim().toLowerCase()] || "");
  if (!head.includes("alias") || !head.includes("domain")) throw new HttpError(400, 'This doesn\'t look like the Duda site list export (needs "Site Alias" and "Site URL" columns).');
  if (rows.length > 20001) throw new HttpError(400, "Too many rows (max 20,000)");
  const meta = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'websites_import'");
  const importId = (meta ? JSON.parse(meta.value).importId || 0 : 0) + 1;
  const existing = new Set((await all<{ alias: string }>("SELECT alias FROM websites")).map((r) => r.alias));
  const seen = new Set<string>();
  const invalid: string[] = [];
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  let added = 0, skipped = 0, refreshed = 0;
  for (const r of rows.slice(1)) {
    const o: Record<string, string> = {};
    head.forEach((k, i) => { if (k) o[k] = (r[i] || "").trim(); });
    const alias = o.alias || "";
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(alias)) { invalid.push(`row with alias "${alias.slice(0, 20)}"`); continue; }
    if (seen.has(alias)) continue;
    seen.add(alias);
    const vals = [
      (o.site_name || "").slice(0, 200), (o.external_uid || "").slice(0, 100) || null, cleanDomain(o.domain || "").slice(0, 253), (o.duda_status || "").toUpperCase().slice(0, 30),
      cleanDate(o.created_at || ""), cleanDate(o.first_publish || ""), cleanDate(o.last_publish || ""), (o.auto_renew || "").slice(0, 40) || null, cleanDate(o.next_renewal || ""),
      (o.subscription || "").slice(0, 60) || null, /^true$/i.test(o.billing_failed || "") ? 1 : 0, cleanLabels(o.labels || ""),
    ];
    if (existing.has(alias)) {
      skipped++;
      if (refresh) {
        refreshed++;
        stmts.push({ sql: `UPDATE websites SET site_name=?, external_uid=?, domain=?, duda_status=?, created_at=?, first_publish=?, last_publish=?, auto_renew=?, next_renewal=?, subscription=?, billing_failed=?, labels=?, refreshed_at=datetime('now'), last_seen_import=? WHERE alias=?`, args: [...vals, importId, alias] });
      } else stmts.push({ sql: "UPDATE websites SET last_seen_import = ? WHERE alias = ?", args: [importId, alias] });
    } else {
      added++;
      stmts.push({ sql: `INSERT INTO websites (site_name, external_uid, domain, duda_status, created_at, first_publish, last_publish, auto_renew, next_renewal, subscription, billing_failed, labels, alias, last_seen_import, health)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [...vals, alias, importId, vals[3] === "PUBLISHED" ? "unchecked" : "skipped"] });
    }
  }
  for (let i = 0; i < stmts.length; i += 400) await batch(stmts.slice(i, i + 400));
  const missing = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM websites WHERE last_seen_import < ?", [importId]))?.n || 0;
  const result = { importId, total: rows.length - 1, added, skipped, refreshed, invalid: invalid.slice(0, 20), missing };
  await run("INSERT INTO settings (key, value) VALUES ('websites_import', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ ...result, at: new Date().toISOString() })]);
  return result;
}

/* ---------------- list ---------------- */

export type WebsiteRow = {
  id: number; alias: string; site_name: string; domain: string; duda_status: string; created_at: string | null; first_publish: string | null; last_publish: string | null;
  subscription: string | null; labels: string; health: Health; health_detail: string; health_flags: string; checked_at: string | null; health_changed_at: string | null; prev_health: string | null;
  domain_expires: string | null; ssl_expires: string | null; missing: number;
  /** uptime over the last 30 days (null = not enough checks), how many checks, and the last 14 results (oldest first) */
  uptime_pct: number | null; uptime_checks: number; recent: string[];
  /** launch tracker: why it may not be live yet + for how many days */
  launch_flags: string[]; launch_days: number | null;
  /** GBP website check: ok | other | none | not_found | error (null = not checked) */
  gbp_status: string | null; gbp_website: string | null; gbp_checked_at: string | null;
  open_incident: string | null;
};
type RawRow = Omit<WebsiteRow, "recent" | "launch_flags" | "launch_days" | "gbp_status" | "gbp_website"> & { uptime_recent: string; gbp_json: string | null; billing_failed: number };

export async function listWebsites(): Promise<WebsiteRow[]> {
  const meta = await importMeta();
  const settings = await healthSettings();
  const raw = await all<RawRow>(`SELECT id, alias, site_name, domain, duda_status, created_at, first_publish, last_publish, subscription, labels, health, health_detail, health_flags,
    checked_at, health_changed_at, prev_health, domain_expires, ssl_expires, CASE WHEN last_seen_import < ? THEN 1 ELSE 0 END AS missing,
    uptime_pct, uptime_checks, uptime_recent, open_incident, gbp_json, gbp_checked_at, billing_failed FROM websites ORDER BY created_at DESC, id DESC`, [meta?.importId || 0]);
  const rows: WebsiteRow[] = raw.map(({ uptime_recent, gbp_json, billing_failed, ...r }) => {
    const g = parse<{ status?: string; website?: string } | null>(gbp_json, null);
    const l = launchStatus({ ...r, billing_failed }, settings);
    return { ...r, recent: uptime_recent ? uptime_recent.split(",") : [], launch_flags: l.flags, launch_days: l.days, gbp_status: g?.status || null, gbp_website: g?.website || null };
  });
  // expiry warnings follow the stored dates (so a change of threshold applies without re-checking everything)
  const days = (iso: string | null) => (iso ? (Date.parse(iso) - Date.now()) / 86_400_000 : Infinity);
  for (const r of rows) {
    let f: string[] = [];
    try { f = JSON.parse(r.health_flags || "[]"); } catch { /* ignore */ }
    f = f.filter((x) => x !== "ssl_expiring" && x !== "domain_expiring");
    if (r.health !== "skipped" && r.health !== "unchecked") {
      const sd = days(r.ssl_expires); if (sd < 5 && sd >= 0) f.push("ssl_expiring");
      if (days(r.domain_expires) < 7) f.push("domain_expiring");
      if (r.health === "ok" && r.gbp_status === "other") f.push("gbp_other");
      if (r.health === "ok" && r.gbp_status === "none") f.push("gbp_none");
    }
    r.health_flags = JSON.stringify(f);
  }
  return rows;
}
export async function importMeta(): Promise<(ImportResult & { at: string }) | null> {
  const m = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'websites_import'");
  return m ? JSON.parse(m.value) : null;
}

/* ---------------- checks ---------------- */

type Site = { id: number; alias: string; site_name: string; domain: string; duda_status: string; health: string; rdap_checked_at: string | null; domain_expires: string | null;
  health_flags: string; uptime_json: string | null; incidents_json: string | null };
const SITE_COLS = "id, alias, site_name, domain, duda_status, health, rdap_checked_at, domain_expires, health_flags, uptime_json, incidents_json";
const parse = <T,>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function checkOne(id: number) {
  const s = await one<Site>(`SELECT ${SITE_COLS} FROM websites WHERE id = ?`, [id]);
  if (!s) throw new HttpError(404, "Website not found");
  await saveCheck(s, await checkWebsite(s));
}

async function saveCheck(s: Site, r: Awaited<ReturnType<typeof checkWebsite>>) {
  const changed = s.health !== r.health && !["unchecked", "skipped"].includes(s.health);
  // uptime history, incidents and the "What changed" feed
  const at = new Date().toISOString();
  const points = addPoint(parse<UptimePoint[]>(s.uptime_json, []), { t: at, h: r.health, ...(r.info.ms ? { ms: r.info.ms } : {}) });
  const incidents = trackIncidents(parse<Incident[]>(s.incidents_json, []), s.health, r.health, r.detail, at);
  const events = eventsFor({ health: s.health, flags: parse<string[]>(s.health_flags, []) }, { health: r.health, flags: r.flags, detail: r.detail }, HEALTH_LABEL, FLAG_LABEL);
  if (events.length) await batch(events.map((e) => ({ sql: "INSERT INTO website_events (website_id, kind, health, title, detail) VALUES (?,?,?,?,?)", args: [s.id, e.kind, e.health, e.title.slice(0, 200), e.detail.slice(0, 500)] })));
  const st = uptimeStats(points, 30);
  const open = incidents.length && !incidents[incidents.length - 1].end ? incidents[incidents.length - 1].start : null;
  await run("UPDATE websites SET uptime_json = ?, incidents_json = ?, uptime_pct = ?, uptime_checks = ?, uptime_recent = ?, open_incident = ? WHERE id = ?",
    [JSON.stringify(points), JSON.stringify(incidents), st.pct, st.checks, points.slice(-14).map((p) => p.h).join(","), open, s.id]);
  await run(`UPDATE websites SET health = ?, health_detail = ?, health_flags = ?, health_json = ?, checked_at = datetime('now'),
      prev_health = CASE WHEN ? THEN health ELSE prev_health END, health_changed_at = CASE WHEN ? THEN datetime('now') ELSE health_changed_at END,
      rdap_checked_at = CASE WHEN ? THEN datetime('now') ELSE rdap_checked_at END, domain_expires = COALESCE(?, domain_expires), ssl_expires = COALESCE(?, ssl_expires)
    WHERE id = ?`, [r.health, r.detail.slice(0, 500), JSON.stringify(r.flags), JSON.stringify(r.info).slice(0, 20000), changed ? 1 : 0, changed ? 1 : 0, r.info.rdap && !r.info.rdap.retry ? 1 : 0, r.domainExpires || null, r.sslExpires || null, s.id]);
}

/* ---------------- "Check all" runs in the background ---------------- */

export type HealthRun = { id: number; status: string; scope: string; total: number; done: number; started_by: string | null; started_at: string; finished_at: string | null };
const BUDGET_MS = Number(process.env.HEALTH_BUDGET_MS) || 200_000;
const LEASE_MS = 330_000;
const CONCURRENCY = 10;
const scopeSql = (scope: string) => (scope === "all" ? "1=1" : "duda_status = 'PUBLISHED'");

export async function latestRun(): Promise<(HealthRun & { stale: boolean }) | null> {
  const r = await one<HealthRun & { lease_until: number }>("SELECT id, status, scope, total, done, started_by, started_at, finished_at, lease_until FROM health_runs ORDER BY id DESC LIMIT 1");
  if (!r) return null;
  return { ...r, stale: ["queued", "running"].includes(r.status) && r.lease_until < Date.now() };
}

export async function startRun(scope: "published" | "all", by: string): Promise<{ run: HealthRun; token: string; existing: boolean }> {
  const cur = await latestRun();
  if (cur && ["queued", "running", "stopping"].includes(cur.status) && !cur.stale) return { run: cur, token: "", existing: true };
  if (cur?.stale) await run("UPDATE health_runs SET status = 'stopped', finished_at = datetime('now') WHERE id = ?", [cur.id]);
  const total = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM websites WHERE ${scopeSql(scope)}`))?.n || 0;
  const token = randomToken(32);
  const r = await run("INSERT INTO health_runs (scope, total, started_by, token_hash) VALUES (?, ?, ?, ?)", [scope, total, by, sha256(token)]);
  void r;
  return { run: (await latestRun())!, token, existing: false };
}

export async function stopRun() { await run("UPDATE health_runs SET status = CASE WHEN status = 'queued' THEN 'stopped' ELSE 'stopping' END WHERE status IN ('queued','running')"); }

export async function runToken(id: number, token: string) {
  const r = await one<{ token_hash: string }>("SELECT token_hash FROM health_runs WHERE id = ?", [id]);
  if (!r || !token) return false;
  const a = Buffer.from(r.token_hash), b = Buffer.from(sha256(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function rotateRunToken(id: number) {
  const token = randomToken(32);
  await run("UPDATE health_runs SET token_hash = ? WHERE id = ?", [sha256(token), id]);
  return token;
}

export async function processRun(id: number, token: string, handOff: (id: number, token: string) => Promise<void>) {
  const started = Date.now();
  const claim = await run("UPDATE health_runs SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END, lease_until = ? WHERE id = ? AND status IN ('queued','running','stopping') AND lease_until < ?", [Date.now() + LEASE_MS, id, Date.now()]);
  if (!claim.changes) return;
  for (;;) {
    const r = await one<{ status: string; scope: string; cursor_id: number }>("SELECT status, scope, cursor_id FROM health_runs WHERE id = ?", [id]);
    if (!r) return;
    if (r.status === "stopping") { await run("UPDATE health_runs SET status = 'stopped', finished_at = datetime('now'), lease_until = 0 WHERE id = ?", [id]); return; }
    const sites = await all<Site>(`SELECT ${SITE_COLS} FROM websites WHERE id > ? AND ${scopeSql(r.scope)} ORDER BY id LIMIT ?`, [r.cursor_id, CONCURRENCY * 4]);
    if (!sites.length) {
      await run("UPDATE health_runs SET status = 'done', finished_at = datetime('now'), lease_until = 0 WHERE id = ?", [id]);
      await notifyRunFinished(id).catch((e) => console.error("[websites] after-run alerts failed", e));
      return;
    }
    if (Date.now() - started > BUDGET_MS) {
      await run("UPDATE health_runs SET lease_until = 0 WHERE id = ?", [id]);
      await handOff(id, token).catch(() => { /* resumes on next visit */ });
      return;
    }
    // check this batch, CONCURRENCY at a time
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < sites.length) {
        const s = sites[i++];
        try { await saveCheck(s, await checkWebsite(s)); }
        catch (e) { await run("UPDATE websites SET health = 'down', health_detail = ?, checked_at = datetime('now') WHERE id = ?", [`Check failed: ${(e as Error).message.slice(0, 200)}`, s.id]); }
      }
    }));
    await run("UPDATE health_runs SET cursor_id = ?, done = done + ?, lease_until = ? WHERE id = ?", [sites[sites.length - 1].id, sites.length, Date.now() + LEASE_MS, id]);
  }
}

/* ---------------- automatic monitoring ---------------- */

export type HealthSettings = { schedule: "off" | "daily" | "weekly"; notLiveDays: number; tempDomainDays: number; gbpPerDay: number };
export async function healthSettings(): Promise<HealthSettings> {
  const r = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'health'");
  return { schedule: "weekly", ...DEFAULT_LAUNCH, gbpPerDay: 0, ...(r ? JSON.parse(r.value) : {}) };
}
export async function saveHealthSettings(patch: Partial<HealthSettings>) {
  const s = { ...(await healthSettings()), ...patch };
  await run("INSERT INTO settings (key, value) VALUES ('health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
}
/** Called by the daily Vercel cron: starts a full check if one is due. */
export async function scheduledRunDue() {
  const s = await healthSettings();
  if (s.schedule === "off") return false;
  const last = await latestRun();
  if (!last) return true;
  if (["queued", "running", "stopping"].includes(last.status) && !last.stale) return false;
  const age = Date.now() - Date.parse(last.started_at.replace(" ", "T") + (last.started_at.endsWith("Z") ? "" : "Z"));
  return age > (s.schedule === "daily" ? 20 : 6.5 * 24) * 3_600_000;
}

/* ---------------- export ---------------- */

const esc = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: WebsiteRow[], label: (h: string) => string, flagLabel: (f: string) => string) {
  const head = ["Site Name", "Site Alias", "Domain", "Duda Status", "Labels", "Creation date", "First publish date", "Last publish date", "Domain Health", "Health Detail", "Warnings", "Last Checked (UTC)", "Health Changed (UTC)", "Previous Health", "Domain Expires", "SSL Expires", "In Latest Import"];
  const lines = rows.map((r) => [r.site_name, r.alias, r.domain, r.duda_status, r.labels, r.created_at, r.first_publish, r.last_publish, label(r.health), r.health_detail,
    (JSON.parse(r.health_flags || "[]") as string[]).map(flagLabel).join("; "), r.checked_at, r.health_changed_at, r.prev_health ? label(r.prev_health) : "", r.domain_expires?.slice(0, 10), r.ssl_expires?.slice(0, 10), r.missing ? "No" : "Yes"].map(esc).join(","));
  return "﻿" + [head.join(","), ...lines].join("\r\n");
}
