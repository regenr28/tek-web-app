/**
 * 301 redirects (QA: "Make sure all redirects are complete"): every page of the client's old website must either
 * exist on the new site at the same address or have a 301 redirect, and every redirect must go to a page that exists.
 * The old website's pages come from its sitemap (or, without one, the links on its homepage).
 */
import { safeFetch } from "./net";
import { UA } from "./crawl";
import type { Finding } from "./rules";
import { SETTINGS_PATH } from "./qa";

export type UrlRule = { source?: string; target?: string; response_code?: number };

const normPath = (p: string) => {
  let x = p.trim();
  try { x = decodeURIComponent(new URL(x, "https://x.invalid").pathname); } catch { /* keep */ }
  return x.toLowerCase().replace(/\/+$/, "") || "/";
};
const SKIP = /\.(jpe?g|png|gif|webp|svg|pdf|css|js|xml|ico|mp4|zip)$|\/(wp-content|wp-includes|wp-json|feed|xmlrpc\.php|cdn-cgi)(\/|$)|^\/(tag|author)\//i;

async function getText(url: string) {
  const r = await safeFetch(url, { hosts: "public", timeoutMs: 12000, maxBytes: 4_000_000, headers: { "User-Agent": UA, Accept: "application/xml,text/xml,text/html,*/*" } });
  return r.status < 400 ? r.text() : "";
}

/** The old website's page paths (sitemap first, else its homepage links). */
export async function oldSitePaths(site: string): Promise<{ paths: string[]; from: string }> {
  let origin = "";
  try { origin = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).origin; } catch { return { paths: [], from: "" }; }
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const same = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "") === host; } catch { return false; } };
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const out = new Set<string>();
  try {
    const first = await getText(`${origin}/sitemap.xml`).catch(() => "") || await getText(`${origin}/sitemap_index.xml`).catch(() => "");
    if (/<urlset|<sitemapindex/i.test(first)) {
      const children = /<sitemapindex/i.test(first) ? locs(first).filter(same).slice(0, 6) : [];
      const xmls = children.length ? await Promise.all(children.map((u) => getText(u).catch(() => ""))) : [first];
      for (const x of xmls) for (const u of locs(x)) if (same(u)) out.add(normPath(u));
      if (out.size) return { paths: [...out].filter((p) => !SKIP.test(p)).slice(0, 500), from: "sitemap" };
    }
  } catch { /* no sitemap */ }
  try {
    const html = await getText(origin);
    for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      let u = ""; try { u = new URL(m[1], origin).toString(); } catch { continue; }
      if (same(u)) out.add(normPath(u));
    }
  } catch { /* unreachable */ }
  return { paths: [...out].filter((p) => !SKIP.test(p)).slice(0, 300), from: out.size ? "homepage links" : "" };
}

/** Redirect findings: old pages with no redirect, redirects to pages that don't exist. */
export function redirectFindings(opts: { rules: UrlRule[]; oldPaths: string[]; from: string; oldSite: string; sitePaths: string[]; homeUrl: string }): Finding[] {
  const out: Finding[] = [];
  const base = { path: SETTINGS_PATH, url: opts.homeUrl, selector: "", source: "rule" as const, global: true, category: "Redirects" };
  const site = new Set(opts.sitePaths.map(normPath));
  const exact = new Set<string>(), prefixes: string[] = [];
  for (const r of opts.rules) {
    const s = String(r.source || "");
    if (!s) continue;
    if (s.endsWith("*")) prefixes.push(normPath(s.slice(0, -1)) === "/" ? "/" : normPath(s.slice(0, -1)) + "/");
    else exact.add(normPath(s));
  }
  // a redirect must go somewhere that exists
  for (const r of opts.rules) {
    const t = String(r.target || "").trim();
    if (!t || /^https?:\/\//i.test(t)) continue;
    const tp = t === "home" ? "/" : normPath(t.startsWith("/") ? t : `/${t}`);
    if (tp !== "/" && !site.has(tp) && !opts.sitePaths.some((p) => normPath(p).startsWith(tp + "/")))
      out.push({ ...base, severity: "error", rule: "redirect-target-missing", message: `A 301 redirect goes to a page that doesn't exist on the new site`, found: `${r.source} → ${t}`, expected: "a page that exists" });
    if (r.response_code && r.response_code !== 301) out.push({ ...base, severity: "warning", rule: "redirect-not-301", message: `Redirect is a ${r.response_code}, not a 301`, found: `${r.source} → ${t}` });
  }
  if (!opts.oldPaths.length) return out;
  const missing = opts.oldPaths.filter((p) => p !== "/" && !site.has(p) && !exact.has(p) && !prefixes.some((x) => (p + "/").startsWith(x)));
  if (missing.length) out.push({ ...base, severity: "error", rule: "redirects-missing",
    message: `${missing.length} page${missing.length === 1 ? "" : "s"} of the old website ${missing.length === 1 ? "has" : "have"} no 301 redirect (from its ${opts.from})${opts.rules.length ? "" : " — the site has no redirects at all"}`,
    found: missing.slice(0, 15).join(", ") + (missing.length > 15 ? ` … +${missing.length - 15} more` : ""), expected: `a 301 from each old page of ${opts.oldSite} to the matching new page (or home)` });
  return out;
}
