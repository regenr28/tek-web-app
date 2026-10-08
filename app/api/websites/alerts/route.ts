import { z } from "zod";
import { handle, requireUser, canSee } from "@/lib/auth";
import { parseBody } from "@/lib/security";
import { recentAlerts, lastSeen, markSeen, unreadCount } from "@/lib/alerts";

/** "What changed": recent alerts + how many are new for me. ?count=1 → just the unread number (top bar badge). */
export const GET = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  if (!canSee(me, "websites") || me.setupRequired) return Response.json({ unread: 0, events: [] });
  if (new URL(req.url).searchParams.get("count")) return Response.json({ unread: await unreadCount(me.id) });
  const [events, seen] = await Promise.all([recentAlerts(200), lastSeen(me.id)]);
  return Response.json({ events, seen, unread: events.filter((e) => e.id > seen && e.kind !== "cleared").length });
});

/** Mark everything up to this alert as seen (per person). */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "websites" });
  const b = await parseBody(req, z.object({ seen: z.number().int().min(0) }).strict());
  await markSeen(me.id, b.seen);
  return Response.json({ ok: true });
});
