import { after } from "next/server";
import { handle } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { HttpError, rateLimit } from "@/lib/security";
import { runToken, processRun } from "@/lib/websites";
import { selfBase, makeHandOff } from "@/lib/runner";

export const maxDuration = 300;

/** Server-to-server hand-off for a long "check all" run. Needs the run's secret token. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const id = await idOf(ctx);
  await rateLimit(`health-continue:${id}`, 60, 3600);
  const token = req.headers.get("x-job-token") || "";
  if (!(await runToken(id, token))) throw new HttpError(403, "Not allowed");
  const h = makeHandOff(selfBase(req), "/api/websites/run/{id}/continue");
  after(() => processRun(id, token, h));
  return Response.json({ ok: true }, { status: 202 });
});
