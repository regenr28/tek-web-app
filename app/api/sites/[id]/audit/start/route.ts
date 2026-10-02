import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { startRun } from "@/lib/audit";

export const maxDuration = 60;
const Body = z.object({ ai: z.boolean().default(false), maxPages: z.number().int().min(1).max(150).default(60) });

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser();
  await rateLimit(`audit:${me.id}`, 60, 3600);
  const { ai, maxPages } = await parseBody(req, Body);
  return Response.json(await startRun(await idOf(ctx), me.id, ai, maxPages));
});
