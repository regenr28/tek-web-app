import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { finishRun } from "@/lib/audit";

export const maxDuration = 180; // site-wide checks + AI judgements (menu, titles, SEO text, amenities, reviews)
export const POST = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const { runId, skipped } = await parseBody(req, z.object({ runId: z.number().int().positive(), skipped: z.array(z.string().max(200)).max(50).optional() }));
  return Response.json(await finishRun(await idOf(ctx), runId, skipped || []));
});
