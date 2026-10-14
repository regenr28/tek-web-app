import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit, logEvent, HttpError } from "@/lib/security";
import { loadProject } from "@/lib/projects";
import { latestJob } from "@/lib/runner";
import { reviseField } from "@/lib/revise";
import { toSheetTsv, toPlainText, sheetRows, forClient } from "@/lib/collect";

export const maxDuration = 120;

/** "Request a change" on one field: rewrite it, search again for it, or undo the last change. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`revise:${me.id}`, 120, 3600);
  const body = await parseBody(req, z.object({
    key: z.string().regex(/^[a-zA-Z]{2,40}$/),
    loc: z.number().int().min(0).max(50).optional(),
    request: z.string().max(600).optional(),
    undo: z.boolean().optional(),
  }).strict());
  const id = await idOf(ctx);
  const j = await latestJob(id);
  if (j && !j.stale && ["queued", "running", "stopping"].includes(j.status)) throw new HttpError(409, "Research is still running for this project — try again when it finishes.");
  const { ok, summary } = await reviseField(id, body);
  await logEvent("collection.revise", me.id, { site: id, key: body.key, undo: !!body.undo });
  const c = (await loadProject(id)).collection;
  return Response.json({ ok, summary, collection: forClient(c), tsv: toSheetTsv(c), text: toPlainText(c), rows: sheetRows(c) });
});
