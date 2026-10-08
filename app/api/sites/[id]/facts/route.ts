import { z } from "zod";
import { run } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { FactsSchema } from "@/lib/validators";
import { normalizeFacts } from "@/lib/facts";

const Body = z.object({ facts: FactsSchema, source: z.string().max(200).optional(), rawText: z.string().max(60000).optional() });

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const { facts, source, rawText } = await parseBody(req, Body);
  const f = normalizeFacts(facts);
  await run(
    "UPDATE sites SET facts_json = ?, facts_source = COALESCE(?, facts_source), facts_raw_text = COALESCE(?, facts_raw_text), updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(f), source ?? null, rawText ?? null, id]
  );
  return Response.json({ ok: true, facts: f });
});
