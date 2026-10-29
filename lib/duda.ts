/** Optional: only active when DUDA_API_USERNAME / DUDA_API_PASSWORD are set in Vercel env. */
import { emptyFacts, formatPhone, type Facts, type Day } from "./facts";
import type { NavNode } from "./navqa";

export const dudaEnabled = () => !!(process.env.DUDA_API_USERNAME && process.env.DUDA_API_PASSWORD);

export function guessSiteName(previewUrl: string) {
  try {
    const segs = new URL(previewUrl).pathname.split("/").filter(Boolean);
    const i = segs.findIndex((s) => ["preview", "site", "sites"].includes(s.toLowerCase()));
    return i >= 0 ? segs[i + 1] || "" : "";
  } catch { return ""; }
}

async function duda(path: string) {
  const auth = Buffer.from(`${process.env.DUDA_API_USERNAME}:${process.env.DUDA_API_PASSWORD}`).toString("base64");
  const base = process.env.DUDA_API_BASE || "https://api.duda.co/api";
  const r = await fetch(base + path, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`Site settings: HTTP ${r.status}`);
  return r.json();
}

const DAY_MAP: Record<string, Day> = { MON: "mon", TUE: "tue", WED: "wed", THU: "thu", FRI: "fri", SAT: "sat", SUN: "sun" };
const t12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h)) return t;
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};

type DudaLoc = {
  label?: string;
  phones?: { phoneNumber: string }[]; emails?: { emailAddress: string }[];
  address?: { streetAddress?: string; city?: string; region?: string; postalCode?: string };
  business_hours?: { days: string[]; open: string; close: string }[];
  social_accounts?: Record<string, string>;
};

/** Business Info (content library) mapped into the same Facts shape used for Jira. */
export async function dudaBusinessInfo(siteName: string): Promise<Facts> {
  const c = await duda(`/sites/multiscreen/${encodeURIComponent(siteName)}/content`);
  const f = emptyFacts();
  f.businessName = c?.business_data?.name || "";
  const locs: DudaLoc[] = [c?.location_data, ...(c?.additional_locations || [])].filter(Boolean);
  locs.forEach((l, i) => {
    for (const p of l.phones || []) if (p.phoneNumber) f.phones.push(formatPhone(p.phoneNumber));
    for (const e of l.emails || []) if (e.emailAddress) f.emails.push(e.emailAddress.toLowerCase());
    if (l.address?.streetAddress) f.locations.push({ label: l.label || (i ? `Location ${i + 1}` : ""), street: l.address.streetAddress, city: l.address.city || "", state: l.address.region || "", zip: l.address.postalCode || "" });
    if (i === 0) for (const h of l.business_hours || []) for (const d of h.days || []) {
      const day = DAY_MAP[d.toUpperCase()];
      if (day) f.hours.push({ day, value: h.open && h.close ? `${t12(h.open)} - ${t12(h.close)}` : "Closed" });
    }
    for (const [platform, handle] of Object.entries(l.social_accounts || {})) if (handle) f.socials.push({ platform, url: /^https?:/.test(handle) ? handle : `https://${platform}.com/${handle}` });
  });
  f.phones = [...new Set(f.phones)];
  f.emails = [...new Set(f.emails)];
  return f;
}

// ---------- site settings for the QA audit ----------

/** The site id: from the Editor URL (my.duda.co/home/site/<id>/…), the saved site id, or the preview link. */
export function siteIdFrom(s: { editor_url?: string | null; duda_site_id?: string | null; preview_url?: string | null }) {
  const fromEditor = (s.editor_url || "").match(/\/home\/site\/([a-z0-9]+)/i)?.[1] || (s.editor_url || "").match(/\/site\/([a-z0-9]+)/i)?.[1] || "";
  const id = fromEditor || (s.duda_site_id || "").trim() || guessSiteName(s.preview_url || "");
  return /^[a-z0-9]{4,40}$/i.test(id) ? id : "";
}

