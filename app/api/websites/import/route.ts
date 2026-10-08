import { handle, requireUser, HttpError } from "@/lib/auth";
import { rateLimit, logEvent } from "@/lib/security";
import { importSiteList } from "@/lib/websites";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Import Duda's "Export site list" CSV. New Site Aliases are added; existing ones are never added twice. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("admin", { area: "websites" });
  await rateLimit(`websites-import:${me.id}`, 30, 3600);
  if (Number(req.headers.get("content-length") || 0) > 4.5 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose the site list CSV");
  if (!/\.csv$/i.test(file.name)) throw new HttpError(400, "Upload the .csv file from Duda (Sites → Export site list)");
  if (file.size > 4 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const r = await importSiteList(await file.text(), form.get("refresh") === "1");
  await logEvent("websites.imported", me.id, { added: r.added, skipped: r.skipped, refreshed: r.refreshed });
  return Response.json(r);
});
