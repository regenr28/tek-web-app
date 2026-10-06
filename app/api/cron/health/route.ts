import { after } from "next/server";
import { timingSafeEqual } from "crypto";
import { scheduledRunDue, startRun, processRun } from "@/lib/websites";
import { selfBase, makeHandOff } from "@/lib/runner";

export const maxDuration = 300;

/** Vercel Cron (daily): starts the automatic domain check when it's due. Protected by CRON_SECRET. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET || "";
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return Response.json({ error: "Not allowed" }, { status: 401 });
  if (!(await scheduledRunDue())) return Response.json({ started: false });
  const { run, token, existing } = await startRun("published", "Automatic (scheduled)");
  if (!existing) { const h = makeHandOff(selfBase(req), "/api/websites/run/{id}/continue"); after(() => processRun(run.id, token, h)); }
  return Response.json({ started: !existing, run: run.id });
}