export type SiteSnapshot = {
  site: {
    labels?: { name: string }[]; template_id?: number; fav_icon?: string | null;
    site_seo?: { title?: string; description?: string; og_image?: string; no_index?: boolean } | null;
    site_business_info?: { business_name?: string; phone_number?: string; email?: string; address?: { street?: string; city?: string; state?: string; zip_code?: string } } | null;
  };
  content: {
    location_data?: {
      phones?: { phoneNumber: string }[]; emails?: { emailAddress: string }[];
      social_accounts?: Record<string, unknown>; business_hours?: { days: string[]; open: string; close: string }[];
      schema?: { area_served?: { text: string }[] } | null;
      address?: { streetAddress?: string; city?: string; region?: string; postalCode?: string };
    } | null;
    additional_locations?: unknown[];
    site_texts?: { custom?: { label: string; text: string }[] } | null;
    business_data?: { name?: string | null; logo_alt_text?: string | null; logo_url?: string | null } | null;
  };
  pages: { path: string; type: string; title?: string; collection_name?: string; seo?: { title?: string; description?: string; no_index?: boolean } }[];
  /** the site's menu (each item says on which devices it's hidden) */
  nav?: NavNode[];
  /** the template the site was made from, with its menu */
  template?: { name: string; site: string; nav: NavNode[] } | null;
  collections: { name: string; item_count?: number; values?: { id?: string; page_item_url?: string; status?: string; data?: Record<string, unknown> }[] }[];
};

export type { NavNode };

async function get(path: string, timeoutMs = 20000) {
  const auth = Buffer.from(`${process.env.DUDA_API_USERNAME}:${process.env.DUDA_API_PASSWORD}`).toString("base64");
  const base = process.env.DUDA_API_BASE || "https://api.duda.co/api";
  const r = await fetch(base + path, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type TemplateRow = { template_id: number; template_name: string; base_site_name?: string; preview_url?: string; editor?: string; template_properties?: { type?: string; page_count?: number } };
let tplCache: { at: number; list: TemplateRow[] } | null = null;
/** The team's templates (custom ones), cached for an hour. */
export async function templateList(): Promise<TemplateRow[]> {
  if (tplCache && Date.now() - tplCache.at < 3_600_000) return tplCache.list;
  const all = await get("/sites/multiscreen/templates", 30000);
  const list = (Array.isArray(all) ? all : []).filter((t: TemplateRow) => t?.template_properties?.type === "custom" && t.base_site_name);
  tplCache = { at: Date.now(), list };
  return list;
}
const normName = (x: string) => x.toLowerCase().replace(/\btemplate\b/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\b0+(\d)/g, "$1").trim();
/** A template's menu, by its id (what the site was made from) or by name (Jira's template). */
export async function templateNav(templateId?: number | null, name?: string | null): Promise<{ name: string; site: string; nav: NavNode[] } | null> {
  const list = await templateList();
  const t = (templateId ? list.find((x) => x.template_id === templateId) : undefined) || (name ? list.find((x) => normName(x.template_name) === normName(name)) : undefined);
  if (!t?.base_site_name) return null;
  return { name: t.template_name.trim(), site: t.base_site_name, nav: await templateNavBySite(t.base_site_name) };
}
export async function templateNavBySite(site: string): Promise<NavNode[]> {
  const n = await get(`/sites/multiscreen/${encodeURIComponent(site)}/navigation/en`);
  return Array.isArray(n?.navigation) ? n.navigation : [];
}
/** The site's menu (desktop / tablet / mobile visibility per item). */
export async function siteNav(siteId: string): Promise<NavNode[] | undefined> {
  const n = await get(`/sites/multiscreen/${encodeURIComponent(siteId)}/navigation/en`);
  return Array.isArray(n?.navigation) ? n.navigation : undefined;
}

/** Labels, site SEO, Business Info, business texts, every page's SEO and the collections — read only. */
export async function siteSnapshot(siteId: string): Promise<SiteSnapshot> {
  const p = `/sites/multiscreen/${encodeURIComponent(siteId)}`;
  const [site, content, pages, collections, nav] = await Promise.all([
    get(p), get(`${p}/content`).catch(() => ({})), get(`${p}/pages`).catch(() => ({ results: [] })), get(`${p}/collection`, 30000).catch(() => []),
    siteNav(siteId).catch(() => undefined),
  ]);
  return { site: site || {}, content: content || {}, pages: Array.isArray(pages?.results) ? pages.results : Array.isArray(pages) ? pages : [], collections: Array.isArray(collections) ? collections : [], nav };
}
