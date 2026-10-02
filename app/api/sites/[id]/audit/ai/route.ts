import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { aiPage } from "@/lib/audit";
import { AiError } from "@/lib/ai";

export const maxDuration = 60;
const Body = z.object({ runId: z.number().int().positive(), pageId: z.number().int().positive(), kind: z.enum(["copy", "alt"]), includeGlobal: z.boolean().default(false) });

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser();
  await rateLimit(`ai:${me.id}`, 400, 3600);
  const { runId, pageId, kind, includeGlobal } = await parseBody(req, Body);
  try {
    return Response.json(await aiPage(await idOf(ctx), runId, pageId, kind, includeGlobal));
  } catch (e) {
    if (e instanceof AiError) throw new HttpError(502, e.message);
    throw e;
  }
});
