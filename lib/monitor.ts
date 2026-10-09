/**
 * Monitoring on top of the domain health check: uptime history, incidents, the "What changed" alert feed and the
 * launch tracker. Pure functions here (easy to test); websites.ts stores the results.
 */

/** One check result, kept per site (newest last). t = ISO time, h = health, ms = load time. */
export type UptimePoint = { t: string; h: string; ms?: number };
/** A stretch of time the site was down; `end` is empty while it's still down. */
export type Incident = { start: string; end?: string; h: string; detail: string };

/** Up = live on Duda. Down = the site doesn't load for visitors. Other results (moved off Duda, redirects…) don't count either way. */
export const UP = new Set(["ok"]);
export const DOWN = new Set(["down", "dns", "ssl", "error", "not_found", "parked"]);
const KEEP_POINTS = 180;
const KEEP_INCIDENTS = 30;

export function addPoint(list: UptimePoint[], p: UptimePoint): UptimePoint[] {
  return [...list, p].slice(-KEEP_POINTS);
}

/** Opens an incident when a site goes down, closes it when it's back up. */
export function trackIncidents(list: Incident[], prev: string, next: string, detail: string, at: string): Incident[] {
  const out = [...list];
  const open = out.length && !out[out.length - 1].end ? out[out.length - 1] : null;
  if (DOWN.has(next) && !open) out.push({ start: at, h: next, detail: detail.slice(0, 200) });
  else if (open && !DOWN.has(next)) open.end = at;
  else if (open && DOWN.has(next) && next !== open.h) { open.h = next; open.detail = detail.slice(0, 200); }
  void prev;
  return out.slice(-KEEP_INCIDENTS);
}

/** Uptime over the last `days` days from the stored checks (null when nothing counted yet). */
export function uptimeStats(points: UptimePoint[], days = 30, now = Date.now()) {
  const since = now - days * 86_400_000;
  const recent = points.filter((p) => Date.parse(p.t) >= since);
  const up = recent.filter((p) => UP.has(p.h)).length, down = recent.filter((p) => DOWN.has(p.h)).length;
  const counted = up + down;
  return { checks: recent.length, up, down, pct: counted ? Math.round((up / counted) * 1000) / 10 : null };
}

/* ---------------- alert feed ("What changed") ---------------- */

export type EventKind = "down" | "recovered" | "changed" | "warning" | "cleared";
export type SiteEvent = { kind: EventKind; health: string; title: string; detail: string };

/** Warnings worth an alert (not "slow" — it comes and goes — and not the staging address). */
export const ALERT_FLAGS = new Set(["domain_expiring", "domain_hold", "ssl_expiring", "other_duda_site", "gbp_other", "gbp_none"]);

/**
 * What to tell the team after a check. Nothing for the very first check of a site (no "before" to compare with).
 * labels: health → label, flagLabels: flag → label.
 */
export function eventsFor(prev: { health: string; flags: string[] }, next: { health: string; flags: string[]; detail: string },
  labels: Record<string, string>, flagLabels: Record<string, string>): SiteEvent[] {
  if (["unchecked", "skipped", "temp", ""].includes(prev.health) || next.health === "temp") return [];
  const ev: SiteEvent[] = [];
  const L = (h: string) => labels[h] || h;
  if (prev.health !== next.health) {
    if (next.health === "ok") ev.push({ kind: "recovered", health: next.health, title: `Back up — ${L(next.health)}`, detail: `Was “${L(prev.health)}”. ${next.detail}` });
    else if (prev.health === "ok" && DOWN.has(next.health)) ev.push({ kind: "down", health: next.health, title: `Down — ${L(next.health)}`, detail: next.detail });
    else ev.push({ kind: "changed", health: next.health, title: `${L(prev.health)} → ${L(next.health)}`, detail: next.detail });
  }
  for (const f of next.flags) if (ALERT_FLAGS.has(f) && !prev.flags.includes(f)) ev.push({ kind: "warning", health: next.health, title: flagLabels[f] || f, detail: next.detail });
  return ev;
}

/** One line for a push notification / summary after a full check. */
export function summarize(counts: Partial<Record<EventKind, number>>): string {
  const parts = [
    counts.down ? `${counts.down} went down` : "",
    counts.recovered ? `${counts.recovered} back up` : "",
    counts.changed ? `${counts.changed} changed` : "",
    counts.warning ? `${counts.warning} new warning${counts.warning > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/* ---------------- launch tracker ---------------- */

const STAGING = /\.(tekmetric\.site|shopgenie\.site|multiscreensite\.com|dudaone\.com|mydudapreview\.com)$/i;
export type LaunchSettings = { notLiveDays: number; tempDomainDays: number };
export const DEFAULT_LAUNCH: LaunchSettings = { notLiveDays: 30, tempDomainDays: 14 };
export type LaunchFlag = "not_launched" | "temp_domain" | "billing_failed";
export const LAUNCH_LABEL: Record<LaunchFlag, string> = {
  not_launched: "Not published yet",
  temp_domain: "Live only on the temporary domain (DNS not connected?)",
  billing_failed: "Duda billing failed",
};

/**
 * Sites that may be paid for but not really live (e.g. a shop waiting months for DNS):
 * not published N days after creation, or published but still only on the tekmetric.site address.
 */
export function launchStatus(r: { duda_status: string; domain: string; created_at: string | null; first_publish: string | null; billing_failed?: number },
  s: LaunchSettings = DEFAULT_LAUNCH, now = Date.now()): { flags: LaunchFlag[]; days: number | null } {
  const days = (iso: string | null) => (iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : null);
  const flags: LaunchFlag[] = [];
  let age: number | null = null;
  const created = days(r.created_at);
  if (r.duda_status !== "PUBLISHED") {
    if (created !== null && created >= s.notLiveDays && r.duda_status !== "DELETED") { flags.push("not_launched"); age = created; }
  } else if (STAGING.test(r.domain)) {
    const since = days(r.first_publish) ?? created;
    if (since !== null && since >= s.tempDomainDays) { flags.push("temp_domain"); age = since; }
  }
  if (r.billing_failed) flags.push("billing_failed");
  return { flags, days: age };
}
