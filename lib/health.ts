import dns from "dns";
import tls from "tls";
import * as cheerio from "cheerio";
import { safeFetch, isBlockedIp } from "./net";
import { nameSimilarity } from "./research";

/**
 * Domain health check for one website: is the domain still live, still on Duda, still this shop?
 * Everything here is read-only and public: DNS, one page load (following redirects), the SSL certificate,
 * and the domain's registration record (RDAP — the free, official replacement for WHOIS).
 */

export type Health = "ok" | "redirect" | "moved" | "taken" | "parked" | "not_found" | "error" | "dns" | "ssl" | "down" | "unchecked" | "skipped";
export const HEALTH_LABEL: Record<Health, string> = {
  ok: "Live on Duda",
  redirect: "Redirects to another domain",
  moved: "Moved off Duda",
  taken: "Different website (new owner?)",
  parked: "Parked / for sale / expired",
  not_found: "Not found (404)",
  error: "Server error (5xx)",
  dns: "Domain not resolving",
  ssl: "SSL problem",
  down: "Down / timeout",
  unchecked: "Not checked yet",
  skipped: "Not live in Duda (not checked)",
};
/** Order used for the overview tiles (problems first after "ok"). */
export const HEALTH_ORDER: Health[] = ["ok", "redirect", "moved", "taken", "parked", "not_found", "error", "dns", "ssl", "down", "unchecked", "skipped"];

export type Flag = "domain_expiring" | "domain_hold" | "ssl_expiring" | "slow" | "other_duda_site" | "staging_domain";
export const FLAG_LABEL: Record<Flag, string> = {
  domain_expiring: "Domain registration expires within 30 days",
  domain_hold: "Domain is on hold / in redemption / pending delete",
  ssl_expiring: "SSL certificate expires within 14 days",
  slow: "Slow — took over 5 seconds",
  other_duda_site: "Domain shows a different Duda site (another alias)",
  staging_domain: "Still on a staging address (no custom domain)",
};

export type CheckResult = {
  health: Health; detail: string; flags: Flag[];
  info: {
    url: string; finalUrl?: string; status?: number; ms?: number; chain: { status: number; from: string; to: string }[];
    dns?: { a: string[]; cname: string[]; error?: string };
    platform?: string; dudaAlias?: string; title?: string;
    ssl?: { validTo?: string; issuer?: string; error?: string };
    rdap?: { expires?: string; status?: string[]; registrar?: string; error?: string; retry?: boolean };
    error?: string;
  };
  sslExpires?: string; domainExpires?: string;
};

