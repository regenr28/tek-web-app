import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody } from "@/lib/security";
import { listWebsites, toCsv } from "@/lib/websites";
import { HEALTH_LABEL, FLAG_LABEL, type Health, type Flag } from "@/lib/health";

export const maxDuration = 30;

/** Report as CSV — the rows currently shown (ids from the page's filters), or everything. */
export const POST = handle(async (req: Request) => {
  await requireUser("member", { area: "websites" });
  const { ids } = await parseBody(req, z.object({ ids: z.array(z.number().int().positive()).max(50000).optional() }).strict());
  let rows = await listWebsites();
  if (ids) { const byId = new Map(rows.map((r) => [r.id, r])); rows = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r); } // same order as on screen
  const csv = toCsv(rows, (h) => HEALTH_LABEL[h as Health] || h, (f) => FLAG_LABEL[f as Flag] || f);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="website-health-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
