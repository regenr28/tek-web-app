import { all, one, run } from "./db";
import { sendPush, pushSubject, type PushMessage } from "./push";
import { summarize, type EventKind } from "./monitor";
import { stagingSql } from "./health";

/** Alerts for sites that are only on the temporary tekmetric.site address aren't real outages. */
const LIVE_ONLY = `NOT ${stagingSql("COALESCE(w.domain, '')")}`;

/** "What changed" feed for All Websites + browser push to the people who turned alerts on. */

export type AlertRow = { id: number; website_id: number; at: string; kind: EventKind; health: string; title: string; detail: string; site_name: string; domain: string };

export async function recentAlerts(limit = 200): Promise<AlertRow[]> {
  return all<AlertRow>(`SELECT e.id, e.website_id, e.at, e.kind, e.health, e.title, e.detail, COALESCE(w.site_name, '') AS site_name, COALESCE(w.domain, '') AS domain
    FROM website_events e LEFT JOIN websites w ON w.id = e.website_id WHERE ${LIVE_ONLY} ORDER BY e.id DESC LIMIT ?`, [limit]);
}
export async function lastSeen(userId: number) {
  const r = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [`alerts_seen:${userId}`]);
  return r ? Number(r.value) || 0 : 0;
}
export async function markSeen(userId: number, id: number) {
  await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`alerts_seen:${userId}`, String(id)]);
}
export async function unreadCount(userId: number) {
  const seen = await lastSeen(userId);
  return (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM website_events e LEFT JOIN websites w ON w.id = e.website_id
    WHERE e.id > ? AND e.kind IN ('down','changed','warning','recovered') AND ${LIVE_ONLY}`, [seen]))?.n || 0;
}

/** Sends a notification to everyone who turned alerts on (and can still see All Websites). Removes dead subscriptions. */
export async function notifyAll(msg: PushMessage, onlyUser?: number): Promise<{ sent: number; failed: number }> {
  const subs = await all<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subs s JOIN users u ON u.id = s.user_id
     WHERE u.active = 1 AND (u.role = 'super_admin' OR u.access IN ('all', 'websites')) ${onlyUser ? "AND u.id = ?" : ""}`, onlyUser ? [onlyUser] : []);
  let sent = 0, failed = 0;
  const subject = pushSubject();
  await Promise.all(subs.map(async (s) => {
    try {
      const status = await sendPush(s, msg, subject);
      if (status === 404 || status === 410) { await run("DELETE FROM push_subs WHERE id = ?", [s.id]); failed++; }
      else if (status >= 400) failed++;
      else { sent++; await run("UPDATE push_subs SET last_ok_at = datetime('now') WHERE id = ?", [s.id]); }
    } catch (e) { failed++; console.error("[push] send failed", (e as Error).message); }
  }));
  return { sent, failed };
}

/** After a full "check all": one notification summing up what changed during that run (nothing when nothing changed). */
export async function notifyRunFinished(runId: number) {
  const r = await one<{ started_at: string }>("SELECT started_at FROM health_runs WHERE id = ?", [runId]);
  if (!r) return;
  const rows = await all<{ kind: EventKind; n: number }>(`SELECT e.kind, COUNT(*) AS n FROM website_events e LEFT JOIN websites w ON w.id = e.website_id
    WHERE e.at >= ? AND ${LIVE_ONLY} GROUP BY e.kind`, [r.started_at]);
  const counts = Object.fromEntries(rows.map((x) => [x.kind, x.n])) as Partial<Record<EventKind, number>>;
  const text = summarize(counts);
  if (!text) return;
  const down = await all<{ site_name: string; domain: string }>(`SELECT w.site_name, w.domain FROM website_events e JOIN websites w ON w.id = e.website_id
    WHERE e.at >= ? AND e.kind = 'down' AND ${LIVE_ONLY} ORDER BY e.id LIMIT 3`, [r.started_at]);
  await notifyAll({
    title: counts.down ? `⚠ ${counts.down} website${counts.down > 1 ? "s" : ""} went down` : "All Websites check: changes found",
    body: down.length ? `${down.map((d) => d.domain || d.site_name).join(", ")}${(counts.down || 0) > 3 ? "…" : ""} · ${text}` : text,
    url: "/websites?alerts=1", tag: `run-${runId}`,
  });
}
