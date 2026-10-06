import { after } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, rateLimit, logEvent } from "@/lib/security";
import { latestRun, startRun, stopRun, processRun, rotateRunToken } from "@/lib/websites";
import { selfBase, makeHandOff } from "@/lib/runner";

export const maxDuration = 300;
const HANDOFF = "/api/websites/run/{id}/continue";

/** Progress of the latest "check all" (and resumes it if its hand-off was lost). */
export const GET = handle(async (req: Request) => {
  await requireUser();
  const r = await latestRun();
  if (r?.stale) { const token = await rotateRunToken(r.id); const h = makeHandOff(selfBase(req), HANDOFF); after(() => processRun(r.id, token, h)); }
  return Response.json({ run: r ? { ...r, status: r.stale ? "running" : r.status } : null });
});

const Body = z.union([z.object({ scope: z.enum(["published", "all"]) }).strict(), z.object({ action: z.literal("stop") }).strict()]);

/** Start checking every domain in the background, or stop. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, Body);
  if ("action" in b) { await stopRun(); return Response.json({ ok: true }); }
  await rateLimit(`health-run:${me.id}`, 20, 3600);
  const { run, token, existing } = await startRun(b.scope, me.name);
  if (!existing) { const h = makeHandOff(selfBase(req), HANDOFF); after(() => processRun(run.id, token, h)); await logEvent("websites.check_all", me.id, { scope: b.scope, total: run.total }); }
  return Response.json({ run, existing });
});
