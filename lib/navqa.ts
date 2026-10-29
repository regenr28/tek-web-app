/**
 * The site's menu, checked from its settings for each device (desktop, tablet, mobile):
 *
 *   • the template's own menu items that aren't one of the selectable pages / sections must be built — even when not
 *     requested (e.g. Single Location Template 21–31 have an About Us page; HP Only templates have About, FAQs,
 *     Gallery… sections)
 *   • every requested page / section must be in the menu, on every device
 *   • a selectable page / section that wasn't requested must not be in the menu
 *   • Basic (one-page) sites: requested sections are anchors on the homepage (/#Coupons), and the anchor must exist
 *
 * Names don't have to be the same: "Specials" = #Coupons, "About Us" = /home#about. What the code can't match, the AI
 * matches — only against items that are really in the menu.
 */
import type { Finding, Severity } from "./rules";
import { GLOBAL_PATH } from "./rules";
import { sectionKey } from "./qa";

export type NavNode = { title?: string; url?: string; type?: string; hidden?: string[]; sub_navigation?: NavNode[] };
export const DEVICES = ["DESKTOP", "TABLET", "MOBILE"] as const;
type Dev = (typeof DEVICES)[number];
export type MenuItem = { title: string; url: string; hidden: Dev[]; depth: number; parent: string };

/** The selectable pages / sections (Jira form). Everything else in a template's menu is part of the template. */
export const SELECTABLE = ["services", "vehicles", "contact", "coupons", "reviews", "careers", "financing", "warranty"];

