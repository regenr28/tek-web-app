import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { finishRun } from "@/lib/audit";

export const maxDuration = 60;
export const POST = handle(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const { runId } = await parseBody(req, z.object({ runId: z.number().int().positive() }));
  return Response.json(await finishRun(await idOf(ctx), runId));
});
