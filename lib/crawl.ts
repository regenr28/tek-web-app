import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { safeFetch } from "./net";
import { getPolicy } from "./policy";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 DudaPreviewAudit/1.0";

export type Block = { id: number; tag: string; text: string; selector: string; global: boolean; quote?: boolean };
export type Img = { id: number; src: string; alt: string | null; selector: string; global: boolean; context: string; decorative: boolean };
export type Link = { href: string; abs: string; text: string; selector: string; global: boolean };
export type PageData = {
  url: string; finalUrl: string; status: number; title: string; metaDescription: string; linkedFrom?: string;
  h1s: string[]; headings: { level: number; text: string; selector: string }[];
  blocks: Block[]; images: Img[]; links: Link[]; html: string;
};

const SKIP = "script,style,noscript,template,svg,iframe,link,meta,[hidden],[aria-hidden='true'][style*='display: none'],[style*='display:none'],[style*='display: none']";
const GLOBAL_SEL = "header,footer,#hcontainer,#fcontainer,.dmHeader,.dmFooter,.dmHeaderContainer,.dmFooterContainer,#dm-footer,.dmNavigation,nav,[role=navigation],.main-navigation,#hamburger-drawer,#hamburger-header-container,#hamburger-header";
const FULL_TEXT_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "blockquote", "figcaption", "label", "button", "a", "dt", "dd", "caption", "address"]);

