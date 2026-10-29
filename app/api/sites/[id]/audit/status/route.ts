import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { auditStatus } from "@/lib/auditjob";
import { selfBase } from "@/lib/runner";

/** Progress of the audit (the latest one, or ?run=<id>). Also restarts workers that stopped answering. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const run = Number(new URL(req.url).searchParams.get("run")) || undefined;
  return Response.json(await auditStatus(id, selfBase(req), run));
});
