/**
 * The team's QA guidelines for meta titles, meta descriptions and headings — shared by the page checks (what the
 * crawler sees) and the site-settings checks (pages / service and vehicle items nothing links to).
 *
 *   Meta title:       main keyword + location, under 60 characters, not the same as the page title / H1, no duplicates
 *   Meta description: keyword + location, 150–160 characters, a call to action (usually at the end)
 *   H1:               one per page (a line break is a <br>, not a second H1), [main keyword] + [location], first heading,
 *                     headings in order (H1 → H2 → H3, no skipped level)
 *   Homepage H1:      the main keyword ("Auto Repair Shop" or the GBP primary category) + the shop's city
 */
import type { Facts } from "./facts";
import { REGION_NAMES } from "./collect";

export const TITLE_MAX = 60;
export const DESC_MIN = 150;
export const DESC_MAX = 160;

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const norm = (x: string) => x.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();

/** The text names the shop's location: its city, a city it serves, or its state (name or ", NE"). */
export function hasLocation(text: string, facts: Facts) {
  const places = [...facts.locations.flatMap((l) => [l.city]), ...facts.citiesServed].map((c) => String(c || "").replace(/,.*$/, "").trim()).filter((c) => c.length > 2);
  if (places.some((c) => new RegExp(`\\b${esc(c).replace(/\s+/g, "\\s+")}\\b`, "i").test(text))) return true;
  for (const l of facts.locations) {
    const st = String(l.state || "").toUpperCase();
    if (st.length === 2 && new RegExp(`(,\\s*|\\b)${st}\\b`).test(text)) return true;
    const name = REGION_NAMES[st];
    if (name && new RegExp(`\\b${esc(name)}\\b`, "i").test(text)) return true;
  }
  return false;
}

/** "Call us today", "Visit us", "Schedule an appointment"… */
export const CTA = /\b(call|visit|schedule|book|contact|stop by|stop in|come (in|by|see)|drop by|request|get (a|an|your) (free )?(quote|estimate)|make an appointment|reach out|bring (it|your)|give us a call|let us)\b/i;

/** Words that make a homepage H1's main keyword when the GBP category isn't known. */
export const AUTO_KEYWORD = /\b(auto(motive)?|car|truck|vehicle|tire|brake|transmission|diesel|collision|body shop|mechanic|muffler|exhaust|alignment|oil change|smog|repair|service)\b/i;
/** A GBP category that's about cars (else the client should change it). */
export const AUTO_CATEGORY = /\b(auto|car|truck|vehicle|tire|brake|transmission|diesel|collision|body|mechanic|muffler|exhaust|alignment|oil|smog|repair|garage|motor|automotive|service station|inspection|glass|detail|tint|wheel)\b/i;

/** The main words of a GBP category ("Auto repair shop" → ["auto", "repair"]). */
export const categoryWords = (c: string) => norm(c).split(" ").filter((w) => w.length > 2 && !/^(and|the|shop|store|service|center|centre)$/.test(w));

export type Issue = { rule: string; severity: "error" | "warning" | "info"; message: string; expected?: string };

/** Meta title rules that don't need the page itself (length; same as the page title / H1). */
export function titleIssues(title: string, opts: { pageTitle?: string; h1?: string }): Issue[] {
  const out: Issue[] = [];
  const t = title.trim();
  if (!t) return out;
  if (t.length > TITLE_MAX) out.push({ rule: "title-long", severity: "warning", message: `Meta title is ${t.length} characters — keep it under ${TITLE_MAX}`, expected: `under ${TITLE_MAX} characters` });
  if (opts.pageTitle && norm(opts.pageTitle) && norm(opts.pageTitle) === norm(t)) out.push({ rule: "title-same-as-page-title", severity: "error", message: `Meta title is the same as the page title (“${opts.pageTitle}”) — write a real meta title`, expected: "main keyword + location (+ benefit / CTA) | Business Name" });
  if (opts.h1 && norm(opts.h1) && norm(opts.h1) === norm(t)) out.push({ rule: "title-same-as-h1", severity: "error", message: "Meta title is the same as the page's H1 — they must be different", expected: "a meta title that isn't the H1" });
  return out;
}

/** Meta description rules: 150–160 characters, the location, a call to action. */
/** Legal / system pages (privacy policy, image credits…): only the length rule applies to their description. */
const SYSTEM_PAGE = /(privacy|terms|accessibility|cookie|disclaimer|image-?credits|sitemap|legal)/i;
export function descIssues(desc: string, facts: Facts, opts: { locationPage?: boolean; path?: string }): Issue[] {
  const out: Issue[] = [];
  const d = desc.trim();
  if (!d) return out;
  if (d.length < DESC_MIN) out.push({ rule: "meta-short", severity: "error", message: `Meta description is ${d.length} characters — keep it ${DESC_MIN}–${DESC_MAX}`, expected: `${DESC_MIN}–${DESC_MAX} characters` });
  else if (d.length > DESC_MAX) out.push({ rule: "meta-long", severity: "error", message: `Meta description is ${d.length} characters — keep it ${DESC_MIN}–${DESC_MAX} (longer is cut off in Google)`, expected: `${DESC_MIN}–${DESC_MAX} characters` });
  if (opts.path && SYSTEM_PAGE.test(opts.path)) return out;
  const L = facts.locations[0];
  if (L?.city && !opts.locationPage && !hasLocation(d, facts)) out.push({ rule: "meta-no-location", severity: "error", message: "Meta description has no location", expected: `the keyword + ${L.city}, ${String(L.state || "").toUpperCase()}` });
  if (!CTA.test(d)) out.push({ rule: "meta-no-cta", severity: "warning", message: "Meta description has no call to action", expected: "e.g. “Call us today”, “Visit us today” or “Schedule an online appointment now” at the end" });
  return out;
}
