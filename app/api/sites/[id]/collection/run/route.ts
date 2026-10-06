import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { loadProject } from "@/lib/projects";
import { runStep, STEP_IDS } from "@/lib/runner";
import type { StepId } from "@/lib/research";
import { toSheetTsv, toPlainText, sheetRows, forClient } from "@/lib/collect";

export const maxDuration = 300; // Apify GBP lookups can take up to ~2.5 minutes

/** Runs one research step right away (the page uses background jobs; this stays for scripts/tests). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser();
  await rateLimit(`research:${me.id}`, 200, 3600);
  const { step } = await parseBody(req, z.object({ step: z.enum(STEP_IDS as [StepId, ...StepId[]]) }));
  const id = await idOf(ctx);
  const { ok, summary } = await runStep(id, step);
  const c = (await loadProject(id)).collection;
  return Response.json({ ok, summary, collection: forClient(c), tsv: toSheetTsv(c), text: toPlainText(c), rows: sheetRows(c) });
});
