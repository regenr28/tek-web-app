import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { safeFetch } from "./net";
import { getPolicy } from "./policy";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 DudaPreviewAudit/1.0";

export type Block = { id: number; tag: string; text: string; selector: string; global: boolean; quote?: boolean };
export type Img = { id: number; src: string; alt: string | null; selector: string; global: boolean; context: string; decorative: boolean;
  /** the link the image sits in (null = not linked) */
  href?: string | null;
  /** the site logo (header image named / classed "logo") */
  logo?: boolean;
  /** inside a customer-review widget (reviewer photos, star images) — not the site builder's to fix */
  review?: boolean };
/** A header menu item (dropdown items too, even ones hidden until hover). */
export type NavItem = { text: string; href: string; selector: string };
export type Link = { href: string; abs: string; text: string; selector: string; global: boolean;
  /** what an icon-only link is about: aria-label, title, class names, icon classes, image alt / file name */
  hint?: string;
  /** the text of the card / block the link sits in (e.g. the service name above a "Learn more" button) */
  context?: string;
  /** in the header menu */
  nav?: boolean;
  /** the link wraps an image / icon */
  img?: boolean;
  /** hidden on this device (e.g. dropdown, mobile-only copy) */
  hidden?: boolean };
/** Duda's "Business Info" (site settings) as published in the page's structured data. */
export type BizInfo = { name: string; telephone: string; street: string; city: string; region: string; zip: string; url: string; email: string; hours: string[] };
export type BookButton = { selector: string; href: string | null; text: string; global: boolean };
export type PageData = {
  url: string; finalUrl: string; status: number; title: string; metaDescription: string; linkedFrom?: string;
  h1s: string[]; headings: { level: number; text: string; selector: string }[];
  blocks: Block[]; images: Img[]; links: Link[]; html: string;
  /** e-mail addresses Duda contact forms send to (hidden "dmformsendto" inputs) */
  formRecipients?: string[];
  /** ShopGenie "Book appointment" buttons (.shopgenie-book-appt-bt) — must not have an href */
  bookButtons?: BookButton[];
  /** which device layout this was read from */
  device?: string;
  /** the header menu (nav) items */
  navItems?: NavItem[];
  /** labels that appear twice at the top level of one menu */
  navDupes?: string[];
  /** element ids / anchor names on the page (targets for #links) */
  ids?: string[];
  /** Duda Business Info (structured data) */
  bizInfo?: BizInfo | null;
  /** UserWay accessibility widget installed; home-screen (apple-touch) icon set */
  widgets?: { userway: boolean; touchIcon: boolean };
  /** Google Maps embeds */
  mapEmbeds?: { src: string; selector: string; global: boolean }[];
  /** phone numbers shown as text that aren't click-to-call links */
  unlinkedPhones?: { text: string; selector: string; global: boolean }[];
  /** text that is nearly invisible (same color as its background) */
  lowContrast?: { text: string; selector: string; global: boolean; colors: string }[];
};
/** ShopGenie's custom "Book appointment" button — opens the booking widget, so it must not link anywhere. */
export const BOOK_BTN = ".shopgenie-book-appt-bt";

const SKIP = "script,style,noscript,template,svg,iframe,link,meta,[hidden],[aria-hidden='true'][style*='display: none'],[style*='display:none'],[style*='display: none']";
const GLOBAL_SEL = "header,footer,#hcontainer,#fcontainer,.dmHeader,.dmFooter,.dmHeaderContainer,.dmFooterContainer,#dm-footer,.dmNavigation,nav,[role=navigation],.main-navigation,#hamburger-drawer,#hamburger-header-container,#hamburger-header";
/** Customer-review widgets (Duda / ShopGenie / Google review sliders, testimonials) — by class / id / widget type.
 *  ("preview" is not "review": Duda preview pages put "preview" in class names.) */
