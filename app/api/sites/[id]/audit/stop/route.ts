import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { stopAuditJob } from "@/lib/auditjob";

/** Stops the audit: pages not started are skipped; the site-wide checks still run on what was checked. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  return Response.json({ runId: await stopAuditJob(await idOf(ctx)) });
});
