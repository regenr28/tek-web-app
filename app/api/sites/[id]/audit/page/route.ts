import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { auditOne } from "@/lib/audit";

export const maxDuration = 60;
const Body = z.object({ runId: z.number().int().positive(), url: z.string().max(2000), from: z.string().max(500).nullish() });

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`audit-page:${me.id}`, 1500, 3600);
  const { runId, url, from } = await parseBody(req, Body);
  // auditOne re-checks that the URL is inside this site's preview scope and that the run belongs to the site.
  return Response.json(await auditOne(await idOf(ctx), runId, url, from ?? undefined));
});