const STAGING = /\.(tekmetric\.site|shopgenie\.site|multiscreensite\.com|dudaone\.com|mydudapreview\.com)$/i;
const TWO_LEVEL = /\.(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/i;
export const isStaging = (host: string) => STAGING.test(host);
export function registrable(host: string) {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const parts = h.split(".");
  return parts.slice(TWO_LEVEL.test(h) ? -3 : -2).join(".");
}
/** "highway-16-auto-repairaf89e6f9" → "highway 16 auto repair" */
export function shopNameFromSite(siteName: string) {
  return siteName.replace(/[0-9a-f]{8}$/i, "").replace(/[-_]+/g, " ").trim();
}

const DUDA = /cdn-website\.com|dmRoot|dmBody|multiscreensite|dudaone|SiteAlias\s*:|data-dm-|dmNewParagraph|_dm_/i;
const PARKED = /(domain|this domain)( name)? (is|may be) for sale|buy this domain|this domain (is|has been) parked|parked (free|domain)|parkingcrew|sedoparking|bodis\.com|afternic|dan\.com\/|hugedomains|godaddy\.com\/forsale|forsale\.godaddy|domain (has )?expired|this domain name has expired|renew (this|your) domain|parked by namecheap|namecheap\.com\/domains\/registration|future home of something quite cool|cgi-sys\/suspendedpage|account (has been )?suspended|this site has been suspended|website is no longer available|coming soon.{0,40}godaddy/i;
const PLATFORMS: [string, RegExp][] = [
  ["WordPress", /wp-content|wp-includes|wp-json/i], ["Wix", /static\.wixstatic\.com|wix\.com|x-wix/i], ["Squarespace", /squarespace/i],
  ["GoDaddy Website Builder", /img1\.wsimg\.com|websites\.godaddy|godaddy-website-builder/i], ["Shopify", /cdn\.shopify\.com/i], ["Weebly", /weebly/i],
  ["Webflow", /webflow/i], ["Kukui", /kukui/i], ["AutoShop Solutions", /autoshopsolutions/i], ["Net Driven", /netdriven/i],
  ["Repair Shop Websites", /repairshopwebsites/i], ["Broadly", /broadly\.com/i], ["Hibu", /hibu/i], ["Web.com", /web\.com\/|netsolhost/i],
  ["Joomla", /joomla/i], ["Drupal", /drupal/i], ["Carbon", /carbonweb|carbonstudio/i],
];

const DAY = 86_400_000;
const daysUntil = (iso?: string) => (iso ? (Date.parse(iso) - Date.now()) / DAY : Infinity);

async function dnsInfo(host: string) {
  const r = dns.promises;
  const [a, cname] = await Promise.all([
    r.resolve4(host).catch((e: NodeJS.ErrnoException) => { if (["ENOTFOUND", "ENODATA", "ESERVFAIL"].includes(e.code || "")) return [] as string[]; throw e; }),
    r.resolveCname(host).catch(() => [] as string[]),
  ]);
  let aaaa: string[] = [];
  if (!a.length && !cname.length) aaaa = await r.resolve6(host).catch(() => []);
  return { a: [...a, ...aaaa], cname };
}

/** The site's SSL certificate (expiry / issuer) — connects only to public addresses. */
function sslInfo(host: string): Promise<{ validTo?: string; issuer?: string; error?: string }> {
  return new Promise((resolve) => {
    dns.lookup(host, { all: false }, (err, address) => {
      if (err || !address) return resolve({ error: err?.code || "no address" });
      if (isBlockedIp(address)) return resolve({ error: "private address" });
      const sock = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
        const cert = sock.getPeerCertificate();
        const authErr = sock.authorizationError ? String(sock.authorizationError) : "";
        sock.end();
        resolve({ validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : undefined, issuer: (cert?.issuer as { O?: string } | undefined)?.O, error: authErr || undefined });
      });
      sock.on("timeout", () => { sock.destroy(); resolve({ error: "timeout" }); });
      sock.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code || e.message }));
    });
  });
}

/* Domain registration (RDAP — the official, free replacement for WHOIS). We ask each registry directly using IANA's
   list (higher limits than the rdap.org redirector) and space requests out so a 2,000-site check isn't throttled. */
let bootstrap: { at: number; map: Map<string, string> } | null = null;
async function rdapBase(tld: string): Promise<string> {
  if (!bootstrap || Date.now() - bootstrap.at > DAY) {
    try {
      const r = await safeFetch("https://data.iana.org/rdap/dns.json", { hosts: ["data.iana.org"], timeoutMs: 15000, maxBytes: 2_000_000 });
      const j = JSON.parse(r.text()) as { services: [string[], string[]][] };
      const map = new Map<string, string>();
      for (const [tlds, urls] of j.services) for (const t of tlds) map.set(t.toLowerCase(), (urls.find((u) => u.startsWith("https://")) || urls[0]).replace(/\/?$/, "/"));
      bootstrap = { at: Date.now(), map };
    } catch { bootstrap = { at: Date.now() - DAY + 600_000, map: bootstrap?.map || new Map() }; } // retry in 10 min
  }
  return bootstrap.map.get(tld) || "https://rdap.org/";
}
let gate: Promise<void> = Promise.resolve();
const RDAP_GAP_MS = 250; // ≤ 4 registry lookups per second across all parallel checks
const paced = () => { const g = gate.then(() => new Promise<void>((r) => setTimeout(r, RDAP_GAP_MS))); gate = g; return g; };

/** Domain registration record (expiry date, status like "redemption period"). `retry` = try again next time. */
async function rdapInfo(domain: string): Promise<{ expires?: string; status?: string[]; registrar?: string; error?: string; retry?: boolean }> {
  try {
    await paced();
    const base = await rdapBase(domain.split(".").pop() || "");
    const r = await safeFetch(`${base}domain/${encodeURIComponent(domain)}`, { hosts: "public", headers: { Accept: "application/rdap+json, application/json" }, timeoutMs: 12000, maxBytes: 1_000_000, maxRedirects: 3 });
    if (r.status === 404) return { error: "not registered (no RDAP record)" };
    if (r.status === 429 || r.status >= 500) return { error: `registry busy (HTTP ${r.status}) — will retry next check`, retry: true };
    if (r.status >= 400) return { error: `RDAP HTTP ${r.status}`, retry: true };
    const j = JSON.parse(r.text());
    const expires = (j.events || []).find((e: { eventAction?: string }) => /expiration/i.test(e.eventAction || ""))?.eventDate;
    const registrar = (j.entities || []).find((e: { roles?: string[] }) => e.roles?.includes("registrar"))?.vcardArray?.[1]?.find((v: unknown[]) => v[0] === "fn")?.[3];
    return { expires, status: j.status || [], registrar };
  } catch (e) { return { error: (e as Error).message.slice(0, 120), retry: true }; }
}

