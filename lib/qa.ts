/**
 * QA checks learned from the team's QA notes (links that go to the homepage, call / map / review links, anchors,
 * logo link, "inSarasota" headings, invisible text, Duda Business Info, map widgets, Jira facts that never made it
 * onto the site…). Each check says exactly what is wrong and what was expected.
 */
import type { PageData, Link, NavItem } from "./crawl";
import { MAPS_URL } from "./crawl";
import { type Facts, PHONE_RE, digits, formatPhone, normStreet, parseHours, normHoursValue, DAY_LABEL } from "./facts";
import { GLOBAL_PATH, sameBusiness, isLocationPage, type Finding, type Severity } from "./rules";
import { REGION_NAMES } from "./collect";
import type { SiteSnapshot } from "./duda";

export type QaCtx = {
  /** the link opens the site's homepage (no #section) */
  isHome: (abs: string) => boolean;
  /** the page path of an in-preview link ("/about-us"), or null for other sites */
  pathOf: (abs: string) => string | null;
  gbp: { placeId: string; cid: string; name: string; reviews: number | null; rating: number | null };
  /** vehicles they don't service ("Heavy diesel trucks", "Saab") */
  except: string[];
  /** e-mail for job applications (Data Collection "Email") */
  jobEmail: string;
  requested: string[];
  projectType: string | null;
  /** the site's settings are read directly (Business Info etc. are checked there, not from the page code) */
  settings?: boolean;
  /** every page the site has (from its settings), linked or not: "/careers" */
  sitePages?: string[];
};

type Add = (where: { selector: string; global: boolean }, f: Omit<Finding, "path" | "url" | "selector" | "source" | "global">) => void;

const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (x: string) => x.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9+]+/).filter(Boolean);
const label = (l: Link) => l.text || l.hint?.split(" ").slice(0, 4).join(" ") || "(icon)";
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- what a link / section is about ----------

