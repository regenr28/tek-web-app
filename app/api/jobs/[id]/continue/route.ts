import { after } from "next/server";
import { handle } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { HttpError, rateLimit } from "@/lib/security";
import { checkToken, runJob, selfBase, makeHandOff } from "@/lib/runner";

export const maxDuration = 300;

/** Server-to-server hand-off: continues a background research run. Needs the job's secret token (no login). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const id = await idOf(ctx);
  await rateLimit(`job-continue:${id}`, 30, 3600);
  const token = req.headers.get("x-job-token") || "";
  if (!(await checkToken(id, token))) throw new HttpError(403, "Not allowed");
  const handOff = makeHandOff(selfBase(req));
  after(() => runJob(id, token, handOff));
  return Response.json({ ok: true }, { status: 202 });
});