export async function checkWebsite(site: { domain: string; site_name: string; alias: string; rdap_checked_at?: string | null; domain_expires?: string | null }, opts: { rdap?: boolean } = {}): Promise<CheckResult> {
  const host = site.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  const shop = shopNameFromSite(site.site_name);
  const flags: Flag[] = [];
  const info: CheckResult["info"] = { url: `https://${host}/`, chain: [] };
  // Local tests only (never on Vercel): "localhost:PORT" stands in for a domain — no DNS / SSL / registry lookups
  const testHost = process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL && /^(localhost|127\.0\.0\.1):\d+$/.test(host);
  if (!testHost && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { health: "dns", detail: `"${site.domain}" isn't a valid domain`, flags, info };
  if (isStaging(host)) flags.push("staging_domain");
  if (testHost) opts = { ...opts, rdap: false };

  // 1) DNS
  if (!testHost) {
    try { info.dns = await dnsInfo(host); }
    catch (e) { info.dns = { a: [], cname: [], error: (e as NodeJS.ErrnoException).code || (e as Error).message }; }
  }
  if (info.dns && !info.dns.a.length && !info.dns.cname.length) {
    const rd = !isStaging(host) && opts.rdap !== false ? await rdapInfo(registrable(host)) : undefined;
    if (rd) info.rdap = rd;
    const hold = rd?.status?.some((s) => /hold|redemption|pending ?delete/i.test(s));
    return { health: "dns", detail: `${host} has no DNS records${rd?.error?.startsWith("not registered") ? " — the domain isn't registered anymore" : hold ? ` — registry status: ${rd!.status!.join(", ")}` : rd?.expires && daysUntil(rd.expires) < 0 ? ` — registration expired ${rd.expires.slice(0, 10)}` : " — expired, deleted or DNS removed?"}`, flags: hold ? ["domain_hold"] : flags, info, domainExpires: rd?.expires };
  }

  // 2) Page load (https first, then http to tell "SSL problem" from "down")
  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof safeFetch>> | null = null;
  let httpsErr = "";
  const load = (u: string) => safeFetch(u, { hosts: "public", headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteHealthCheck/1.0)", Accept: "text/html,*/*", "Accept-Language": "en-US" }, timeoutMs: 15000, maxBytes: 2_000_000, maxRedirects: 8, onRedirect: (status, from, to) => info.chain.push({ status, from, to }) });
  try { if (testHost) throw new Error("test: plain http"); res = await load(`https://${host}/`); }
  catch (e) {
    httpsErr = (e as Error).message;
    info.chain = [];
    try { res = await load(`http://${host}/`); } catch (e2) { info.error = `${httpsErr} · http: ${(e2 as Error).message}`; }
  }
  info.ms = Date.now() - t0;
  // SSL certificate (only if https is meant to work)
  if (!isStaging(host) && !testHost) {
    info.ssl = await sslInfo(host);
    if (info.ssl.validTo) { const d = daysUntil(info.ssl.validTo); if (d < 14 && d >= 0) flags.push("ssl_expiring"); }
  }
  // Domain registration (at most once a week per domain — RDAP servers are shared)
  let domainExpires = site.domain_expires || undefined;
  if (!isStaging(host) && !testHost && opts.rdap !== false && (!site.rdap_checked_at || Date.now() - Date.parse(site.rdap_checked_at) > 7 * DAY)) {
    info.rdap = await rdapInfo(registrable(host));
    if (info.rdap.expires) domainExpires = info.rdap.expires;
    if (info.rdap.status?.some((s) => /hold|redemption|pending ?delete/i.test(s))) flags.push("domain_hold");
  }
  if (domainExpires && daysUntil(domainExpires) < 30) flags.push("domain_expiring");

  if (!res) {
    const sslBroken = /CERT|SSL|TLS|ALTNAME|self.signed|UNABLE_TO_VERIFY/i.test(httpsErr) || !!info.ssl?.error;
    const timeout = /timed out|ETIMEDOUT/i.test(info.error || "");
    return { health: sslBroken && !timeout ? "ssl" : "down", detail: sslBroken && !timeout ? `SSL problem: ${info.ssl?.error || httpsErr}` : timeout ? "No answer within 15 seconds" : `Can't connect: ${(info.error || "").slice(0, 160)}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  }
  if (info.ms > 5000) flags.push("slow");
  info.status = res.status;
  info.finalUrl = res.url;
  const finalHost = new URL(res.url).hostname.toLowerCase();
  const html = /html|text|^$/i.test(res.headers.get("content-type") || "") ? res.text() : "";
  const $ = cheerio.load(html);
  info.title = ($("title").first().text() || $('meta[property="og:site_name"]').attr("content") || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const isDuda = DUDA.test(html);
  info.dudaAlias = html.match(/SiteAlias\s*[:=]\s*['"]([0-9a-z]{6,12})['"]/i)?.[1] || html.match(/"siteAlias"\s*:\s*"([0-9a-z]{6,12})"/i)?.[1];
  info.platform = isDuda ? "Duda" : PLATFORMS.find(([, re]) => re.test(html) || re.test(res!.headers.get("x-powered-by") || ""))?.[0] || "unknown";
  if (isDuda && info.dudaAlias && info.dudaAlias !== site.alias) flags.push("other_duda_site");
  const sslNote = httpsErr ? ` (https failed: ${httpsErr.slice(0, 80)} — works on http only)` : "";
  const otherDomain = registrable(finalHost) !== registrable(host.replace(/:\d+$/, ""));

  if (PARKED.test(html) && !isDuda) return { health: "parked", detail: `Parked / for-sale / expired page${info.title ? `: "${info.title}"` : ""}${otherDomain ? ` (at ${finalHost})` : ""}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (otherDomain) return { health: "redirect", detail: `Redirects to ${res.url}${isDuda ? info.dudaAlias === site.alias ? " — same Duda site, new domain" : " — a Duda site" : info.platform !== "unknown" ? ` (${info.platform})` : ""}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (res.status === 404 || res.status === 410) return { health: "not_found", detail: `HTTP ${res.status} — page not found${isDuda ? " (on Duda — site unpublished or domain disconnected?)" : ""}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (res.status >= 500) return { health: "error", detail: `HTTP ${res.status} — server error`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (res.status >= 400) return { health: "error", detail: `HTTP ${res.status}${res.status === 403 ? " — blocked / forbidden" : ""}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (httpsErr && !isStaging(host) && !testHost) return { health: "ssl", detail: `Site loads but SSL is broken${sslNote}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  if (isDuda) return { health: "ok", detail: `Live on Duda${info.dudaAlias ? ` (site ${info.dudaAlias}${info.dudaAlias !== site.alias ? ` — not ${site.alias}!` : ""})` : ""} · HTTP ${res.status} in ${(info.ms / 1000).toFixed(1)}s`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };

  // Live but not Duda: same shop on another platform, or someone else's website?
  // compare words without apostrophes ("Joe's" = "joes")
  const flat = (x: string) => x.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const text = flat(`${info.title} ${$("h1").first().text()} ${$('meta[name="description"]').attr("content") || ""} ${$("body").text().slice(0, 8000)}`);
  const sim = Math.max(nameSimilarity(flat(shop), flat(info.title || "")), nameSimilarity(flat(shop), flat($("h1").first().text())));
  const distinctive = flat(shop).split(" ").filter((w) => w.length > 3 && !/^(auto|automotive|repair|service|services|center|garage|shop|tire|tires|llc|inc|care|motors?)$/.test(w));
  const mentioned = distinctive.length ? distinctive.some((w) => ` ${text} `.includes(` ${w} `)) : sim >= 0.5;
  if (sim < 0.34 && !mentioned) return { health: "taken", detail: `Live on ${info.platform === "unknown" ? "another platform" : info.platform}, but it shows "${info.title || "(no title)"}" — doesn't look like ${shop}. The domain may have a new owner.`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
  return { health: "moved", detail: `Live, but no longer on Duda — now on ${info.platform === "unknown" ? "another platform" : info.platform}${info.title ? ` ("${info.title}")` : ""}`, flags, info, sslExpires: info.ssl?.validTo, domainExpires };
}