/** Menu items (folders and the hidden "~page-item~" templates left out); an item hidden in its folder is hidden too. */
export function flattenNav(nodes: NavNode[] | undefined, depth = 0, parentHidden: Dev[] = [], parent = ""): MenuItem[] {
  const out: MenuItem[] = [];
  for (const n of nodes || []) {
    if (n.type === "DYNAMIC_PAGE_TEMPLATE") continue;
    const hidden = [...new Set([...parentHidden, ...((n.hidden || []).map((h) => h.toUpperCase()).filter((h) => (DEVICES as readonly string[]).includes(h)) as Dev[])])];
    const title = String(n.title || "").trim(), url = n.url && n.url !== "undefined" ? String(n.url) : "";
    if (title && url) out.push({ title, url, hidden, depth, parent });
    out.push(...flattenNav(n.sub_navigation, depth + 1, hidden, title || parent));
  }
  return out;
}
const visibleSomewhere = (m: MenuItem) => m.hidden.length < DEVICES.length;
/** "/#OurPhilosophy" → "our philosophy", "/vehicles-we-repair" → "vehicles we repair" */
const urlWords = (u: string) => decodeURIComponent(u).replace(/^\/+/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_/#?=&.]+/g, " ").toLowerCase().trim();
export const keyOf = (m: { title: string; url: string }) => sectionKey(m.title) || sectionKey(urlWords(m.url)) || (/\b(locations?|find a shop|city ?\d)\b/i.test(`${m.title} ${urlWords(m.url)}`) ? "locations" : "");
const squash = (x: string) => x.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const anchorOf = (u: string) => (u.match(/#(.+)$/)?.[1] || "").toLowerCase();
const isHomeOrCredits = (m: MenuItem) => m.url === "/" || /^\/?(home)?$/i.test(m.url) || /image-?credits/i.test(m.url) || /^home$/i.test(m.title) || /scroll|back ?to ?top/i.test(m.title);

/** Two menu items are the same page / section: same kind, same name, or the same anchor / page address. */
export function sameItem(a: { title: string; url: string }, b: { title: string; url: string }) {
  const ka = keyOf(a), kb = keyOf(b);
  if (ka && kb) return ka === kb;
  if (squash(a.title) && squash(a.title) === squash(b.title)) return true;
  const aa = anchorOf(a.url), ab = anchorOf(b.url);
  if (aa && ab && squash(aa) === squash(ab)) return true;
  const pa = squash(a.url.replace(/#.*$/, "")), pb = squash(b.url.replace(/#.*$/, ""));
  return !!pa && pa === pb && !aa && !ab;
}

/** The template's own menu items (the ones that aren't selectable) — they're built on every site from that template. */
export function templateDefaults(templateNav: NavNode[]): MenuItem[] {
  const items = flattenNav(templateNav).filter((m) => visibleSomewhere(m) && !isHomeOrCredits(m));
  const out: MenuItem[] = [];
  for (const m of items) {
    const k = keyOf(m);
    if (SELECTABLE.includes(k)) continue;
    // MSO templates: "Locations" with placeholder location pages (Location 1, City1…) → one "Locations" item
    if (k === "locations") { if (!out.some((x) => keyOf(x) === "locations")) out.push({ ...m, title: m.parent && keyOf({ title: m.parent, url: "" }) === "locations" ? m.parent : /\d/.test(m.title) ? "Locations" : m.title }); continue; }
    if (!out.some((x) => sameItem(x, m))) out.push(m);
  }
  return out;
}

export type NavPlan = {
  site: MenuItem[];
  /** template items / requests the code couldn't find in the site's menu — the AI looks at these */
  unmatched: { what: "template" | "request"; label: string; item?: MenuItem }[];
  findings: Finding[];
};

const devList = (h: Dev[]) => h.map((d) => d.toLowerCase()).join(" and ");

/**
 * Checks the site's menu against the template's defaults and the requests. Items that can't be matched by the code
 * are returned in `unmatched` (call `navMissing` with the AI's answer, or without it).
 */
export function navQa(opts: { siteNav: NavNode[]; templateNav?: NavNode[] | null; templateName?: string; requested: string[]; projectType: string | null; homeIds?: string[]; homeUrl: string }): NavPlan {
  const out: Finding[] = [];
  const base = { path: GLOBAL_PATH, url: opts.homeUrl, selector: "nav", source: "rule" as const, global: true };
  const add = (f: Pick<Finding, "category" | "severity" | "rule" | "message"> & { found?: string; expected?: string }) => out.push({ ...base, ...f });
  const site = flattenNav(opts.siteNav).filter((m) => !isHomeOrCredits(m));
  const shown = site.filter(visibleSomewhere);
  const basic = opts.projectType === "basic";
  const unmatched: NavPlan["unmatched"] = [];

  const checkDevices = (m: MenuItem, why: string) => {
    if (m.hidden.length && visibleSomewhere(m))
      add({ category: "Navigation", severity: "error", rule: "nav-hidden-device", message: `“${m.title}” is hidden in the ${devList(m.hidden)} menu — ${why}, so it must show on desktop, tablet and mobile`, found: `${m.title} → ${m.url} (hidden on ${devList(m.hidden)})`, expected: "shown on desktop, tablet and mobile" });
  };

  // 1) the template's own items
  const defaults = opts.templateNav ? templateDefaults(opts.templateNav) : [];
  for (const d of defaults) {
    const hit = keyOf(d) === "locations" ? site.find((m) => keyOf(m) === "locations") : site.find((m) => sameItem(m, d));
    if (!hit) { unmatched.push({ what: "template", label: d.title, item: d }); continue; }
    if (!visibleSomewhere(hit)) add({ category: "Navigation", severity: /blog/i.test(d.title) ? "warning" : "error", rule: "nav-template-hidden", message: `“${hit.title}” is part of ${opts.templateName || "the template"} but is hidden in the menu on every device`, found: `${hit.title} → ${hit.url}`, expected: `“${d.title}” in the menu (desktop, tablet, mobile)` });
    else checkDevices(hit, `it's part of ${opts.templateName || "the template"}`);
  }

  // 2) every request is in the menu, on every device (Basic: as a section anchor that exists)
  const reqKeys = new Set<string>();
  for (const raw of opts.requested) {
    const req = raw.replace(/^others?\s*[:\-–]\s*/i, "").trim();
    if (!req || /^home( ?page)?$/i.test(req)) continue;
    const k = sectionKey(req);
    if (k) reqKeys.add(k);
    if (k === "contact" && basic) continue; // Contact Us isn't part of the Basic package
    const hit = site.find((m) => sameItem(m, { title: req, url: "" }) || (k && keyOf(m) === k));
    if (!hit) { unmatched.push({ what: "request", label: req }); continue; }
    if (!visibleSomewhere(hit)) { add({ category: "Navigation", severity: "error", rule: "nav-request-hidden", message: `Requested ${basic ? "section" : "page"} “${req}” is in the menu but hidden on every device`, found: `${hit.title} → ${hit.url}`, expected: `“${req}” shown on desktop, tablet and mobile` }); continue; }
    checkDevices(hit, "it was requested");
    if (basic && !anchorOf(hit.url)) add({ category: "Navigation", severity: "error", rule: "nav-basic-not-anchor", message: `“${hit.title}” opens a separate page (${hit.url}) — on a one-page (Basic) site it must jump to its section on the homepage`, found: `${hit.title} → ${hit.url}`, expected: `/#${hit.title.replace(/[^A-Za-z0-9]+/g, "")}` });
  }

  // 3) selectable pages / sections that weren't requested
  if (opts.requested.length) for (const m of shown) {
    const k = keyOf(m);
    if (!SELECTABLE.includes(k) || reqKeys.has(k)) continue;
    if (defaults.some((d) => sameItem(d, m))) continue;
    const sev: Severity = ["services", "contact"].includes(k) ? "warning" : "error";
    const where = m.hidden.length ? ` (${DEVICES.filter((d) => !m.hidden.includes(d)).map((d) => d.toLowerCase()).join(", ")})` : "";
    add({ category: "Navigation", severity: sev, rule: "nav-not-requested", message: `The menu has “${m.title}”${where}, but it wasn't requested in Jira`, found: `${m.title} → ${m.url}`, expected: `Requested: ${opts.requested.join(", ")}` });
  }

  // 4) Basic: every menu anchor must exist on the homepage
  if (basic && opts.homeIds?.length) {
    const ids = new Set(opts.homeIds.map((x) => x.toLowerCase()));
    for (const m of shown) {
      const a = anchorOf(m.url);
      if (a && /^\/?(home)?#/i.test(m.url) && !ids.has(a)) add({ category: "Navigation", severity: "error", rule: "nav-anchor-missing", message: `“${m.title}” jumps to #${a}, but the homepage has no such section`, found: `${m.title} → ${m.url}` });
    }
  }
  return { site, unmatched, findings: out };
}

/** Findings for what's still not in the menu after the AI looked (`covered` = labels the AI matched to a real item). */
export function navMissing(plan: NavPlan, covered: Map<string, MenuItem>, opts: { templateName?: string; projectType: string | null; homeUrl: string }): Finding[] {
  const out: Finding[] = [];
  const basic = opts.projectType === "basic";
  const menu = plan.site.filter(visibleSomewhere).map((m) => m.title).slice(0, 25).join(" · ");
  for (const u of plan.unmatched) {
    const hit = covered.get(u.label.toLowerCase());
    const base = { path: GLOBAL_PATH, url: opts.homeUrl, selector: "nav", source: "rule" as const, global: true, category: "Navigation" };
    if (hit) {
      if (!visibleSomewhere(hit)) out.push({ ...base, severity: "error", rule: u.what === "template" ? "nav-template-hidden" : "nav-request-hidden", message: `“${hit.title}” (${u.label}) is in the menu but hidden on every device`, found: `${hit.title} → ${hit.url}`, expected: `shown on desktop, tablet and mobile` });
      else if (hit.hidden.length) out.push({ ...base, severity: "error", rule: "nav-hidden-device", message: `“${hit.title}” (${u.label}) is hidden in the ${devList(hit.hidden)} menu — it must show on desktop, tablet and mobile`, found: `${hit.title} → ${hit.url} (hidden on ${devList(hit.hidden)})`, expected: "shown on desktop, tablet and mobile" });
      continue;
    }
    if (u.what === "template") out.push({ ...base, severity: /blog/i.test(u.label) ? "warning" : "error", rule: "nav-template-missing", message: `“${u.label}” is part of ${opts.templateName || "the template"}'s menu but isn't on this site — template pages / sections are built even when not requested`, found: `The menu has: ${menu || "(nothing)"}`, expected: `${u.label}${u.item?.url ? ` (${u.item.url})` : ""}` });
    else out.push({ ...base, severity: "error", rule: "nav-missing-request", message: `Requested ${basic ? "section" : "page"} “${u.label}” isn't in the menu`, found: `Not in the menu: “${u.label}” — the menu has: ${menu || "(nothing)"}`, expected: u.label });
  }
  return out;
}

/** The AI question: which real menu item is each unmatched template item / request (other words are fine). */
export function navAiPrompt(plan: NavPlan, basic: boolean) {
  return `MENU ITEMS OF THE SITE (text → link):
${plan.site.slice(0, 80).map((m) => `- ${m.title} → ${m.url}`).join("\n")}

NOT MATCHED YET (${basic ? "sections of a one-page site — menu items jump to them with #anchors" : "pages"}):
${plan.unmatched.map((u) => `- ${u.label}${u.item?.url ? ` (the template links it to ${u.item.url})` : ""}`).join("\n")}

For each item, is there a menu item above that leads to the same page / section? Other words are fine ("Specials" = "#Coupons", "About Us" = "/home#about", "Get Directions" = "Directions", "Why Choose Us" = "Benefits"). Use the menu item's exact text, or "" if none.
Return ONLY JSON: {"matches":[{"item":"","menuItem":""}]}`;
}