const REVIEW_ATTR = /(^|[^p])reviews?|testimonial|ratings?[-_]?(widget|slider|carousel)|star[-_]?rating/i;
function isReviewEl($: cheerio.CheerioAPI, el: Element) {
  for (let x: Element | null = el; x && x.type === "tag"; x = x.parent && (x.parent as Element).type === "tag" ? (x.parent as Element) : null) {
    if (x.name === "blockquote") return true;
    const a = x.attribs || {};
    if (REVIEW_ATTR.test(`${a.class || ""} ${a.id || ""} ${a["data-widget-type"] || ""} ${a["data-element-type"] || ""}`)) return true;
  }
  return false;
}
/** A section heading that introduces customer reviews ("What Our Customers Say", "Reviews", "Testimonials"…) */
export const REVIEW_HEADING = /\b(reviews?|testimonials?|what (our|people|customers|clients|drivers|neighbors)\b.{0,25}\bsay(ing)?|customer (feedback|stories|experiences)|(happy|satisfied) (customers|clients)|hear from (our|real)|(customers|clients) love us|5[- ]star (service|reviews?))\b/i;
/** The header menu (Duda's unified nav, plain <nav>, the mobile hamburger drawer) */
const NAV_SEL = "nav,[role=navigation],.unifiednav,.dmNavigation,.main-navigation,#hamburger-drawer";
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
  // Duda serves the home page at both "/" and "/home" — audit it once
  if ([...found].some((u) => pagePath(u, scope) === "/")) for (const u of [...found]) if (pagePath(u, scope) === "/home") found.delete(u);
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

/** Duda Business Info → schema.org JSON-LD (LocalBusiness / AutoRepair …) on every page. */
function readBizInfo($: cheerio.CheerioAPI): BizInfo | null {
  const nodes: Record<string, unknown>[] = [];
  const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { const o = x as Record<string, unknown>; nodes.push(o); if (o["@graph"]) walk(o["@graph"]); } };
  $("script[type='application/ld+json']").each((_, el) => { try { walk(JSON.parse($(el).text())); } catch { /* broken JSON-LD */ } });
  const t = (o: Record<string, unknown>) => String(([] as unknown[]).concat(o["@type"] || "").join(" "));
  const b = nodes.find((o) => /LocalBusiness|AutoRepair|AutomotiveBusiness|Organization|Store|AutoPartsStore|AutoBodyShop|TireShop/i.test(t(o)) && (o.telephone || o.address || o.name));
  if (!b) return null;
  const a = (typeof b.address === "object" && b.address ? b.address : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  const hours = ([] as unknown[]).concat(b.openingHours || []).map(s).filter(Boolean)
    .concat(([] as unknown[]).concat(b.openingHoursSpecification || []).map((h) => { const o = (h || {}) as Record<string, unknown>; return `${([] as unknown[]).concat(o.dayOfWeek || []).map((d) => s(d).replace(/^https?:\/\/schema\.org\//, "")).join(",")} ${s(o.opens)}-${s(o.closes)}`.trim(); }));
  return { name: s(b.name), telephone: s(b.telephone), street: s(a.streetAddress), city: s(a.addressLocality), region: s(a.addressRegion), zip: s(a.postalCode), url: s(b.url), email: s(b.email), hours };
}
export const MAPS_URL = /(^|[./])google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl|g\.page\/|share\.google\//i;
const PHONE_TEXT = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

// ---------- extraction ----------

