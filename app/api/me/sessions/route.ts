import { z } from "zod";
import { all, run } from "@/lib/db";
import { handle, requireUser, currentSessionId, destroyUserSessions } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";

export const GET = handle(async () => {
  const me = await requireUser("member", { setup: true });
  const cur = await currentSessionId();
  const rows = await all<{ id: string; created_at: string; last_seen: string; ip: string; user_agent: string }>(
    "SELECT id, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id = ? AND mfa_ok = 1 AND expires_at > datetime('now') ORDER BY last_seen DESC", [me.id]);
  // Session ids are hashes of the cookie; expose only a short prefix as a handle.
  return Response.json(rows.map((r) => ({ ref: r.id.slice(0, 12), created_at: r.created_at, last_seen: r.last_seen, ip: r.ip, user_agent: r.user_agent, current: r.id === cur })));
});

export const DELETE = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  const { ref } = await parseBody(req, z.object({ ref: z.string().regex(/^[a-f0-9]{12}$/).optional() }));
  if (ref) await run("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 12) = ?", [me.id, ref]);
  else await destroyUserSessions(me.id, true);
  await logEvent(ref ? "session.revoked" : "session.revoked_all_others", me.id);
  return Response.json({ ok: true });
});
