import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { one, all } from "@/lib/db";
import { uptimeStats, type UptimePoint, type Incident } from "@/lib/monitor";

const parse = <T,>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** Full details for one website: last check, uptime history, incidents, GBP check and its recent alerts. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "websites" });
  const id = await idOf(ctx);
  const r = await one<{ health_json: string | null; uptime_json: string | null; incidents_json: string | null; gbp_json: string | null; gbp_checked_at: string | null }>(
    "SELECT health_json, uptime_json, incidents_json, gbp_json, gbp_checked_at FROM websites WHERE id = ?", [id]);
  if (!r) throw new HttpError(404, "Not found");
  const points = parse<UptimePoint[]>(r.uptime_json, []);
  const alerts = await all("SELECT id, at, kind, title, detail FROM website_events WHERE website_id = ? ORDER BY id DESC LIMIT 20", [id]);
  return Response.json({
    info: parse(r.health_json, null),
    uptime: { points: points.slice(-90), d30: uptimeStats(points, 30), d90: uptimeStats(points, 90) },
    incidents: parse<Incident[]>(r.incidents_json, []).slice().reverse(),
    gbp: r.gbp_json ? { ...parse<Record<string, unknown>>(r.gbp_json, {}), checkedAt: r.gbp_checked_at } : null,
    alerts,
  });
});
