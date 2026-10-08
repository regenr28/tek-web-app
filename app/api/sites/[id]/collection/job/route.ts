import { after } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { createJob, latestJob, stopJob, runJob, rotateToken, selfBase, makeHandOff, JOB_STEPS, type JobStep } from "@/lib/runner";

export const maxDuration = 300;

/** Progress of the latest research run for this project (resumes a run whose hand-off was lost). */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const job = await latestJob(id);
  if (job?.stale) {
    const token = await rotateToken(job.id);
    const handOff = makeHandOff(selfBase(req));
    after(() => runJob(job.id, token, handOff));
  }
  return Response.json({ job: job ? { id: job.id, status: job.stale ? "running" : job.status, steps: job.steps, idx: job.idx, log: job.log, updated_at: job.updated_at } : null });
});

const Body = z.union([
  z.object({ steps: z.array(z.enum(JOB_STEPS as [JobStep, ...JobStep[]])).min(1).max(JOB_STEPS.length) }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);

/** Start research in the background ({steps}) or stop it after the current step ({action:"stop"}). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const b = await parseBody(req, Body);
  if ("action" in b) { await stopJob(id); return Response.json({ ok: true }); }
  await rateLimit(`research:${me.id}`, 60, 3600);
  const { job, token, existing } = await createJob(id, b.steps, me.id);
  if (!existing) {
    const handOff = makeHandOff(selfBase(req));
    after(() => runJob(job.id, token, handOff));
  }
  return Response.json({ job: { id: job.id, status: job.status, steps: job.steps, idx: job.idx, log: job.log }, existing });
});