/** Section / page kinds, from link text, anchor ids, page addresses and headings. */
export const SECTION_KEYS: [string, RegExp][] = [
  ["book", /\b(book|booking|appointments?|schedul\w*|reserve)\b/i],
  ["reviews", /\b(reviews?|testimonials?|what (our|people|customers|clients|drivers)\b.{0,25}\bsay(ing)?|(customers|clients) love us)\b/i],
  ["directions", /\b(directions?|get directions|map|find us|locate|navigate|pin|marker|map-marker|location-pin)\b/i],
  ["call", /\b(call|phone|dial|tel)\b/i],
  ["coupons", /\b(coupons?|specials?|offers?|deals?|promo\w*|discounts?|savings)\b/i],
  ["financing", /\b(financ\w*|payment (plans?|options))\b/i],
  ["careers", /\b(careers?|jobs?|hiring|employment|join (our|the) team)\b/i],
  ["warranty", /\b(warrant\w*|guarantee)\b/i],
  ["faq", /\b(faqs?|questions)\b/i],
  ["services", /\b(services?|repairs?)\b/i],
  ["vehicles", /\b(vehicles?|makes|brands|models)\b/i],
  ["about", /\b(about|our story|who we are)\b/i],
  ["contact", /\b(contact|get in touch)\b/i],
  ["blog", /\b(blog|news|articles?)\b/i],
  ["hours", /\b(hours|open)\b/i],
];
export function sectionKey(text: string): string {
  const t = text.replace(/[-_]+/g, " ");
  return SECTION_KEYS.find(([, re]) => re.test(t))?.[0] || "";
}
/** What a link is for: its own text first, then icon / aria hints. */
function linkIntent(l: Link): string {
  if (/^tel:/i.test(l.href)) return "call";
  const t = l.text.trim();
  if (t && PHONE_RE.test(t)) { PHONE_RE.lastIndex = 0; return "call"; }
  PHONE_RE.lastIndex = 0;
  return sectionKey(t) || (!t ? sectionKey(l.hint || "") : "");
}
const GOOGLE_REVIEWS = /search\.google\.[a-z.]+\/local\/(reviews|writereview)|[#&?]lrd=|g\.page\/r\/[^/]+\/review|\/maps\/place\/[^?#]*\/reviews|!9m1!1b1|writereview\?placeid|google\.[a-z.]+\/search\?[^#]*#lrd/i;
const SHORT_MAP = /maps\.app\.goo\.gl|goo\.gl\/maps|g\.page\/(?!r\/)|share\.google/i;

/** Does a Google Maps link point to this shop? "yes" / "no" (with why) / "unknown" (short link we can't read). */
function mapTarget(href: string, facts: Facts, ctx: QaCtx): { v: "yes" | "no" | "unknown"; why?: string } {
  let u = href;
  try { u = decodeURIComponent(href.replace(/\+/g, " ")); } catch { /* keep */ }
  if (SHORT_MAP.test(href) && !/[?&](q|query|destination|daddr)=/i.test(href)) return { v: "unknown" };
  if (ctx.gbp.placeId && u.includes(ctx.gbp.placeId)) return { v: "yes" };
  if (ctx.gbp.cid) {
    let hex = "";
    try { hex = "0x" + BigInt(ctx.gbp.cid).toString(16); } catch { /* not a number */ }
    if (u.includes(`cid=${ctx.gbp.cid}`) || (hex.length > 4 && u.toLowerCase().includes(hex))) return { v: "yes" };
  }
  const L = facts.locations;
  const low = u.toLowerCase();
  const streetHit = L.some((l) => { const m = l.street.match(/^(\d+)\s+(?:[NSEW]\.?\s+)?(\w+)/); return !!m && new RegExp(`\\b${m[1]}\\b[^0-9]{0,6}(?:[nsew]\\.?[\\s+]+)?${reEsc(m[2].toLowerCase())}`).test(low); });
  // the distinctive part of the name ("Werk Haus" in "Werk Haus Auto Repair LLC")
  const core = (n: string) => words(n).filter((w) => !/^(the|auto|automotive|repair|repairs|service|services|shop|center|centre|care|car|cars|garage|llc|inc|co|and|of|motors?|tire|tires)$/.test(w)).join("");
  const nameHit = [facts.businessName, ...facts.altNames, ctx.gbp.name].filter(Boolean).some((n) => { const k = core(n); return k.length >= 4 && squash(u).includes(k); });
  const cityHit = L.some((l) => l.city && low.includes(l.city.toLowerCase()));
  if (streetHit || (nameHit && cityHit)) return { v: "yes" };
  // another place: a different city / state in the address, or another Google place id
  const otherPid = u.match(/place_id[:=]([A-Za-z0-9_-]{20,})/)?.[1];
  if (otherPid && ctx.gbp.placeId && otherPid !== ctx.gbp.placeId) return { v: "no", why: "another Google place" };
  const st = u.match(/,\s*([A-Z]{2})\b(?:\s+\d{5})?/)?.[1];
  if (st && L.length && REGION_NAMES[st] && !L.some((l) => l.state.toUpperCase() === st)) return { v: "no", why: `an address in ${st}` };
  // an address typed into the link (?q=…, /dir/…) that names neither the shop nor its street / city
  const typed = u.match(/[?&](?:q|query|destination|daddr)=([^&#]+)/i)?.[1] || u.match(/\/maps\/(?:dir|search)\/([^/@?#]+)/i)?.[1] || "";
  if (typed && /\d|,/.test(typed) && L.length && !nameHit && !cityHit) return { v: "no", why: "an address that isn't the shop's" };
  return { v: "unknown" };
}

// ---------- per page ----------

export function auditPageQa(p: PageData, path: string, facts: Facts, ctx: QaCtx): Finding[] {
  const out: Finding[] = [];
  const add: Add = (b, f) => out.push({ ...f, path: b.global ? GLOBAL_PATH : path, url: p.finalUrl, selector: b.selector, source: "rule", global: b.global });
  const page = { selector: "head", global: false };
  const site = { selector: "head", global: true };
  const city = facts.locations[0]?.city || "";
  const ids = new Set(p.ids || []);
  const current = ctx.pathOf(p.url) || path;

  // ---------- links ----------
  for (const l of p.links) {
    const h = l.href.trim();
    if (!h || h === "#" || /^(mailto|sms|javascript):/i.test(h)) continue;
    const name = label(l);
    if (/\b(undefined|null|NaN)\b|\[object/i.test(h)) {
      add(l, { category: "Links", severity: "error", rule: "link-undefined", message: `“${name}” points to “${h.slice(0, 60)}” — the link is broken`, found: `${name} → ${h}` }); continue;
    }
    const intent = linkIntent(l);
    // anything but "Home" / the logo that opens the homepage: a button whose link was never set
    if (ctx.isHome(l.abs) && !/#./.test(h)) {
      const homeish = /^(home|homepage|home page|back to home|go home)$/i.test(l.text) || /logo/i.test(l.hint || "") || (!l.text && l.img && l.global);
      if (!homeish) {
        const cta = !!intent || /\b(visit|learn|read|view|see|more|details|get|shop|explore|start)\b/i.test(l.text) || l.img;
        if (cta || l.nav) add(l, { category: "Links", severity: "error", rule: "link-to-home", message: `“${name}” goes to the homepage${intent ? ` — it should go to ${({ book: "the booking widget", reviews: "the Google reviews", directions: "the shop on Google Maps", call: "the phone number (tel:)", coupons: "the coupons", financing: "financing", careers: "careers", warranty: "the warranty", faq: "the FAQ", services: "its service page", vehicles: "its vehicle page", about: "About Us", contact: "contact", blog: "the blog", hours: "the hours" } as Record<string, string>)[intent] || "its own page"}` : ""}`, found: `${name}${l.context && l.context !== l.text ? ` (in “${l.context.slice(0, 80)}”)` : ""} → ${h}` });
        else add(l, { category: "Links", severity: "warning", rule: "link-to-home-text", message: `Link “${name}” goes to the homepage — check it's meant to`, found: `${name} → ${h}` });
        continue;
      }
    }
    // "Call Us" that doesn't dial
    if (intent === "call" && !/^tel:/i.test(h) && /^(call|phone|tap to call|click to call)\b|^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/i.test(l.text.trim()))
      add(l, { category: "Contact info", severity: "error", rule: "call-not-tel", message: `“${name}” isn't a click-to-call link`, found: `${name} → ${h}`, expected: facts.phones[0] ? `tel:${digits(facts.phones[0])}` : "tel:<phone>" });
    // "See all reviews" → the Google reviews (not the profile, not the homepage)
    if (intent === "reviews" && /google\.|g\.page|goo\.gl|share\.google/i.test(l.abs) && !GOOGLE_REVIEWS.test(l.abs) && !SHORT_MAP.test(l.abs))
      add(l, { category: "Links", severity: "error", rule: "reviews-not-google-reviews", message: `“${name}” opens the Google Business Profile, not the Google reviews`, found: `${name} → ${h}`, expected: ctx.gbp.placeId ? `https://search.google.com/local/reviews?placeid=${ctx.gbp.placeId}` : "the Google reviews link" });
    // Maps / directions / pin → this shop on Google Maps
    if (MAPS_URL.test(l.abs)) {
      const m = mapTarget(l.abs, facts, ctx);
      if (m.v === "no") add(l, { category: "Contact info", severity: "error", rule: "map-wrong-place", message: `“${name}” opens ${m.why || "another place"} on Google Maps — not the shop`, found: `${name} → ${h.slice(0, 160)}`, expected: facts.locations[0] ? `${facts.businessName}, ${facts.locations[0].street}, ${facts.locations[0].city}, ${facts.locations[0].state}` : "the shop's Google Business Profile" });
    } else if (intent === "directions" && !/^tel:/i.test(h) && !/#./.test(h) && !(ctx.pathOf(l.abs) || "").match(/location|contact|direction/i)) {
      add(l, { category: "Contact info", severity: "error", rule: "directions-not-map", message: `“${name}” doesn't open Google Maps`, found: `${name} → ${h}`, expected: "the shop on Google Maps (GBP)" });
    }
    // #anchor links: the section must exist, and be the right one ("Directions" → #financing)
    const hm = l.abs.match(/#([^?#]+)$/);
    if (hm) {
      const anchor = decodeURIComponent(hm[1]).toLowerCase();
      const target = ctx.pathOf(l.abs.replace(/#.*$/, ""));
      const samePage = h.startsWith("#") || target === current;
      if (samePage && ids.size && !ids.has(anchor) && !/^(top|main|content|!)/.test(anchor))
        add(l, { category: "Links", severity: "error", rule: "anchor-missing", message: `“${name}” jumps to #${anchor}, but there's no such section on ${current === "/" ? "the homepage" : current}`, found: `${name} → ${h}` });
      const want = linkIntent(l), have = sectionKey(anchor);
      if (want && have && want !== have && !(want === "call" || want === "book") && !(want === "directions" && /contact|hours|location/.test(have)) && !(want === "contact" && /directions|hours/.test(have)))
        add(l, { category: "Links", severity: "error", rule: "anchor-mismatch", message: `“${name}” jumps to the #${anchor} section`, found: `${name} → ${h}`, expected: `the ${want} section` });
    }
  }

  // ---------- logo → homepage ----------
  for (const im of p.images) {
    if (!im.logo || !im.global) continue;
    if (im.href === null || im.href === undefined) { add(im, { category: "Links", severity: "warning", rule: "logo-not-linked", message: "The logo isn't linked to the homepage", found: im.src.split("/").pop()?.split("?")[0] || "logo" }); continue; }
    let abs = im.href; try { abs = new URL(im.href, p.finalUrl).toString(); } catch { /* keep */ }
    if (!ctx.isHome(abs) && !/^\/?$/.test(im.href.replace(/\?.*$/, "")))
      add(im, { category: "Links", severity: "error", rule: "logo-link", message: "The logo doesn't go to the homepage", found: `logo → ${im.href}`, expected: "the homepage" });
  }

  // ---------- Google Maps widgets ----------
  for (const m of p.mapEmbeds || []) {
    const t = mapTarget(m.src, facts, ctx);
    if (t.v === "no") add(m, { category: "Contact info", severity: "error", rule: "map-embed-wrong", message: `The map shows ${t.why || "another place"} — not the shop`, found: m.src.slice(0, 180), expected: facts.locations[0] ? `${facts.locations[0].street}, ${facts.locations[0].city}, ${facts.locations[0].state}` : "the shop's address" });
  }

  // ---------- phone numbers shown as text but not clickable ----------
  const shownTel = new Set(p.links.filter((l) => /^tel:/i.test(l.href)).map((l) => digits(l.href)));
  for (const u of p.unlinkedPhones || []) {
    if (shownTel.has(digits(u.text)) && u.global) continue; // the same number is a link right there in the header/footer
    add(u, { category: "Contact info", severity: "warning", rule: "phone-not-linked", message: "Phone number isn't a click-to-call link", found: u.text });
  }

  // ---------- invisible text ----------
  for (const c of p.lowContrast || []) add(c, { category: "Design", severity: "error", rule: "text-invisible", message: "Text is nearly invisible — same color as its background", found: `${c.text} (${c.colors})` });

  // ---------- headings ----------
  const hs = p.headings.filter((x) => x.text);
  if (hs.length && hs[0].level !== 1 && p.h1s.length) add({ selector: hs[0].selector, global: false }, { category: "SEO", severity: "error", rule: "h1-not-first", message: `The first heading is an H${hs[0].level} — the H1 must come first`, found: `H${hs[0].level}: ${hs[0].text.slice(0, 80)} · H1: ${p.h1s[0].slice(0, 60)}` });
  const seenH = new Map<string, number>();
  for (const x of hs) if (x.level === 2) seenH.set(x.text.toLowerCase(), (seenH.get(x.text.toLowerCase()) || 0) + 1);
  for (const [t, n] of seenH) if (n > 1 && t.length > 3) add(page, { category: "Content", severity: "warning", rule: "heading-repeated", message: `${n} sections use the same heading`, found: t });

  // ---------- text ----------
  const texts: { t: string; where: { selector: string; global: boolean }; heading: boolean }[] = [
    ...p.blocks.filter((b) => !b.quote).map((b) => ({ t: b.text, where: b as { selector: string; global: boolean }, heading: /^h\d$/.test(b.tag) })),
    ...(p.title ? [{ t: p.title, where: page, heading: true }] : []),
    ...(p.metaDescription ? [{ t: p.metaDescription, where: page, heading: false }] : []),
  ];
  const cityKey = squash(city);
  for (const { t, where, heading } of texts) {
    // "Auto Repair inSarasota", "Servicesin Laredo"
    const glued = t.match(/\b(in|near|at|of|for|from|serving)([A-Z][a-z]{2,})/) || t.match(/\b(Services?|Repairs?|Vehicles?|Shop|Brakes?|Maintenance|Auto)(in|near)\b/);
    if (glued && !/^(Infiniti|Inspection|Info|Instagram|Inside|Interior|Inner|Indian|Installation|Inc)/.test(glued[0]))
      add(where, { category: "Spelling", severity: "error", rule: "missing-space", message: `Missing space: “${glued[0]}”`, found: t.length > 140 ? t.slice(0, 140) + "…" : t, expected: t.replace(glued[0], glued[0].replace(/^(in|near|at|of|for|from|serving)(?=[A-Z])/, "$1 ").replace(/(in|near)$/, " $1")) });
    // the shop's city misspelled ("Saratos" for "Sarasota")
    if (cityKey.length >= 5) for (const w of t.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]{3,})?\b/g) || []) {
      const k = squash(w);
      const maxD = cityKey.length >= 8 ? 3 : cityKey.length >= 6 ? 2 : 1;
      if (k !== cityKey && Math.abs(k.length - cityKey.length) <= 2 && k.slice(0, 3) === cityKey.slice(0, 3) && lev(k, cityKey) <= maxD && !facts.citiesServed.some((c) => squash(c) === k)) {
        add(where, { category: "Spelling", severity: "error", rule: "city-misspelled", message: `City spelled “${w}” — the shop is in ${city}`, found: t.length > 140 ? t.slice(0, 140) + "…" : t, expected: city });
        break;
      }
    }
    if (/\bcoming soon\b/i.test(t)) add(where, { category: "Content", severity: "error", rule: "coming-soon", message: "“Coming soon” left on the page", found: t.slice(0, 140) });
    const ym = t.match(/\b\d+\s*(?:y|yr|yrs|years?)\s*\/\s*\d+\s*k?\s*(?:months?|mos?)\b|\b\d+\s*(?:months?|mos?)\s*\/\s*\d+\s*(?:y|yr|years?)\b/i);
    if (ym) add(where, { category: "Content", severity: "error", rule: "years-months-mixed", message: `“${ym[0]}” mixes years and months`, found: t.slice(0, 140), expected: "e.g. 36 Months / 36,000 Miles or 3 Years / 36,000 Miles" });
    const dp = t.match(/[^.]\.\.(?!\.)(?=\s|$)/);
    if (dp && !heading) add(where, { category: "Spelling", severity: "error", rule: "double-period", message: "Double period", found: excerpt(t, dp.index ?? 0) });
    // vehicles they don't service
    for (const ex of ctx.except) {
      const k = ex.trim();
      if (k.length < 3) continue;
      const re = new RegExp(`\\b${reEsc(k).replace(/\\s+/g, "\\s+")}s?\\b`, "i");
      if (re.test(t) && !/\b(not|n't|except|excluding|no)\b[^.]{0,40}$/i.test(t.slice(0, t.search(re))))
        add(where, { category: "Content", severity: "error", rule: "vehicle-not-serviced", message: `Mentions “${k}”, which they don't service (Jira)`, found: t.slice(0, 140) });
    }
  }
  for (const im of p.images) {
    const a = im.alt || "";
    const dbl = a.match(/\b(\w{2,})\s+\1\b/i);
    if (dbl) add(im, { category: "Images", severity: "error", rule: "alt-double-word", message: `Repeated word in alt text: “${dbl[0]}”`, found: a });
    if (/adobestock|shutterstock|istockphoto|gettyimages|depositphotos|dreamstime|123rf/i.test(im.src)) add(im, { category: "Images", severity: "warning", rule: "stock-image", message: "Stock-photo file — use the template's own image", found: im.src.split("/").pop()?.split("?")[0] || im.src });
  }

  // ---------- meta description: the shop's own state ----------
  const L = facts.locations[0];
  if (p.metaDescription && L?.state && !isLocationPage(path)) {
    const other = [...p.metaDescription.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1]).find((st) => REGION_NAMES[st] && st !== L.state.toUpperCase());
    if (other) add(page, { category: "SEO", severity: "error", rule: "meta-other-location", message: `Meta description names another state (${other}) — the shop is in ${L.city}, ${L.state}`, found: p.metaDescription });
  }

  // ---------- Duda Business Info (site settings → structured data) ----------
  const bi = p.bizInfo; // (replaced by the site-settings checks at the end of the run when those can be read)
  if (bi) {
    const ph = digits(bi.telephone);
    if (ph && facts.phones.length && !facts.phones.some((x) => digits(x) === ph))
      add(site, { category: "Business Info", severity: "error", rule: "bizinfo-phone", message: "Business Info has the wrong phone number", found: bi.telephone, expected: facts.phones.map(formatPhone).join(", ") });
    if (bi.street && L?.street && normStreet(bi.street) !== normStreet(L.street) && !normStreet(bi.street).startsWith(normStreet(L.street).split(" ").slice(0, 2).join(" ")))
      add(site, { category: "Business Info", severity: "error", rule: "bizinfo-address", message: "Business Info has the wrong street address", found: `${bi.street}, ${bi.city} ${bi.region} ${bi.zip}`, expected: `${L.street}, ${L.city}, ${L.state} ${L.zip}` });
    if (bi.zip && L?.zip && !bi.zip.startsWith(L.zip))
      add(site, { category: "Business Info", severity: "error", rule: "bizinfo-zip", message: "Business Info has the wrong ZIP code", found: bi.zip, expected: L.zip });
    if (bi.name && facts.businessName && !sameBusiness(bi.name, facts.businessName) && !facts.altNames.some((n) => sameBusiness(bi.name, n)) && !(ctx.gbp.name && sameBusiness(bi.name, ctx.gbp.name)))
      add(site, { category: "Business Info", severity: "error", rule: "bizinfo-name", message: "Business Info has another business name", found: bi.name, expected: facts.businessName });
    if (/example\.com|yourdomain|domain\.com|company website|website\.com/i.test(bi.url))
      add(site, { category: "Business Info", severity: "error", rule: "bizinfo-website", message: "Business Info: Company Website is still placeholder text", found: bi.url });
    const bh = bi.hours.join("; ");
    if (bh && facts.hours.length) {
      const got = parseSchemaHours(bi.hours);
      for (const fh of facts.hours) {
        const g = got.get(fh.day);
        if (g !== undefined && normHoursValue(g) !== normHoursValue(fh.value))
          add(site, { category: "Business Info", severity: "error", rule: "bizinfo-hours", message: `Business Info: ${DAY_LABEL[fh.day]} hours are wrong`, found: g || "(closed)", expected: fh.value });
      }
    }
  }
  return out;
}

/** "Mo-Fr 08:00-17:00" / "Monday,Tuesday 08:00-17:00" → day → "8:00 AM - 5:00 PM" */
function parseSchemaHours(lines: string[]): Map<string, string> {
  const D = ["mo", "tu", "we", "th", "fr", "sa", "su"], K = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const out = new Map<string, string>();
  const t12 = (x: string) => { const m = x.match(/(\d{1,2}):(\d{2})/); if (!m) return x; const h = Number(m[1]); return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`; };
  for (const line of lines) {
    const m = line.match(/^([A-Za-z,\s-]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) continue;
    const days = new Set<number>();
    for (const part of m[1].split(/[,\s]+/).filter(Boolean)) {
      const [a, b] = part.split("-").map((x) => D.indexOf(x.slice(0, 2).toLowerCase()));
      if (a < 0) continue;
      if (b !== undefined && b >= 0) for (let i = a; i <= b; i++) days.add(i); else days.add(a);
    }
    for (const i of days) out.set(K[i], `${t12(m[2])} - ${t12(m[3])}`);
  }
  return out;
}

// ---------- site-wide ----------

/** Words that make a Jira item recognisable on the page ("24-Hour Key Drop-Off" → key, drop). */
const FILLER = /^(and|the|our|your|with|for|of|on|in|to|a|an|we|free|all|available|service|services|offered|options?|auto|car|repair|shop|certified|technicians?|approved|rated|over)$/i;
function keyWords(item: string) { return words(item).filter((w) => w.length > 2 && !FILLER.test(w)); }
/** Known badge brands (shown as logos in a certifications slider — look in image names / alt text too). */
const BRANDS: [string, RegExp][] = [
  ["ASE", /\base\b|ase[-_ ]?(cert|logo|blue)/i], ["AAA", /\baaa\b/i], ["NAPA", /\bnapa\b/i], ["BBB", /\bbbb\b/i], ["I-CAR", /\bi-?car\b/i],
  ["Worldpac", /worldpac/i], ["Carfax", /carfax/i], ["Bosch", /\bbosch\b/i], ["ACDelco", /ac-?delco/i], ["AskPatty", /ask-?patty|female[- ]friendly/i],
  ["RepairPal", /repairpal/i], ["TechNet", /tech-?net/i], ["AMSOIL", /amsoil/i], ["Motorcraft", /motorcraft/i], ["Mopar", /\bmopar\b/i], ["ATRA", /\batra\b/i],
];

export function sitewideQa(pages: { path: string; url: string; data: PageData }[], facts: Facts, ctx: QaCtx): Finding[] {
  const out: Finding[] = [];
  const site = { path: "Site-wide", url: "", selector: "", source: "rule" as const, global: true };
  const home = pages.find((p) => p.path === "/") || pages[0];
  if (!home) return out;
  const custom = (k: string) => facts.custom.find((c) => c.key.toLowerCase() === k.toLowerCase())?.value || "";
  const textAll = pages.flatMap((p) => p.data.blocks.map((b) => b.text)).join("\n");
  const imgAll = pages.flatMap((p) => p.data.images.map((i) => `${i.alt || ""} ${decodeURIComponent(i.src.split("/").pop() || "").replace(/[-_.]+/g, " ")}`)).join("\n");
  const seeAll = `${textAll}\n${imgAll}`;
  const seeAllWords = ` ${words(seeAll).join(" ")} `;

  // #links into another page: that page must have the section
  const byPath = new Map(pages.map((p) => [p.path, p]));
  for (const p of pages) for (const l of p.data.links) {
    const m = l.abs.match(/#([^?#]+)$/);
    if (!m || l.href.startsWith("#")) continue;
    const target = ctx.pathOf(l.abs.replace(/#.*$/, ""));
    if (!target || target === p.path) continue;
    const tp = byPath.get(target);
    const anchor = decodeURIComponent(m[1]).toLowerCase();
    if (tp && (tp.data.ids || []).length && !(tp.data.ids || []).includes(anchor))
      out.push({ ...site, path: l.global ? GLOBAL_PATH : p.path, url: p.url, selector: l.selector, global: l.global, category: "Links", severity: "error", rule: "anchor-missing", message: `“${label(l)}” jumps to ${target}#${anchor}, but that page has no such section`, found: `${label(l)} → ${l.href}` });
  }

  // menu: the same item twice; items that weren't requested
  const dupes = [...new Set(pages.flatMap((p) => p.data.navDupes || []))];
  for (const d of dupes) out.push({ ...site, path: GLOBAL_PATH, url: home.url, selector: "nav", category: "Navigation", severity: "error", rule: "nav-duplicate", message: `“${d}” appears twice in the menu`, found: d });
  if (ctx.requested.length) {
    const reqKeys = new Set(ctx.requested.map((r) => sectionKey(r)).filter(Boolean));
    const nav = uniqNav(pages.flatMap((p) => p.data.navItems || []));
    for (const n of nav) {
      const k = sectionKey(n.text);
      if (["careers", "coupons", "financing", "warranty", "reviews", "blog", "vehicles", "faq"].includes(k) && !reqKeys.has(k))
        out.push({ ...site, path: GLOBAL_PATH, url: home.url, selector: n.selector, category: "Navigation", severity: "error", rule: "nav-not-requested", message: `The menu has “${n.text}”, but it wasn't requested in Jira`, found: n.text, expected: `Requested: ${ctx.requested.join(", ")}` });
    }
    // every requested page / section must exist (a page, or a section heading on the page)
    const headingKeys = new Set(pages.flatMap((p) => p.data.headings.map((h) => sectionKey(h.text))).filter(Boolean));
    const pathKeys = new Set([...pages.map((p) => p.path), ...(ctx.sitePages || [])].map((x) => sectionKey(x)).filter(Boolean));
    const idKeys = new Set([...pages.flatMap((p) => (p.data.ids || []).map((i) => sectionKey(i))), ...nav.map((n) => sectionKey(n.text))].filter(Boolean));
    // pages the site has but nobody asked for (template pages left in) — Advanced / MSO sites
    if (ctx.projectType !== "basic") for (const sp of ctx.sitePages || []) {
      const k = sectionKey(sp);
      if (["careers", "coupons", "financing", "warranty", "reviews", "blog", "vehicles", "faq"].includes(k) && !reqKeys.has(k) && sp.split("/").filter(Boolean).length === 1)
        out.push({ ...site, path: sp, url: home.url, category: "Content", severity: "warning", rule: "page-not-requested", message: `The site has a “${sp.replace(/^\//, "")}” page, but it wasn't requested in Jira`, found: sp, expected: `Requested: ${ctx.requested.join(", ")}` });
    }
    for (const r of ctx.requested) {
      const k = sectionKey(r);
      if (!k) continue;
      if (k === "contact" && ctx.projectType === "basic") continue;
      if (!headingKeys.has(k) && !pathKeys.has(k) && !idKeys.has(k))
        out.push({ ...site, url: home.url, category: "Content", severity: "error", rule: "requested-missing", message: `Requested ${ctx.projectType === "basic" ? "section" : "page"} “${r}” isn't on the site`, expected: r });
    }
  }

  // Jira certifications must be on the site (text, logos' alt text or file names)
  const certs = custom("Certifications").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  for (const c of certs) {
    const brand = BRANDS.find(([, re]) => re.test(c));
    const found = brand ? brand[1].test(seeAll) : keyWords(c).length > 0 && keyWords(c).every((w) => seeAllWords.includes(` ${w} `));
    if (!found) out.push({ ...site, url: home.url, category: "Certifications", severity: "error", rule: "cert-missing", message: `Certification from Jira isn't on the site: ${c}`, expected: c });
  }
  // badges on the site that aren't in Jira ("AAA was not mentioned on the survey but was included")
  const jiraAll = `${custom("Certifications")} ${custom("Amenities")} ${custom("Warranty")} ${custom("Financing")} ${facts.notes}`;
  for (const [nameB, re] of BRANDS) {
    if (re.test(jiraAll)) continue;
    const img = pages.flatMap((p) => p.data.images.map((i) => ({ p, i }))).find(({ i }) => re.test(`${i.alt || ""} ${i.src.split("/").pop()}`));
    if (img) out.push({ ...site, path: img.i.global ? GLOBAL_PATH : img.p.path, url: img.p.url, selector: img.i.selector, global: img.i.global, category: "Certifications", severity: "warning", rule: "cert-not-in-jira", message: `${nameB} badge is on the site, but ${nameB} isn't in the Jira`, found: `${img.i.alt || ""} ${img.i.src.split("/").pop()}`.trim() });
  }
  // coupons: each amount from Jira is on the site
  // coupons: each Jira coupon's amounts ($20 off, 10%) are on the site — one finding per coupon
  const flatText = textAll.replace(/\s/g, "");
  for (const line of custom("Coupons").split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    const amts = [...new Set(line.match(/\$\s?\d+(?:\.\d\d)?|\b\d{1,2}\s?%/g) || [])].map((a) => a.replace(/\s/g, ""));
    const miss = amts.filter((a) => !flatText.includes(a));
    if (amts.length && miss.length) out.push({ ...site, url: home.url, category: "Content", severity: "error", rule: "coupon-missing", message: `Coupon from Jira isn't on the site (${miss.join(", ")} not found)`, expected: line.slice(0, 160) });
  }
  // warranty requested / given → on the site, with the same terms
  const war = custom("Warranty");
  const wantWar = !!war || ctx.requested.some((r) => /warrant/i.test(r));
  if (wantWar && !/warrant/i.test(textAll)) out.push({ ...site, url: home.url, category: "Content", severity: "error", rule: "warranty-missing", message: "No warranty on the site — it's in the Jira / requested", expected: war || "Warranty section" });
  else if (war) {
    const nums = (war.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+/g) || []).filter((n) => n.length >= 2);
    const flat = textAll.replace(/(\d),(\d{3})/g, "$1$2");
    const missing = nums.filter((n) => !new RegExp(`\\b${n}\\b|\\b${n.replace(/000$/, "")}k\\b`, "i").test(flat));
    if (nums.length && missing.length) out.push({ ...site, url: home.url, category: "Content", severity: "warning", rule: "warranty-terms", message: `Warranty terms on the site don't match the Jira (${missing.join(", ")} not found)`, expected: war });
  }
  // review count / rating vs. the GBP
  if (ctx.gbp.reviews) for (const p of pages) for (const b of p.data.blocks) {
    const m = b.text.match(/\b(\d[\d,]*)\+?\s*(?:google\s*)?(?:5[- ]star\s*)?reviews\b/i);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (n > 3 && (n > ctx.gbp.reviews * 1.1 || n < ctx.gbp.reviews * 0.5)) { out.push({ ...site, path: b.global ? GLOBAL_PATH : p.path, url: p.url, selector: b.selector, global: b.global, category: "Content", severity: "warning", rule: "review-count", message: `Review count says ${m[1]} — the GBP has ${ctx.gbp.reviews}`, found: b.text.slice(0, 120), expected: `${ctx.gbp.reviews} reviews` }); break; }
  }
  // privacy policy link
  if (!pages.some((p) => p.data.links.some((l) => /privacy/i.test(`${l.text} ${l.href}`))))
    out.push({ ...site, path: GLOBAL_PATH, url: home.url, selector: "footer", category: "Links", severity: "error", rule: "privacy-link-missing", message: "No Privacy Policy link on the site" });
  // accessibility widget + home-screen icon (checked on the homepage)
  if (home.data.widgets && !home.data.widgets.userway) out.push({ ...site, url: home.url, category: "SEO", severity: "error", rule: "userway-missing", message: "Accessibility by UserWay isn't installed" });
  if (home.data.widgets && !home.data.widgets.touchIcon) out.push({ ...site, url: home.url, category: "SEO", severity: "warning", rule: "touch-icon-missing", message: "No mobile home-screen icon (Site settings → Mobile Device Home Screen Icon)" });
  // contact / careers forms send to the right inbox
  for (const p of pages) for (const r of p.data.formRecipients || []) {
    if (/example\.|test@|yourdomain|domain\.com|@email\.com|placeholder/i.test(r))
      out.push({ ...site, path: p.path, url: p.url, category: "Contact info", severity: "error", rule: "form-email-placeholder", message: "A form sends to a placeholder email", found: r, expected: ctx.jobEmail || facts.emails[0] || "the shop's email" });
    else if (/career|job|hiring|employ/i.test(p.path) && ctx.jobEmail && r !== ctx.jobEmail.toLowerCase())
      out.push({ ...site, path: p.path, url: p.url, category: "Contact info", severity: "error", rule: "careers-form-email", message: "The careers form doesn't send to the job-applications email from Jira", found: r, expected: ctx.jobEmail });
  }
  return out;
}

/** Jira amenities / services that aren't found word-for-word: the AI decides whether the site covers them in other words. */
export function unmatchedItems(items: string[], pages: { data: PageData }[]) {
  const all = ` ${words(pages.flatMap((p) => [...p.data.blocks.map((b) => b.text), ...p.data.images.map((i) => i.alt || "")]).join(" ")).join(" ")} `;
  return items.filter((it) => { const k = keyWords(it); return k.length > 0 && k.filter((w) => all.includes(` ${w} `) || all.includes(` ${w}s `)).length / k.length < 0.75; });
}

function uniqNav(xs: NavItem[]) { const seen = new Set<string>(); return xs.filter((n) => { const k = n.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
const excerpt = (t: string, i: number) => (i > 30 ? "…" : "") + t.slice(Math.max(0, i - 30), i + 60) + (t.length > i + 60 ? "…" : "");
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export type { Severity };

// ---------- site settings (labels, site SEO, Business Info, business texts, every page, collections) ----------


export const SETTINGS_PATH = "Site settings";
const stripHtml = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const endsWithBusiness = (s: string, names: string[]) => { const t = s.includes("|") ? s.slice(s.lastIndexOf("|") + 1).trim() : ""; return !!t && names.some((n) => sameBusiness(t, n)); };
const otherState = (s: string, state: string) => [...s.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1]).find((st) => REGION_NAMES[st] && st !== state.toUpperCase());
/** maps?cid=123 or …!1s0x…:0xHEX… → the GBP cid (decimal) */
function cidOf(v: string) {
  const d = v.match(/cid=(\d{6,})/)?.[1];
  if (d) return d;
  const h = v.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i)?.[1];
  if (h) { try { return BigInt("0x" + h).toString(); } catch { return ""; } }
  return "";
}

/**
 * Checks that only the site's settings can answer: labels (blank / wrong template number), the site-wide meta title
 * and description, Business Info (phone, address, hours, area served, Google profile), the business texts the
 * template shows (Business Name, City State, Pretty Address, Pretty Business Hours, Company Website), the logo's alt
 * text, every page's SEO (pages nothing links to included) and every collection item (service / vehicle pages).
 */
export function siteSettingsQa(snap: SiteSnapshot, facts: Facts, ctx: QaCtx, opts: { templateNumber: string; crawled: Set<string>; homeUrl: string }): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "path" | "url" | "selector" | "source" | "global"> & { path?: string }) =>
    out.push({ path: f.path || SETTINGS_PATH, url: opts.homeUrl, selector: "", source: "rule", global: !f.path, ...f } as Finding);
  const names = [facts.businessName, ...facts.altNames, ctx.gbp.name].filter(Boolean);
  const biz = facts.businessName || ctx.gbp.name;
  const L = facts.locations[0];

  // labels
  out.push(...labelChecks(snap, facts, ctx, opts).map((f) => ({ path: SETTINGS_PATH, url: opts.homeUrl, selector: "", source: "rule" as const, global: true, ...f })));

  // site-wide SEO
  const seo = snap.site.site_seo || {};
  if (!String(seo.title || "").trim()) add({ category: "SEO", severity: "error", rule: "site-meta-title-blank", message: "Site meta title is blank (Site settings → SEO)" });
  else {
    if (biz && !endsWithBusiness(String(seo.title), names)) add({ category: "SEO", severity: "error", rule: "site-meta-title-name", message: `Site meta title must end with “ | ${biz}”`, found: String(seo.title) });
    const os = L?.state && otherState(String(seo.title), L.state);
    if (os) add({ category: "SEO", severity: "error", rule: "site-meta-other-location", message: `Site meta title names another state (${os})`, found: String(seo.title), expected: `${L!.city}, ${L!.state}` });
  }
  if (!String(seo.description || "").trim()) add({ category: "SEO", severity: "error", rule: "site-meta-description-blank", message: "Site meta description is blank (Site settings → SEO)" });
  else if (L?.state) { const os = otherState(String(seo.description), L.state); if (os) add({ category: "SEO", severity: "error", rule: "site-meta-other-location", message: `Site meta description names another state (${os})`, found: String(seo.description), expected: `${L.city}, ${L.state}` }); }
  if (!snap.site.fav_icon) add({ category: "Site settings", severity: "warning", rule: "favicon-missing", message: "No favicon set" });

  // Business Info
  const loc = snap.content.location_data || {};
  const phones = (loc.phones || []).map((p) => p.phoneNumber).filter(Boolean);
  if (facts.phones.length) {
    if (!phones.length) add({ category: "Business Info", severity: "error", rule: "info-phone", message: "Business Info has no phone number", expected: facts.phones.map(formatPhone).join(", ") });
    for (const ph of phones) if (!facts.phones.some((x) => digits(x) === digits(ph))) add({ category: "Business Info", severity: "error", rule: "info-phone", message: "Business Info has the wrong phone number", found: ph, expected: facts.phones.map(formatPhone).join(", ") });
  }
  const a = loc.address || {};
  if (L?.street) {
    if (!a.streetAddress) add({ category: "Business Info", severity: "error", rule: "info-address", message: "Business Info has no address", expected: `${L.street}, ${L.city}, ${L.state} ${L.zip}` });
    else if (normStreet(a.streetAddress) !== normStreet(L.street) || (a.postalCode && L.zip && !a.postalCode.startsWith(L.zip)))
      add({ category: "Business Info", severity: "error", rule: "info-address", message: "Business Info has the wrong address", found: `${a.streetAddress}, ${a.city || ""} ${a.region || ""} ${a.postalCode || ""}`.trim(), expected: `${L.street}, ${L.city}, ${L.state} ${L.zip}` });
  }
  if (facts.hours.length && (loc.business_hours || []).length) {
    const K: Record<string, string> = { MON: "mon", TUE: "tue", WED: "wed", THU: "thu", FRI: "fri", SAT: "sat", SUN: "sun" };
    const t12 = (x: string) => { const m = x.match(/(\d{1,2}):(\d{2})/); if (!m) return x; const h = Number(m[1]); return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`; };
    const got = new Map<string, string>();
    for (const h of loc.business_hours || []) for (const d of h.days || []) if (K[d.toUpperCase()]) got.set(K[d.toUpperCase()], h.open && h.close ? `${t12(h.open)} - ${t12(h.close)}` : "Closed");
    for (const fh of facts.hours) {
      const g = got.get(fh.day) ?? "Closed";
      if (normHoursValue(g) !== normHoursValue(fh.value)) add({ category: "Business Info", severity: "error", rule: "info-hours", message: `Business Info: ${DAY_LABEL[fh.day]} hours are wrong`, found: g, expected: fh.value });
    }
  }
  if (!(loc.schema?.area_served || []).length) add({ category: "Business Info", severity: "error", rule: "area-served-blank", message: "Area Served is blank (Business Info)", expected: L ? `${L.city}, ${REGION_NAMES[L.state.toUpperCase()] || L.state}` : undefined });
  const gmb = String((loc.social_accounts as Record<string, unknown> | undefined)?.google_my_business || "");
  if (gmb && ctx.gbp.cid) { const c = cidOf(gmb); if (c && c !== ctx.gbp.cid) add({ category: "Business Info", severity: "error", rule: "info-gbp", message: "Business Info's Google Business Profile is another listing", found: gmb.slice(0, 120), expected: `https://www.google.com/maps?cid=${ctx.gbp.cid}` }); }
  else if (!gmb && (ctx.gbp.cid || ctx.gbp.placeId)) add({ category: "Business Info", severity: "warning", rule: "info-gbp", message: "Business Info has no Google Business Profile link", expected: ctx.gbp.cid ? `https://www.google.com/maps?cid=${ctx.gbp.cid}` : undefined });
  const logoAlt = String(snap.content.business_data?.logo_alt_text || "").trim();
  if (snap.content.business_data?.logo_url && biz && !endsWithBusiness(logoAlt, names))
    add({ category: "Images", severity: "error", rule: "logo-alt", message: `Logo alt text must end with “ | ${biz}”`, found: logoAlt || "(empty)", expected: `Company Logo | ${biz}` });

  // the business texts the template shows ("Business Text" in QA)
  const texts = new Map((snap.content.site_texts?.custom || []).map((t) => [t.label.trim().toLowerCase(), { label: t.label.trim(), text: stripHtml(t.text || ""), html: t.text || "" }]));
  const tx = (k: string) => texts.get(k);
  const bn = tx("business name");
  if (bn && biz && !names.some((n) => sameBusiness(bn.text, n))) add({ category: "Business text", severity: "error", rule: "text-business-name", message: "Business text “Business Name” is wrong", found: bn.text || "(empty)", expected: biz });
  const cs = tx("city state");
  if (cs && L?.city && (!new RegExp(`\\b${L.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cs.text) || otherState(cs.text, L.state)))
    add({ category: "Business text", severity: "error", rule: "text-city-state", message: "Business text “City State” is wrong", found: cs.text || "(empty)", expected: `${L.city}, ${L.state.toUpperCase()}` });
  const pa = tx("pretty address");
  if (pa && L?.street) {
    if (normStreet(pa.text).indexOf(normStreet(L.street).split(" ").slice(0, 2).join(" ")) < 0 || (L.zip && !pa.text.includes(L.zip)))
      add({ category: "Business text", severity: "error", rule: "text-address", message: "Business text “Pretty Address” is wrong", found: pa.text || "(empty)", expected: `${L.street}, ${L.city}, ${L.state} ${L.zip}` });
    const link = pa.html.match(/href=\\?"([^"\\]+)/)?.[1] || "";
    const c = link ? cidOf(link) : "";
    if (c && ctx.gbp.cid && c !== ctx.gbp.cid) add({ category: "Business text", severity: "error", rule: "text-address-link", message: "The address link opens another Google listing", found: link.slice(0, 120), expected: `https://www.google.com/maps?cid=${ctx.gbp.cid}` });
  }
  const ph = tx("pretty business hours");
  if (ph && facts.hours.length) {
    const got = parseHours(ph.text);
    for (const fh of facts.hours) { const g = got.find((x) => x.day === fh.day); if (g && normHoursValue(g.value) !== normHoursValue(fh.value)) { add({ category: "Business text", severity: "error", rule: "text-hours", message: `Business text “Pretty Business Hours”: ${DAY_LABEL[fh.day]} is wrong`, found: ph.text, expected: fh.value }); break; } }
  }
  const cw = tx("company website");
  if (cw && (!cw.text || /yourwebsite|your website|example\.|website\.com|domain\.com|company website|www\.?$|lorem/i.test(cw.text)))
    add({ category: "Business text", severity: "error", rule: "text-company-website", message: "Business text “Company Website” is still placeholder text", found: cw.text || "(empty)" });
  for (const t of texts.values()) if (/lorem ipsum|placeholder|your (business|company) name|\b(xxx|tbd)\b/i.test(t.text))
    add({ category: "Business text", severity: "error", rule: "text-placeholder", message: `Business text “${t.label}” is still placeholder text`, found: t.text.slice(0, 140) });

  if (snap.pages.length && !snap.pages.some((p) => p.type !== "DYNAMIC" && /privacy/i.test(`${p.path || ""} ${p.title || ""}`)))
    add({ category: "Site settings", severity: "error", rule: "privacy-page-missing", message: "The site has no Privacy Policy page", expected: "a Privacy Policy page" });

  // pages that reuse the homepage's meta title / description (common on Old Builds)
  const homePg = snap.pages.find((p) => p.type !== "DYNAMIC" && (p.path === "home" || !p.path));
  const lc = (x?: string) => String(x || "").replace(/\s+/g, " ").trim().toLowerCase();
  const homeT = lc(homePg?.seo?.title), homeD = lc(homePg?.seo?.description);
  const sameAsHome = (path: string, where: string, t?: string, d?: string) => {
    const st = !!homeT && lc(t) === homeT, sd = !!homeD && lc(d) === homeD;
    if (st || sd) add({ path, category: "SEO", severity: "error", rule: "meta-same-as-home", message: `${where} uses the homepage's meta ${st && sd ? "title and description" : st ? "title" : "description"}`, found: st ? String(t) : String(d) });
  };

  // every page's SEO — including pages nothing links to (the crawl only sees linked pages)
  for (const pg of snap.pages) {
    if (pg.type === "DYNAMIC") continue; // their SEO lives in the collection items (below)
    const path = pg.path === "home" || !pg.path ? "/" : "/" + pg.path.replace(/^\/+/, "");
    const title = String(pg.seo?.title || "").trim(), desc = String(pg.seo?.description || "").trim();
    if (!title) add({ path, category: "SEO", severity: "error", rule: "page-meta-title-blank", message: `Meta title is blank (page “${pg.title || path}”)` });
    if (!desc) add({ path, category: "SEO", severity: "error", rule: "page-meta-description-blank", message: `Meta description is blank (page “${pg.title || path}”)` });
    if (pg !== homePg) sameAsHome(path, `Page “${pg.title || path}”`, title, desc);
    if (title && !opts.crawled.has(path)) {
      if (biz && !endsWithBusiness(title, names)) add({ path, category: "SEO", severity: "error", rule: "title-no-business-suffix", message: `Meta title must end with “ | ${biz}”`, found: title });
      const os = L?.state && !isLocationPage(path) && otherState(title, L.state);
      if (os) add({ path, category: "SEO", severity: "error", rule: "title-other-location", message: `Meta title names another state (${os})`, found: title });
    }
  }

  // collection items = the service / vehicle pages (one per item)
  for (const col of snap.collections) for (const row of col.values || []) {
    if (row.status && row.status !== "ACTIVE") continue;
    const d = (row.data || {}) as Record<string, unknown>;
    const s = (k: string) => { const key = Object.keys(d).find((x) => x.toLowerCase() === k); return key ? stripHtml(String(d[key] ?? "")) : undefined; };
    const name = s("page title") || s("item") || s("header 1") || row.page_item_url || "item";
    const where = `${col.name} › ${name}`;
    const page = pagesFor(snap, col.name, row.page_item_url);
    const mt = s("meta title"), md = s("meta description");
    if (mt !== undefined && !mt) add({ path: page, category: "SEO", severity: "error", rule: "item-meta-title-blank", message: `Meta title is blank (${where})` });
    if (md !== undefined && !md) add({ path: page, category: "SEO", severity: "error", rule: "item-meta-description-blank", message: `Meta description is blank (${where})` });
    sameAsHome(page, where, mt, md);
    if (mt && biz && !endsWithBusiness(mt, names)) add({ path: page, category: "SEO", severity: "error", rule: "item-meta-title-name", message: `Meta title must end with “ | ${biz}” (${where})`, found: mt });
    for (const v of [mt, md].filter(Boolean) as string[]) { const os = L?.state && otherState(v, L.state); if (os) { add({ path: page, category: "SEO", severity: "error", rule: "item-other-location", message: `${where} names another state (${os})`, found: v, expected: `${L!.city}, ${L!.state}` }); break; } }
    for (const [k, v] of Object.entries(d)) {
      if (!/alt/i.test(k) || typeof v !== "string") continue;
      const alt = stripHtml(v);
      if (biz && !endsWithBusiness(alt, names)) add({ path: page, category: "Images", severity: "error", rule: "item-alt", message: `Alt text must end with “ | ${biz}” (${where} → ${k})`, found: alt || "(empty)" });
    }
    const all = Object.values(d).filter((v) => typeof v === "string").map((v) => stripHtml(v as string)).join(" \n ");
    for (const ex of ctx.except) if (new RegExp(`\\b${ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i").test(`${name} ${row.page_item_url || ""}`))
      add({ path: page, category: "Content", severity: "error", rule: "item-vehicle-not-serviced", message: `${where}: they don't service ${ex} (Jira)`, found: name });
    if (/lorem ipsum|placeholder text|your (business|company) name/i.test(all)) add({ path: page, category: "Content", severity: "error", rule: "item-placeholder", message: `${where} still has placeholder text` });
  }
  return out;
}
/**
 * The site labels, by the team's label rules:
 *   01, 02… template design · Lite (homepage + Image Credits + Privacy Policy only) / PRO (advanced, unlimited pages)
 *   SL (1 location) / MSO (more than 1) · PPW (privacy widget) / CPPP (custom privacy page) · HUB · Custom · SEO
 *   OB (old build) · DEL (can be deleted) · UPG (has a previous version) · LEFT (churned client)
 */
export const KNOWN_LABELS = ["Lite", "PRO", "SL", "MSO", "HUB", "PPW", "CPPP", "Custom", "SEO", "OB", "DEL", "UPG", "LEFT"];
type LabelFinding = Pick<Finding, "category" | "severity" | "rule" | "message"> & { found?: string; expected?: string };
export function labelChecks(snap: SiteSnapshot, facts: Facts, ctx: Pick<QaCtx, "projectType">, opts: { templateNumber: string; crawled: Set<string> }): LabelFinding[] {
  const out: LabelFinding[] = [];
  const labels = (snap.site.labels || []).map((l) => String(l.name || "").trim()).filter(Boolean);
  const T = opts.templateNumber ? opts.templateNumber.padStart(2, "0") : "";
  if (!labels.length) {
    out.push({ category: "Site settings", severity: "error", rule: "site-labels-blank", message: "Site labels are blank", expected: T ? `the template number (${T}) and the site's other labels` : "the site's labels" });
    return out;
  }
  const all = labels.join(", ");
  const has = (n: string) => labels.some((l) => l.toLowerCase() === n.toLowerCase() || (n === "OB" && /^old builds?$/i.test(l)));
  const A = (f: Omit<LabelFinding, "category">) => out.push({ category: "Site settings", found: all, ...f });

  // template number
  const nums = labels.filter((l) => /^\d{1,3}$/.test(l));
  if (nums.length > 1) A({ severity: "error", rule: "site-label-template", message: `More than one template-number label (${nums.join(", ")})`, expected: T || "one template number" });
  if (T) {
    if (!nums.length) A({ severity: "error", rule: "site-label-template", message: "No template-number label", expected: T });
    else if (!nums.some((n) => Number(n) === Number(T))) A({ severity: "error", rule: "site-label-template", message: `Site label says template ${nums.join(", ")} — Jira's template is #${Number(T)}`, expected: T });
  } else if (!nums.length) A({ severity: "warning", rule: "site-label-template", message: "No template-number label (01, 02…)" });

  // package: Lite or PRO (Basic = Lite, Advanced = PRO)
  const lite = has("Lite"), pro = has("PRO");
  const wantPkg = ctx.projectType === "basic" ? "Lite" : ctx.projectType === "advanced" ? "PRO" : "";
  if (lite && pro) A({ severity: "error", rule: "site-label-package", message: "Both Lite and PRO labels — a site has one package", expected: wantPkg || "Lite or PRO" });
  else if (!lite && !pro) A({ severity: wantPkg ? "error" : "warning", rule: "site-label-package", message: "No package label (Lite or PRO)", expected: wantPkg || "Lite or PRO" });
  else if (wantPkg && !has(wantPkg)) A({ severity: "error", rule: "site-label-package", message: `Labelled ${lite ? "Lite" : "PRO"} but the Jira project is ${ctx.projectType === "basic" ? "Basic" : "Advanced"}`, expected: wantPkg });
  // Lite = only the homepage, Image Credits and Privacy Policy — no other pages, no blog
  if (lite && !pro) {
    const extra = snap.pages.filter((p) => {
      const k = `${p.path || ""} ${p.title || ""}`.toLowerCase();
      if (p.type === "DYNAMIC") return true;
      return !(p.path === "home" || !p.path || /\bcredit/.test(k) || /privacy/.test(k));
    });
    if (extra.length) A({ severity: "error", rule: "lite-extra-pages", message: `Lite site has ${extra.length} page(s) besides the homepage, Image Credits and Privacy Policy`, found: extra.map((p) => `/${(p.path || "").replace(/^\/+/, "").replace("~page-item~", "…")}${p.type === "DYNAMIC" ? ` (${p.collection_name || "collection"} pages)` : ""}`).slice(0, 12).join(", "), expected: "Homepage, Image Credits and Privacy Policy only" });
  }

  // locations: SL (1) or MSO (more than 1)
  const sl = has("SL"), mso = has("MSO");
  const extraLocs = (snap.content.additional_locations || []).length;
  const nLocs = Math.max(facts.locations.length, snap.content.location_data ? 1 + extraLocs : extraLocs);
  const wantLoc = ctx.projectType === "mso" || nLocs > 1 ? "MSO" : nLocs === 1 ? "SL" : "";
  const why = wantLoc === "MSO" ? (nLocs > 1 ? `${nLocs} locations` : "the Jira project is MSO") : "1 location";
  if (sl && mso) A({ severity: "error", rule: "site-label-location", message: "Both SL and MSO labels", expected: wantLoc ? `${wantLoc} (${why})` : "SL or MSO" });
  else if (!sl && !mso) A({ severity: wantLoc ? "error" : "warning", rule: "site-label-location", message: "No location label (SL or MSO)", expected: wantLoc ? `${wantLoc} (${why})` : "SL or MSO" });
  else if (wantLoc && !has(wantLoc)) A({ severity: "error", rule: "site-label-location", message: `Labelled ${sl ? "SL" : "MSO"} — expected ${wantLoc} (${why})`, expected: wantLoc });

  // privacy policy: PPW (widget) or CPPP (custom page)
  const ppw = has("PPW"), cppp = has("CPPP");
  if (ppw && cppp) A({ severity: "error", rule: "site-label-privacy", message: "Both PPW and CPPP labels — PPW is the widget, CPPP is a custom page (or the page has more content)", expected: "PPW or CPPP" });
  else if (!ppw && !cppp) A({ severity: "error", rule: "site-label-privacy", message: "No privacy-policy label (PPW or CPPP)", expected: "PPW or CPPP" });

  // status labels
  if (has("DEL")) A({ severity: "warning", rule: "site-label-del", message: "This site is labelled DEL (can be deleted: test / mistake / replaced) — make sure it's the right site to audit" });
  if (has("LEFT")) A({ severity: "warning", rule: "site-label-left", message: "This site is labelled LEFT (churned client — no longer active)" });
  if (has("UPG")) A({ severity: "info", rule: "site-label-upg", message: "This site is labelled UPG (it has a previous version) — check nothing was left over from the old build" });
  if (has("OB")) A({ severity: "info", rule: "site-label-ob", message: "Old Build (OB): check every resolution — phone number everywhere (unlink a phone that's also linked), service pages, icons and cards per resolution, hero sections per resolution, theme colors / fonts" });

  // labels not in the list
  for (const l of labels) if (!/^\d{1,3}$/.test(l) && !KNOWN_LABELS.some((k) => k.toLowerCase() === l.toLowerCase()) && !/^old builds?$/i.test(l))
    out.push({ category: "Site settings", severity: "warning", rule: "site-label-unknown", message: `Unknown site label “${l}”`, found: l, expected: `numbers (01, 02…) or ${KNOWN_LABELS.join(", ")}` });
  return out;
}

/** "/services/oil-change" for a collection item (from the dynamic page that shows the collection). */
function pagesFor(snap: SiteSnapshot, collection: string, item?: string) {
  const pg = snap.pages.find((p) => p.type === "DYNAMIC" && p.collection_name === collection);
  if (!pg || !item) return SETTINGS_PATH;
  return "/" + pg.path.replace("~page-item~", item).replace(/^\/+/, "");
}
