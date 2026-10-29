import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { rateLimit, HttpError } from "@/lib/security";
import { one } from "@/lib/db";
import { scopeFor, scoped } from "@/lib/crawl";
import { deviceUrl, type Device } from "@/lib/render";
import { viewerPage } from "@/lib/viewer";

export const maxDuration = 60;

/** "Show on page": the page rendered for desktop / tablet / mobile, scrolled to the finding and outlined. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`view:${me.id}`, 600, 3600);
  const id = await idOf(ctx);
  const f = await one<{ page_url: string | null; page_path: string; selector: string | null; found: string | null; message: string; preview_url: string; category: string; rule: string }>(
    "SELECT f.page_url, f.page_path, f.selector, f.found, f.message, f.category, f.rule, s.preview_url FROM findings f JOIN sites s ON s.id = f.site_id WHERE f.id = ?", [id]);
  if (!f || !f.page_url) throw new HttpError(404, "This finding isn't tied to one page");
  if (!f.preview_url || !scoped(f.page_url, scopeFor(f.preview_url))) throw new HttpError(400, "That page isn't part of this site's preview");
  const q = new URL(req.url).searchParams.get("device");
  const fromUrl = new URL(f.page_url).searchParams.get("dm_device");
  const device: Device = q === "mobile" || q === "tablet" || q === "desktop" ? q : fromUrl === "mobile" || fromUrl === "tablet" ? fromUrl : "desktop";
  const found = f.found || "";
  const file = (found.match(/^([^\s/]+\.(?:jpe?g|png|webp|gif|svg|avif))\b/i)?.[1] || "").trim();
  // the words to look for: "Learn more (in “…”)" → "Learn more", "H2 “Welcome” → H4 “Tom”" → "Welcome", "Book → /x" → "Book"
  let text = file ? "" : found.split(" — alt:")[0].replace(/ → (?![^“]*”).*$/, "").replace(/\s*\(in “[^”]*”?\)?\s*$/, "").replace(/\s*\((hidden on|desktop|tablet|mobile)[^)]*\)$/, "");
  const q1 = text.match(/“([^”]{3,})”/);
  if (q1 && /^(H\d|Text|“)/.test(text)) text = q1[1];
  text = text.split(" → ")[0].replace(/^H\d:\s*/, "").split(" · ")[0].replace(/^“|”$/g, "").trim();
  const headSel = (f.selector || "") === "head" || !f.selector;
  const seoRule = /^(title|meta|duplicate-|page-meta|item-meta|ai-title|ai-seo|site-meta)/.test(f.rule);
  const h1Rule = /^(h1-|heading-)/.test(f.rule);
  // meta title / description findings show the page's SEO; H1 findings outline the H1s; other "head" findings
  // (Business Info in structured data, site settings, widgets) aren't one spot on the page — the viewer says so
  const target = {
    selector: f.selector || "", text: /^\(icon\)$/.test(text) ? "" : text, href: (found.match(/ → (\S+)\s*$/)?.[1] || "").slice(0, 500), file, message: f.message.slice(0, 220), rule: f.rule,
    devices: (f.message.match(/\(((?:desktop|tablet|mobile)(?: \+ (?:desktop|tablet|mobile))*) only\)$/)?.[1] || "desktop + tablet + mobile").split(" + "),
    head: headSel && seoRule, h1: headSel && h1Rule,
    settings: f.page_path === "Site settings" || (headSel && !seoRule && !h1Rule && !file && (!text || /Business Info|Site settings|Business text|Redirects/.test(f.category))),
  };
  const { html, csp } = await viewerPage(deviceUrl(f.page_url.replace(/([?&])dm_device=[^&]*&?/, "$1").replace(/[?&]$/, ""), device), device, target);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
});
