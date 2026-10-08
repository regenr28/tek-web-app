import { all, one } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";

/** CSV cell escaping + formula-injection guard: crawled text like "=HYPERLINK(...)" must never run in Excel/Sheets. */
const esc = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const all_ = new URL(req.url).searchParams.get("all") === "1";
  const site = await one<{ name: string }>("SELECT name FROM sites WHERE id = ?", [id]);
  const rows = await all<Record<string, unknown>>(`
    SELECT f.status, f.severity, f.category, f.page_path, f.selector, f.message, f.found, f.expected, f.source, a.name AS assignee, f.note, f.page_url
    FROM findings f LEFT JOIN users a ON a.id = f.assignee_id WHERE f.site_id = ? ${all_ ? "" : "AND f.status = 'open'"}
    ORDER BY f.page_path, f.severity`, [id]);
  const head = ["Status", "Severity", "Category", "Page", "CSS selector", "Finding", "Found", "Expected", "Source", "Assignee", "Note", "URL"];
  const csv = "\uFEFF" + [head.join(","), ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n");
  const fname = (site?.name || "site").replace(/[^\w-]+/g, "-") + "-audit.csv";
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${fname}"`, "X-Content-Type-Options": "nosniff" } });
});
