import { all } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const rows = await all(`
    SELECT f.*, a.name AS assignee_name, d.name AS done_by_name
    FROM findings f LEFT JOIN users a ON a.id = f.assignee_id LEFT JOIN users d ON d.id = f.done_by
    WHERE f.site_id = ?
    ORDER BY CASE f.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
             CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             CASE WHEN f.page_path LIKE 'Global%' OR f.page_path = 'Site-wide' THEN 0 ELSE 1 END, f.page_path, f.category, f.id`, [id]);
  return Response.json(rows);
});
