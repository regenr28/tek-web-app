import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { rateLimit, HttpError } from "@/lib/security";
import { one } from "@/lib/db";
import { scopeFor, scoped } from "@/lib/crawl";
import { screenshotElement, type Device } from "@/lib/render";

export const maxDuration = 60;

/** A screenshot of the page with the finding's element outlined — so you can see it without opening the site. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`shot:${me.id}`, 300, 3600);
  const id = await idOf(ctx);
  const f = await one<{ page_url: string | null; selector: string | null; found: string | null; preview_url: string }>(
    "SELECT f.page_url, f.selector, f.found, s.preview_url FROM findings f JOIN sites s ON s.id = f.site_id WHERE f.id = ?", [id]);
  if (!f || !f.page_url) throw new HttpError(404, "This finding isn't tied to one page");
  // only pages of this site's preview can be opened
  if (!f.preview_url || !scoped(f.page_url, scopeFor(f.preview_url))) throw new HttpError(400, "That page isn't part of this site's preview");
  const dev = new URL(f.page_url).searchParams.get("dm_device");
  const device: Device = dev === "mobile" || dev === "tablet" ? dev : "desktop";
  const found = (f.found || "").split(" — alt:")[0].split(" → ")[0];
  const r = await screenshotElement(f.page_url, device, f.selector || "", found);
  return new Response(Buffer.from(r.png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=600", "X-Element-Found": r.found ? "1" : "0" } });
});
