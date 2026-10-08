import { one } from "@/lib/db";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { dudaEnabled, dudaBusinessInfo, guessSiteName } from "@/lib/duda";

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  if (!dudaEnabled()) throw new HttpError(400, "Duda API isn't configured. Add DUDA_API_USERNAME and DUDA_API_PASSWORD in Vercel env.");
  const id = await idOf(ctx);
  const s = await one<{ duda_site_id: string | null; preview_url: string }>("SELECT duda_site_id, preview_url FROM sites WHERE id = ?", [id]);
  if (!s) throw new HttpError(404, "Site not found");
  const siteName = s.duda_site_id || guessSiteName(s.preview_url);
  if (!siteName) throw new HttpError(400, "Set the Duda site ID on this site first");
  return Response.json({ facts: await dudaBusinessInfo(siteName), siteName });
});
