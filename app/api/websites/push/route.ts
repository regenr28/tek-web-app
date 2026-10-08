import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { parseBody, rateLimit, logEvent } from "@/lib/security";
import { all, one, run } from "@/lib/db";
import { vapid, validEndpoint } from "@/lib/push";
import { notifyAll } from "@/lib/alerts";

/** Browser alerts: the key the browser needs to subscribe, and how many devices I have turned on. */
export const GET = handle(async () => {
  const me = await requireUser("member", { area: "websites" });
  const devices = await all<{ endpoint: string; label: string; created_at: string; last_ok_at: string | null }>("SELECT endpoint, label, created_at, last_ok_at FROM push_subs WHERE user_id = ? ORDER BY id", [me.id]);
  return Response.json({ publicKey: (await vapid()).publicKey, devices });
});

const Body = z.union([
  z.object({ subscription: z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(100) }) }), label: z.string().max(80).optional() }),
  z.object({ test: z.literal(true) }).strict(),
  z.object({ remove: z.string().max(1000) }).strict(),
]);

/** Turn alerts on for this browser ({subscription}), send a test ({test}) or turn a device off ({remove}). */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "websites" });
  await rateLimit(`push:${me.id}`, 60, 3600);
  const b = await parseBody(req, Body);
  if ("test" in b) {
    const r = await notifyAll({ title: "Test alert ✓", body: "Alerts are working on this device. You'll get one when a domain check finds a site down.", url: "/websites?alerts=1", tag: "test" }, me.id);
    if (!r.sent) throw new HttpError(400, r.failed ? "Couldn't deliver the test — turn alerts off and on again on this device." : "No device with alerts on yet.");
    return Response.json(r);
  }
  if ("remove" in b) { await run("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?", [me.id, b.remove]); return Response.json({ ok: true }); }
  const { endpoint, keys } = b.subscription;
  if (!validEndpoint(endpoint)) throw new HttpError(400, "That browser's push service isn't supported");
  const n = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?", [me.id]))?.n || 0;
  if (n >= 10) throw new HttpError(400, "Alerts are on for 10 devices already — turn one off first");
  await run(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, label) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`, [me.id, endpoint, keys.p256dh, keys.auth, (b.label || "").slice(0, 80)]);
  await logEvent("websites.alerts_on", me.id, { label: b.label || "" });
  return Response.json({ ok: true });
});
