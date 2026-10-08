import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, rateLimit, logEvent } from "@/lib/security";
import { checkGbp, checkGbpBatch } from "@/lib/gbpcheck";

export const maxDuration = 300;

/** GBP website check: one site ({id}) or a capped batch ({batch: n}, admins) — each uses one Maps search credit. */
export const POST = handle(async (req: Request) => {
  const b = await parseBody(req, z.union([z.object({ id: z.number().int().positive() }).strict(), z.object({ batch: z.number().int().min(1).max(50) }).strict()]));
  if ("id" in b) {
    const me = await requireUser("member", { area: "websites" });
    await rateLimit(`gbp:${me.id}`, 60, 3600);
    return Response.json(await checkGbp(b.id));
  }
  const me = await requireUser("admin", { area: "websites" });
  await rateLimit(`gbp-batch:${me.id}`, 60, 3600);
  const r = await checkGbpBatch(b.batch, 240_000);
  await logEvent("websites.gbp_batch", me.id, { done: r.done });
  return Response.json(r);
});