export function extract(url: string, finalUrl: string, status: number, html: string, scope: Scope): PageData {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text());
  const metaDescription = clean($('meta[name="description"]').attr("content") || "");
  const formRecipients = [...new Set($('input[name="dmformsendto"]').map((_, i) => ($(i).attr("value") || "").split(/[,;\s]+/)).get().flat().map((x) => String(x).trim().toLowerCase()).filter((x) => /@/.test(x)))];
  // Menu items and images are read before hidden parts are removed: dropdown items and images in the mobile menu are
  // hidden until opened, but they're still on the site.
  const navItems: NavItem[] = [];
  $(NAV_SEL).find("a").each((_, a) => {
    if ($(a).parents(NAV_SEL).filter((__, n) => $(n).closest("footer,#fcontainer,.dmFooter,.dmFooterContainer").length > 0).length) return; // a footer menu isn't the header nav
    const text = clean($(a).text()) || clean($(a).attr("aria-label") || "") || clean($(a).attr("title") || "");
    const href = ($(a).attr("href") || "").trim();
    if (text && !navItems.some((n) => n.text.toLowerCase() === text.toLowerCase() && n.href === href)) navItems.push({ text: text.slice(0, 80), href: href.slice(0, 300), selector: selectorFor($, a as Element) });
  });
  const images: Img[] = [];
  $("img").each((_, img) => {
    const $i = $(img);
    if ($i.closest("noscript,template,script").length) return;
    const src = $i.attr("data-src") || $i.attr("src") || $i.attr("data-lazy-src") || "";
    if (!src || src.startsWith("data:")) return;
    let abs = src;
    try { abs = new URL(src, finalUrl).toString(); } catch { /* keep */ }
    const w = Number($i.attr("width") || 0), h = Number($i.attr("height") || 0);
    const container = $i.closest("figure,a,div");
    images.push({
      id: images.length, src: abs,
      alt: $i.attr("alt") === undefined ? null : clean($i.attr("alt") || ""),
      selector: selectorFor($, img), global: $i.closest(GLOBAL_SEL).length > 0,
      context: clean(container.text()).slice(0, 200),
      decorative: $i.attr("role") === "presentation" || $i.attr("aria-hidden") === "true" && $i.attr("alt") === "" || (w > 0 && w <= 2 && h > 0 && h <= 2) || /\/(pixel|spacer|blank)\.(gif|png)/i.test(abs),
      review: isReviewEl($, img as Element) || undefined,
      href: $i.closest("a").length ? ($i.closest("a").attr("href") ?? null) : null,
      logo: (/logo/i.test(`${$i.attr("alt") || ""} ${$i.attr("class") || ""} ${$i.attr("id") || ""} ${abs.split("/").pop() || ""} ${$i.parent().attr("class") || ""}`) && $i.closest("header,#hcontainer,.dmHeader,.dmHeaderContainer,#hamburger-header,#hamburger-header-container").length > 0)
        || $i.closest("[data-element-type=logo],.logo-image,.dmLogo").length > 0 || undefined,
    });
  });

  // anchor targets: ids, <a name>, Duda's data-anchor
  // (any attribute with "anchor" in its name counts too — site builders name anchors differently)
  const idSet = new Set<string>();
  $("*").each((_, el) => {
    const a = (el as Element).attribs || {};
    for (const [k, v] of Object.entries(a)) if (v && (k === "id" || (k === "name" && (el as Element).name === "a") || /anchor/i.test(k))) idSet.add(String(v).toLowerCase().trim());
  });
  const ids = [...idSet].slice(0, 4000);
  const bizInfo = readBizInfo($);
  const widgets = {
    userway: /userway/i.test($("script[src]").map((_, el) => $(el).attr("src")).get().join(" ") + " " + $("script:not([src])").text().slice(0, 400_000)) || $(".uwy,#userwayAccessibilityIcon,[class*=userway i]").length > 0,
    touchIcon: $('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]').length > 0,
  };
  const mapEmbeds = $("iframe").map((_, f) => ({ src: ($(f).attr("src") || $(f).attr("data-src") || "").trim(), selector: selectorFor($, f as Element), global: $(f).closest(GLOBAL_SEL).length > 0 })).get().filter((m) => MAPS_URL.test(m.src));
  // the same label twice at the top level of one menu ("FAQs" twice)
  const navDupes: string[] = [];
  $(NAV_SEL).filter((_, n) => $(n).parents(NAV_SEL).length === 0).each((_, n) => {
    const seenTop = new Map<string, number>();
    $(n).find("a").each((__, a) => {
      if ($(a).parentsUntil(n, "ul,ol").length > 1) return; // dropdown item
      const t = clean($(a).text()).toLowerCase();
      if (t) seenTop.set(t, (seenTop.get(t) || 0) + 1);
    });
    for (const [t, k] of seenTop) if (k > 1 && !navDupes.includes(t)) navDupes.push(t);
  });
  // links are read before hidden parts are removed: a "Book Now" that only shows on tablet still links somewhere
  const isHiddenEl = (el: Element) => $(el).closest("[hidden],[style*='display:none'],[style*='display: none']").length > 0;
  const links: Link[] = [];
  $("a").each((_, a) => {
    if ($(a).attr("href") === undefined) return; // Duda buttons wired to popups/booking widgets have no href
    if ($(a).is(BOOK_BTN) || $(a).closest(BOOK_BTN).length) return; // checked separately (bookButtons)
    if ($(a).closest("noscript,template,script").length) return;
    const href = ($(a).attr("href") || "").trim();
    let abs = href;
    try { abs = new URL(href, finalUrl).toString(); } catch { /* keep */ }
    const $a = $(a);
    const hint = [$a.attr("aria-label"), $a.attr("title"), $a.attr("class"), $a.attr("data-element-type"), $a.attr("data-display-type"),
      $a.find("[class]").map((__, k) => $(k).attr("class")).get().join(" "), $a.find("img").map((__, i) => `${$(i).attr("alt") || ""} ${($(i).attr("src") || "").split("/").pop()}`).get().join(" ")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 300);
    const own = clean($a.clone().find("script,style,svg").remove().end().text());
    const card = $a.parents().filter((__, p) => { const t = clean($(p).text()); return t.length > own.length + 3 && t.length < 400; }).first();
    const text = own || clean($a.attr("aria-label") || "") || clean($a.attr("title") || "");
    const inNav = $a.closest(NAV_SEL).length > 0;
    const ctxText = card.length && !inNav ? clean((card.html() || "").replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ")).slice(0, 200) : "";
    links.push({ href, abs, text, selector: selectorFor($, a), global: $a.closest(GLOBAL_SEL).length > 0, hint, context: ctxText,
      nav: ($a.closest(NAV_SEL).length > 0 && $a.closest("footer,#fcontainer,.dmFooter,.dmFooterContainer").length === 0) || undefined,
      img: $a.find("img,svg,i,[class*=icon i]").length > 0 || undefined, hidden: isHiddenEl(a as Element) || undefined });
  });
  // text that the renderer measured as invisible (text color ≈ background color)
  const lowContrast = $("[data-tek-lc]").map((_, el) => ({ text: clean($(el).text()).slice(0, 120), selector: selectorFor($, el as Element), global: $(el).closest(GLOBAL_SEL).length > 0, colors: $(el).attr("data-tek-lc") || "" })).get().filter((x) => x.text.length > 1);

  $(SKIP).remove();
  // Text on separate lines / in separate blocks must not run together ("APR.</p><p>See" is "APR. See", not "APR.See")
  $("br").replaceWith(" ");
  $("p,div,li,h1,h2,h3,h4,h5,h6,td,th,tr,section,article,header,footer,ul,ol,dt,dd,address,blockquote,figcaption,label,button,option").each((_, el) => { $(el).append(" "); });

  const isGlobal = (el: Element) => $(el).closest(GLOBAL_SEL).length > 0;

  const blocks: Block[] = [];
  const unlinkedPhones: NonNullable<PageData["unlinkedPhones"]> = [];
  const seen = new Set<string>();
  // Customer reviews under a "Reviews" / "What our customers say" heading: everything in that heading's section, up to
  // the next heading of the same or a higher level (reviewer names are often smaller headings), is the customers' own text.
  let reviewArea: { level: number; section: Element | null } | null = null;
  const sectionOf = (el: Element) => ($(el).parents(".dmRespRow,section,[class*=section i]").last().get(0) as Element | undefined) || null;
  const inside = (el: Element, box: Element) => { for (let x: Element | null = el; x; x = x.parent && (x.parent as Element).type === "tag" ? (x.parent as Element) : null) if (x === box) return true; return false; };
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
            const hm = tag.match(/^h([1-6])$/);
            if (hm && !global) {
              const lvl = Number(hm[1]);
              if (REVIEW_HEADING.test(text) && text.length <= 80) reviewArea = { level: lvl, section: sectionOf(c) };
              else if (reviewArea && lvl <= reviewArea.level) reviewArea = null;
            }
            if (reviewArea && reviewArea.section && !inside(c, reviewArea.section)) reviewArea = null;
            const inReviews = !!reviewArea && !global && !(hm && REVIEW_HEADING.test(text));
            const quote = /^["“].{20,}["”]$/s.test(text) || isReviewEl($, c) || inReviews;
            blocks.push({ id: blocks.length, tag, text, selector: selectorFor($, c), global, quote: quote || undefined });
            const ph = text.match(PHONE_TEXT);
            if (ph && !$(c).find("a[href^='tel:'],a[href^='TEL:']").length && !$(c).closest("a[href^='tel:'],a[href^='TEL:']").length && text.length < 300)
              unlinkedPhones.push({ text: ph[0], selector: selectorFor($, c), global });
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

  const bookButtons: BookButton[] = [];
  $(BOOK_BTN).each((_, el) => {
    const href = $(el).attr("href");
    bookButtons.push({ selector: selectorFor($, el as Element), href: href === undefined ? null : href.trim(), text: clean($(el).text()) || clean($(el).attr("aria-label") || ""), global: isGlobal(el as Element) });
  });

  return { url, finalUrl, status, title, metaDescription, h1s: headings.filter((h) => h.level === 1).map((h) => h.text), headings, blocks, images, links, html: "", formRecipients, bookButtons, navItems, navDupes, ids, bizInfo, widgets, mapEmbeds, unlinkedPhones, lowContrast };
}
