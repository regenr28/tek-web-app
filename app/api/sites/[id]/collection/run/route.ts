import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { loadProject, saveProject, jiraRaw } from "@/lib/projects";
import { stepGbp, stepWebsite, stepSearch, stepAi, stepReview } from "@/lib/research";
import { toSheetTsv, toPlainText, sheetRows } from "@/lib/collect";

export const maxDuration = 60;

/** Runs one research step. Failures are recorded on the project, never lost, and the next step can still run. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser();
  await rateLimit(`research:${me.id}`, 200, 3600);
  const { step } = await parseBody(req, z.object({ step: z.enum(["gbp", "website", "search", "ai", "review"]) }));
  const id = await idOf(ctx);
  const p = await loadProject(id);
  if (!p.jira) throw new HttpError(400, "Import the Jira export first");
  const c = p.collection, ev = p.evidence;
  const raw = jiraRaw(p.jira.fields);
  let summary = "", ok = true;
  try {
    if (step === "gbp") summary = await stepGbp(c, ev);
    else if (step === "website") summary = await stepWebsite(c, ev);
    else if (step === "search") summary = await stepSearch(c, ev);
    else if (step === "ai") summary = await stepAi(c, ev, raw);
    else summary = await stepReview(c, raw);
  } catch (e) {
    ok = false;
    summary = (e as Error).message.slice(0, 300);
  }
  c.research[step] = { at: new Date().toISOString(), ok, summary };
  await saveProject(id, c, ev);
  return Response.json({ ok, summary, collection: c, tsv: toSheetTsv(c), text: toPlainText(c), rows: sheetRows(c) });
});
