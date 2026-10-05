import { handle, requireUser, HttpError } from "@/lib/auth";
import { rateLimit, logEvent } from "@/lib/security";
import { importJira } from "@/lib/projects";

export const runtime = "nodejs";
export const maxDuration = 30;

/** "Add Project": upload the Jira XLSX export → project + first Data Collection draft. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser();
  await rateLimit(`jira-import:${me.id}`, 120, 3600);
  if (Number(req.headers.get("content-length") || 0) > 4.5 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose the Jira XLSX export");
  if (!/\.xlsx$/i.test(file.name)) throw new HttpError(400, "Upload the .xlsx file from Jira (Export → Export Excel)");
  if (file.size > 4 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const r = await importJira(new Uint8Array(await file.arrayBuffer()), me.id);
  await logEvent("project.imported", me.id, { site: r.id, key: r.project.key, created: r.created });
  return Response.json({ id: r.id, created: r.created, key: r.project.key, name: r.project.shopName, type: r.project.typeLabel, template: r.project.template });
});
