import { all, one, run } from "@/lib/db";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { SitePatch, assertCrawlable } from "@/lib/validators";
import { normalizeFacts } from "@/lib/facts";
import { dudaEnabled } from "@/lib/duda";
import { aiAvailable } from "@/lib/ai";

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const s = await one<Record<string, unknown> & { facts_json: string | null; last_run_id: number | null }>("SELECT * FROM sites WHERE id = ?", [id]);
  if (!s) throw new HttpError(404, "Site not found");
  const lastRun = s.last_run_id ? await one("SELECT r.*, u.name AS started_by_name FROM runs r LEFT JOIN users u ON u.id = r.started_by WHERE r.id = ?", [s.last_run_id]) : null;
  const pages = s.last_run_id ? await all("SELECT id, url, path, title, status_code, error FROM pages WHERE run_id = ? ORDER BY length(path), path", [s.last_run_id]) : [];
  const { facts_json, jira_json, collection_json: _c, research_json: _r, ...rest } = s as typeof s & { jira_json?: string | null; collection_json?: string | null; research_json?: string | null };
  return Response.json({
    site: { ...rest, has_project: !!jira_json, facts: facts_json ? normalizeFacts(JSON.parse(facts_json)) : null },
    lastRun, pages, dudaApi: dudaEnabled(), ai: await aiAvailable(),
  });
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const b = await parseBody(req, SitePatch);
  if (b.preview_url) await assertCrawlable(b.preview_url);
  const sets: string[] = [], args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`); // keys are limited to the SitePatch schema (strict)
    args.push(v === "" ? null : (v as string | number | null));
  }
  if (!sets.length) return Response.json({ ok: true });
  await run(`UPDATE sites SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...args, id]);
  return Response.json({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("admin");
  const id = await idOf(ctx);
  for (const t of ["findings", "pages", "runs"]) await run(`DELETE FROM ${t} WHERE site_id = ?`, [id]);
  await run("DELETE FROM sites WHERE id = ?", [id]);
  return Response.json({ ok: true });
});
