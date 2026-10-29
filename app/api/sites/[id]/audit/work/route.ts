import { after } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/auth";
import { HttpError, parseBody, rateLimit } from "@/lib/security";
import { idOf, type Ctx } from "@/lib/http";
import { checkRunToken, runWorker } from "@/lib/auditjob";
import { selfBase } from "@/lib/runner";

export const maxDuration = 300;

/** Server-to-server: one more audit worker. Needs the run's secret token (no login). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const id = await idOf(ctx);
  await rateLimit(`audit-work:${id}`, 600, 3600);
  const { runId } = await parseBody(req, z.object({ runId: z.number().int().positive() }));
  const token = req.headers.get("x-run-token") || "";
  if (!(await checkRunToken(runId, token))) throw new HttpError(403, "Not allowed");
  const base = selfBase(req);
  after(() => runWorker(runId, base, token));
  return Response.json({ ok: true }, { status: 202 });
});
