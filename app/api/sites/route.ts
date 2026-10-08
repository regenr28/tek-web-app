import { all, run } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, rateLimit } from "@/lib/security";
import { SiteCreate, assertCrawlable } from "@/lib/validators";
import { guessSiteName } from "@/lib/duda";

export const GET = handle(async () => {
  await requireUser("member", { area: "projects" });
  const rows = await all(`
    SELECT s.id, s.name, s.preview_url, s.live_url, s.jira_key, s.status, s.assignee_id, s.updated_at, s.project_type, s.template, s.editor_url,
           u.name AS assignee_name, (s.facts_json IS NOT NULL) AS has_facts,
           r.started_at AS last_run_at, r.status AS last_run_status, r.page_count,
           (SELECT COUNT(*) FROM findings f WHERE f.site_id = s.id AND f.status = 'open') AS open_count,
           (SELECT j.status FROM jobs j WHERE j.site_id = s.id ORDER BY j.id DESC LIMIT 1) AS job_status,
           (SELECT COUNT(*) FROM findings f WHERE f.site_id = s.id AND f.status = 'open' AND f.severity = 'error') AS error_count,
           (SELECT COUNT(*) FROM findings f WHERE f.site_id = s.id AND f.status = 'done') AS done_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.assignee_id
    LEFT JOIN runs r ON r.id = s.last_run_id
    ORDER BY s.updated_at DESC`);
  return Response.json(rows);
});

export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`site-create:${me.id}`, 200, 3600);
  const b = await parseBody(req, SiteCreate);
  if (b.preview_url) await assertCrawlable(b.preview_url);
  const { lastId } = await run(
    "INSERT INTO sites (name, preview_url, live_url, jira_key, assignee_id, duda_site_id, created_by) VALUES (?,?,?,?,?,?,?)",
    [b.name, b.preview_url || "", b.live_url || null, b.jira_key || null, b.assignee_id || null, b.preview_url ? guessSiteName(b.preview_url) || null : null, me.id]
  );
  return Response.json({ id: lastId });
});
