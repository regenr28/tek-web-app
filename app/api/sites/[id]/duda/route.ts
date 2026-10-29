import { one } from "@/lib/db";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { dudaEnabled, dudaBusinessInfo, siteIdFrom } from "@/lib/duda";

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  if (!dudaEnabled()) throw new HttpError(400, "Reading site settings isn't set up yet (Vercel env DUDA_API_USERNAME / DUDA_API_PASSWORD).");
  const id = await idOf(ctx);
  const s = await one<{ duda_site_id: string | null; preview_url: string; editor_url: string | null }>("SELECT duda_site_id, preview_url, editor_url FROM sites WHERE id = ?", [id]);
  if (!s) throw new HttpError(404, "Site not found");
  const siteName = siteIdFrom(s);
  if (!siteName) throw new HttpError(400, "Set the Duda site ID on this site first");
  return Response.json({ facts: await dudaBusinessInfo(siteName), siteName });
});
