import { after } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { startAuditJob, runWorker } from "@/lib/auditjob";
import { selfBase } from "@/lib/runner";

export const maxDuration = 300;
const Body = z.object({ aiCopy: z.boolean().default(false), aiAlt: z.boolean().default(false), aiGlobal: z.boolean().default(true), maxPages: z.number().int().min(1).max(150).default(60) });

/** Starts the audit on the server (it keeps running when you leave the page). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`audit:${me.id}`, 60, 3600);
  const o = await parseBody(req, Body);
  const id = await idOf(ctx);
  const { runId, token, existing } = await startAuditJob(id, me.id, o);
  if (!existing) { const base = selfBase(req); after(() => runWorker(runId, base, token)); }
  return Response.json({ runId, existing }, { status: existing ? 200 : 202 });
});