/** Fetches a page through the SSRF-safe client; only domains allowed in Settings → Security can be reached. */
export async function fetchHtml(url: string, timeoutMs = 20000) {
  const { crawlHosts } = await getPolicy();
  const res = await safeFetch(url, { hosts: crawlHosts, timeoutMs, maxBytes: 8 * 1024 * 1024, headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
  const type = res.headers.get("content-type") || "";
  const html = /html|xml|text/i.test(type) || !type ? res.text() : "";
  return { status: res.status, finalUrl: res.url, html };
}

// ---------- scope: which URLs belong to this preview ----------

export type Scope = { origin: string; basePath: string; keepQuery: URLSearchParams };

/** Duda preview links look like https://host/preview/abc123 or https://host/site/abc123?preview=true … keep that prefix + query. */
/**
 * Duda "share preview" links (…/preview/<siteId>?…) are only a device-switcher shell that iframes the real page.
 * The real, server-rendered preview lives at …/site/<siteId>?preview=true&insitepreview=true&dm_device=desktop,
 * and it doesn't need the preview_membership_auth token.
 */
export function resolveDudaUrl(input: string): string {
  const u = new URL(input.trim());
  const m = u.pathname.match(/^\/preview\/([\w-]+)(\/.*)?$/i);
  if (!m) return u.toString();
  const device = /mobile/i.test(u.searchParams.get("device") || "") ? "mobile" : /tablet/i.test(u.searchParams.get("device") || "") ? "tablet" : "desktop";
  const out = new URL(`${u.origin}/site/${m[1]}${m[2] && m[2] !== "/" ? m[2] : ""}`);
  out.search = new URLSearchParams({ preview: "true", insitepreview: "true", dm_device: device }).toString();
  return out.toString();
}

export function scopeFor(previewUrl: string): Scope {
  const u = new URL(resolveDudaUrl(previewUrl));
  const segs = u.pathname.split("/").filter(Boolean);
  let basePath = "/";
  const i = segs.findIndex((s) => ["preview", "site", "sites"].includes(s.toLowerCase()));
  if (i >= 0 && segs[i + 1]) basePath = "/" + segs.slice(0, i + 2).join("/");
  const keepQuery = new URLSearchParams();
  u.searchParams.forEach((v, k) => { if (/preview|nee|showOriginal|dm_|insitepreview|device/i.test(k)) keepQuery.set(k, v); });
  return { origin: u.origin, basePath, keepQuery };
}

/** Map a link into the preview scope. Duda previews sometimes link to "/about-us" instead of "/preview/<id>/about-us". */
export function scoped(abs: string, s: Scope): string | null {
  if (inScope(abs, s)) return abs;
  try {
    const u = new URL(abs);
    if (u.origin !== s.origin || s.basePath === "/") return null;
    if (/^\/(preview|site|sites)\//i.test(u.pathname)) return null; // a different preview
    if (/\.(pdf|jpe?g|png|gif|webp|svg|mp4|zip|docx?|xlsx?|ico|css|js|xml|txt)$/i.test(u.pathname)) return null;
    u.pathname = s.basePath + (u.pathname === "/" ? "" : u.pathname);
    return u.toString();
  } catch { return null; }
}

export function inScope(abs: string, s: Scope) {
  try {
    const u = new URL(abs);
    if (u.origin !== s.origin) return false;
    if (s.basePath !== "/" && !(u.pathname === s.basePath || u.pathname.startsWith(s.basePath + "/"))) return false;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|mp4|zip|docx?|xlsx?|ico|css|js|xml|txt)$/i.test(u.pathname)) return false;
    return true;
  } catch { return false; }
}

export function canonical(abs: string, s: Scope) {
  const u = new URL(abs);
  u.hash = "";
  const q = new URLSearchParams(s.keepQuery);
  u.search = q.toString() ? "?" + q.toString() : "";
  let p = u.pathname.replace(/\/+$/, "");
  if (!p) p = "/";
  u.pathname = p;
  return u.toString();
}

export function pagePath(abs: string, s: Scope) {
  const p = new URL(abs).pathname;
  const rel = s.basePath !== "/" && p.startsWith(s.basePath) ? p.slice(s.basePath.length) : p;
  return rel.replace(/\/+$/, "") || "/";
}

/** Find pages: home page links + sitemap. */
export async function discover(previewUrl: string, maxPages = 60) {
  const scope = scopeFor(previewUrl);
  const start = canonical(resolveDudaUrl(previewUrl), scope);
  const found = new Set<string>([start]);
  const from = new Map<string, string>();
  const queue = [start];
  const errors: string[] = [];

  // Try sitemap first (published or preview)
  for (const sm of [scope.origin + (scope.basePath === "/" ? "" : scope.basePath) + "/sitemap.xml"]) {
    try {
      const r = await fetchHtml(sm, 10000);
      if (r.status < 400 && r.html.includes("<loc>")) {
        for (const m of r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
          if (inScope(m[1], scope)) found.add(canonical(m[1], scope));
        }
      }
    } catch { /* ignore */ }
  }

  // BFS two levels deep through nav links
  let depth = 0;
  while (queue.length && depth < 2 && found.size < maxPages) {
    const level = queue.splice(0, queue.length);
    await Promise.all(level.slice(0, 15).map(async (url) => {
      try {
        const r = await fetchHtml(url, 15000);
        if (r.status >= 400) { errors.push(`${url} returned HTTP ${r.status}`); return; }
        const $ = cheerio.load(r.html);
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href") || "";
          if (/^(mailto|tel|javascript|#)/i.test(href)) return;
          try {
            const abs = scoped(new URL(href, r.finalUrl).toString(), scope);
            if (!abs) return;
            const c = canonical(abs, scope);
            if (!found.has(c) && found.size < maxPages) { found.add(c); queue.push(c); from.set(c, pagePath(url, scope)); }
          } catch { /* ignore */ }
        });
      } catch (e) { errors.push(`${url}: ${(e as Error).message}`); }
    }));
    depth++;
  }
  const pages = [...found].sort((a, b) => pagePath(a, scope).length - pagePath(b, scope).length || a.localeCompare(b));
  return { scope, pages: pages.map((u) => ({ url: u, from: from.get(u) })), errors };
}

// ---------- CSS selector ----------

export function cssEscape(s: string) {
  return s.replace(/^(\d)/, "\\3$1 ").replace(/([^\w-])/g, "\\$1");
}

export function selectorFor($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.type === "tag" && cur.name !== "html" && cur.name !== "body") {
    const id = cur.attribs?.id;
    if (id && !/\s/.test(id)) { parts.unshift("#" + cssEscape(id)); break; }
    const parent: Element | null = cur.parent && (cur.parent as Element).type === "tag" ? (cur.parent as Element) : null;
    let part = cur.name;
    if (parent) {
      const sibs = (parent.children as AnyNode[]).filter((c) => c.type === "tag" && (c as Element).name === cur!.name);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(" > ");
}

const clean = (s: string) => s.replace(/ /g, " ").replace(/[\t\r\n ]+/g, " ").trim();

// ---------- extraction ----------

export function extract(url: string, finalUrl: string, status: number, html: string, scope: Scope): PageData {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text());
  const metaDescription = clean($('meta[name="description"]').attr("content") || "");
  $(SKIP).remove();

  const isGlobal = (el: Element) => $(el).closest(GLOBAL_SEL).length > 0;

  const blocks: Block[] = [];
  const seen = new Set<string>();
  const walk = (el: Element) => {
    for (const child of el.children as AnyNode[]) {
      if (child.type !== "tag") continue;
      const c = child as Element;
      const tag = c.name.toLowerCase();
      const hasOwnText = (c.children as AnyNode[]).some((n) => n.type === "text" && clean((n as unknown as { data: string }).data).length > 1);
      if (FULL_TEXT_TAGS.has(tag) || hasOwnText) {
        const text = clean($(c).text());
        if (text.length > 1) {
          const global = isGlobal(c);
          const key = (global ? "g:" : "") + text;
          if (!seen.has(key)) {
            seen.add(key);
            // Customer reviews / testimonials are quoted verbatim — don't "fix" a customer's spelling.
            const quote = /^["“].{20,}["”]$/s.test(text) || $(c).closest("[class*=review],[class*=testimonial],[id*=review],blockquote").length > 0;
            blocks.push({ id: blocks.length, tag, text, selector: selectorFor($, c), global, quote: quote || undefined });
          }
        }
        if (FULL_TEXT_TAGS.has(tag)) continue;
      }
      walk(c);
    }
  };
  const body = $("body").get(0);
  if (body) walk(body as Element);

  const headings: PageData["headings"] = [];
  $("h1,h2,h3,h4,h5,h6").each((_, h) => {
    headings.push({ level: Number(h.name[1]), text: clean($(h).text()), selector: selectorFor($, h) });
  });

  const images: Img[] = [];
  $("img").each((_, img) => {
    const $i = $(img);
    const src = $i.attr("data-src") || $i.attr("src") || $i.attr("data-lazy-src") || "";
    if (!src || src.startsWith("data:")) return;
    let abs = src;
    try { abs = new URL(src, finalUrl).toString(); } catch { /* keep */ }
    const w = Number($i.attr("width") || 0), h = Number($i.attr("height") || 0);
    const container = $i.closest("figure,a,div");
    images.push({
      id: images.length, src: abs,
      alt: $i.attr("alt") === undefined ? null : clean($i.attr("alt") || ""),
      selector: selectorFor($, img), global: isGlobal(img),
      context: clean(container.text()).slice(0, 200),
      decorative: $i.attr("role") === "presentation" || (w > 0 && w <= 2 && h > 0 && h <= 2),
    });
  });

  const links: Link[] = [];
  $("a").each((_, a) => {
    if ($(a).attr("href") === undefined) return; // Duda buttons wired to popups/booking widgets have no href
    const href = ($(a).attr("href") || "").trim();
    let abs = href;
    try { abs = new URL(href, finalUrl).toString(); } catch { /* keep */ }
    links.push({ href, abs, text: clean($(a).text()) || clean($(a).attr("aria-label") || ""), selector: selectorFor($, a), global: isGlobal(a) });
  });

  return { url, finalUrl, status, title, metaDescription, h1s: headings.filter((h) => h.level === 1).map((h) => h.text), headings, blocks, images, links, html: "" };
}
