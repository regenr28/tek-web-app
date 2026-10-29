import type { PageData, Block } from "./crawl";
import {
  type Facts, type Day, DAYS, DAY_LABEL, PHONE_RE, EMAIL_RE, ZIP_RE, STREET_RE,
  digits, formatPhone, normStreet, parseHours, normHoursValue,
} from "./facts";
import { REGION_NAMES } from "./collect";

export type Severity = "error" | "warning" | "info";
export type Finding = {
  path: string; url: string; selector: string; category: string; severity: Severity;
  rule: string; message: string; expected?: string; found?: string; source: "rule" | "ai"; global: boolean;
};

export const GLOBAL_PATH = "Global (header / footer / nav)";

const PLACEHOLDERS: RegExp[] = [
  /lorem ipsum/i, /dolor sit amet/i, /\byour (?:business|company) name\b/i, /\bcompany name\b/i,
  /\bbusiness name here\b/i, /\b(?:add|insert|enter) (?:your|text|content|title|heading)\b/i,
  /click (?:here )?to edit/i, /\b123 main st/i, /\b555[\s.-]?555[\s.-]?\d{4}\b|\(555\)\s?555|[\s(]555[\s.-]01\d\d\b|\b123[\s.-]?456[\s.-]?7890\b/, /\bexample\.com\b/i,
  /\bxx+\b/i, /\bTBD\b/, /\bTBA\b/, /\[(?:city|state|name|phone|business|company)[^\]]*\]/i,
  /\{\{[^}]+\}\}/, /\bheading goes here\b/i, /\bsample text\b/i, /\bplaceholder\b/i,
  /\bthis is a paragraph\b/i, /\byour (?:city|town|phone|email)\b/i,
];

// automotive + common misspellings → correction
const MISSPELLINGS: Record<string, string> = {
  transmision: "transmission", tranmission: "transmission", transmisson: "transmission",
  suspention: "suspension", suspenion: "suspension", alignmnet: "alignment", allignment: "alignment",
  maintainance: "maintenance", maintenence: "maintenance", maintanence: "maintenance", maintenace: "maintenance",
  alternater: "alternator", vehical: "vehicle", vehicule: "vehicle", vechicle: "vehicle", vehcile: "vehicle",
  diagnositc: "diagnostic", diagnostcs: "diagnostics", diagnotics: "diagnostics", diagnostices: "diagnostics",
  exaust: "exhaust", exhuast: "exhaust", muffeler: "muffler", radiater: "radiator", thermastat: "thermostat",
  catalitic: "catalytic", cataylitic: "catalytic", breaks: "brakes (if it refers to car brakes)",
  tyres: "tires (US spelling)", tyre: "tire (US spelling)", accomodate: "accommodate", reciept: "receipt",
  recieve: "receive", guarentee: "guarantee", garantee: "guarantee", warrenty: "warranty", warrantee: "warranty",
  proffesional: "professional", profesional: "professional", reliabe: "reliable", relaible: "reliable",
  exellent: "excellent", excelent: "excellent", sevice: "service", servcie: "service", serivce: "service",
  appointmnet: "appointment", apointment: "appointment", untill: "until", occured: "occurred",
  seperate: "separate", definately: "definitely", neccessary: "necessary", recomend: "recommend",
  certifed: "certified", techician: "technician", technican: "technician", mechanicle: "mechanical",
  dealerhsip: "dealership", inspecton: "inspection", emmissions: "emissions", emisions: "emissions",
  battrey: "battery", batery: "battery", engin: "engine", steerring: "steering", clucth: "clutch",
  headligth: "headlight", oppurtunity: "opportunity", buisness: "business", bussiness: "business",
};

const HYPHENATE: [RegExp, string][] = [
  [/\bfamily owned\b/i, "family-owned"], [/\bfull service\b(?= (?:auto|shop|repair|garage|car|facility))/i, "full-service"],
  [/\bstate of the art\b/i, "state-of-the-art"], [/\btop notch\b/i, "top-notch"],
  [/\bhigh quality\b(?= \w+)/i, "high-quality"], [/\blocally owned\b/i, "locally owned (no hyphen after -ly — OK)"],
  [/\bASE certified\b(?= (?:tech|mechanic|technician))/i, "ASE-certified"], [/\bfactory trained\b(?= \w)/i, "factory-trained"],
  [/\bone stop shop\b/i, "one-stop shop"], [/\bup to date\b(?= \w)/i, "up-to-date"], [/\bwell known\b(?= \w)/i, "well-known"],
  [/\bin house\b(?= \w)/i, "in-house"], [/\blong lasting\b/i, "long-lasting"], [/\bhigh performance\b(?= \w)/i, "high-performance"],
  [/\bfour wheel\b/i, "four-wheel"], [/\ball wheel\b/i, "all-wheel"], [/\bpre purchase\b/i, "pre-purchase"],
  [/\bcheck engine light\b/i, "check-engine light (optional)"], [/\bveteran owned\b/i, "veteran-owned"],
  [/\bwoman owned\b|\bwomen owned\b/i, "woman-owned / women-owned"]
];

const SOCIAL_HOSTS: Record<string, RegExp> = {
  facebook: /(^|\.)facebook\.com$|(^|\.)fb\.com$/i, instagram: /(^|\.)instagram\.com$/i, yelp: /(^|\.)yelp\.com$/i,
  twitter: /(^|\.)(twitter|x)\.com$/i, x: /(^|\.)(twitter|x)\.com$/i, linkedin: /(^|\.)linkedin\.com$/i, youtube: /(^|\.)youtube\.com$|youtu\.be$/i,
  tiktok: /(^|\.)tiktok\.com$/i, google: /(^|\.)(google\.[a-z.]+|g\.page|goo\.gl|maps\.app\.goo\.gl)$/i,
};

const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^(www|m|web|business)\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
/**
 * Same social profile? Facebook writes one page several ways — /p/Name-123…, /people/Name/123…, /pages/Name/123…,
 * /profile.php?id=123… — so pages with the same numeric ID are the same page. Otherwise compare the handle.
 */
export function sameSocial(a: string, b: string) {
  if (normUrl(a) === normUrl(b)) return true;
  const fbId = (u: string) => u.match(/[?&]id=(\d{6,})/)?.[1] || u.replace(/[?#].*$/, "").replace(/\/+$/, "").match(/[-/](\d{8,})$/)?.[1] || "";
  const ia = fbId(a), ib = fbId(b);
  if (ia && ia === ib) return true;
  const handle = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^(www|m|web|business)\./, "")}/${x.pathname.split("/").filter(Boolean).filter((p) => !/^(p|pages|people)$/i.test(p))[0] || ""}`.toLowerCase(); } catch { return u; } };
  return handle(a) === handle(b) && !handle(a).endsWith("/");
}
const normName = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
/** "The Auto Connection" = "Auto Connection", "Joe's Auto LLC" = "Joe's Auto" (a leading "The" / legal ending doesn't matter). */
const bizKey = (s: string) => normName(s.replace(/&/g, " and ")).replace(/^the /, "").replace(/\b(l l c|llc|inc|incorporated|corp|corporation|co|ltd|pllc|lp|llp)$/g, "").replace(/'/g, "").trim();
export const sameBusiness = (a: string, b: string) => !!bizKey(a) && bizKey(a) === bizKey(b);
/** The text after the last "|" — "Brake Repair in Lincoln, NE | The Auto Connection" → "The Auto Connection". */
const lastPart = (s: string) => (s.includes("|") ? s.slice(s.lastIndexOf("|") + 1).trim() : "");
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A page about one service area / location ("/location/auto-repair-near-waverly-ne", "/areas-we-serve/hickman"). */
export function isLocationPage(path: string) {
  return /(^|\/)(locations?|areas?-(we-)?serve[ds]?|service-areas?|cities|communities)(\/|$)|(^|[\/-])(near|in|serving)-[a-z]+(?:-[a-z]+)*-[a-z]{2}$/i.test(path);
}

function lev(a: string, b: string) {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function auditPage(p: PageData, path: string, facts: Facts): Finding[] {
  const out: Finding[] = [];
  const add = (b: { selector: string; global: boolean }, f: Omit<Finding, "path" | "url" | "selector" | "source" | "global">) =>
    out.push({ ...f, path: b.global ? GLOBAL_PATH : path, url: p.finalUrl, selector: b.selector, source: "rule", global: b.global });
  const pageLevel = { selector: "head", global: false };

  const factPhones = new Set(facts.phones.map(digits).filter((d) => d.length === 10));
  const factEmails = new Set(facts.emails.map((e) => e.toLowerCase()));
  const factZips = new Set(facts.locations.map((l) => `${l.state.toUpperCase()} ${l.zip}`));
  const factStreets = facts.locations.map((l) => normStreet(l.street)).filter(Boolean);
  const factHours = new Map(facts.hours.map((h) => [h.day, normHoursValue(h.value)]));
  const names = [facts.businessName, ...facts.altNames].filter(Boolean).map(normName);
  const factsBlob = normName(JSON.stringify(facts));
  const isFact = (s: string) => s.length > 3 && factsBlob.includes(normName(s));

  if (p.status >= 400) {
    if (p.linkedFrom) return out; // reported as a broken link on the page that links here
    add(pageLevel, { category: "Links", severity: "error", rule: "page-status", message: `Page returned HTTP ${p.status}${p.linkedFrom ? ` — linked from ${p.linkedFrom}` : ""}` });
    return out;
  }

  // ---------- text blocks ----------
  for (const b of p.blocks) {
    const t = b.text;

    if (factPhones.size) {
      for (const m of t.matchAll(PHONE_RE)) {
        const d = digits(m[0]);
        if (!factPhones.has(d))
          add(b, { category: "Contact info", severity: "error", rule: "phone-mismatch", message: "Phone number doesn't match Jira facts", found: m[0], expected: facts.phones.join(", ") });
      }
    }
    if (factEmails.size) {
      for (const m of t.matchAll(EMAIL_RE)) {
        if (!factEmails.has(m[0].toLowerCase()))
          add(b, { category: "Contact info", severity: "error", rule: "email-mismatch", message: "Email doesn't match Jira facts", found: m[0], expected: facts.emails.join(", ") });
      }
    }
    if (factZips.size) {
      for (const m of t.matchAll(ZIP_RE)) {
        if (!/^[A-Z]{2}$/.test(m[1]) || !STATE_CODES.has(m[1])) continue;
        const key = `${m[1]} ${m[2]}`;
        if (!factZips.has(key))
          add(b, { category: "Contact info", severity: "error", rule: "zip-mismatch", message: "State / ZIP doesn't match Jira address", found: key, expected: [...factZips].join(", ") });
      }
    }
    if (factStreets.length) {
      for (const m of t.matchAll(STREET_RE)) {
        const n = normStreet(m[0]);
        if (!factStreets.some((s) => s.startsWith(n) || n.startsWith(s) || s.includes(n)))
          add(b, { category: "Contact info", severity: "warning", rule: "street-mismatch", message: "Street address not found in Jira facts", found: m[0], expected: facts.locations.map((l) => l.street).join(" | ") });
      }
    }

    // Hours
    if (/\b(mon|tue|wed|thu|fri|sat|sun)/i.test(t) && /\d\s*(a\.?m|p\.?m)|closed/i.test(t)) {
      const ph = parseHours(t);
      for (const h of ph) {
        const exp = factHours.get(h.day);
        if (exp && normHoursValue(h.value) !== exp)
          add(b, { category: "Hours", severity: "error", rule: "hours-mismatch", message: `${DAY_LABEL[h.day]} hours don't match Jira`, found: h.value, expected: facts.hours.find((x) => x.day === h.day)?.value });
      }
    }

    // Business name misspelling (fuzzy)
    if (names.length) checkNameVariants(b, names, facts.businessName, add);

    if (b.quote) continue; // customer review text: only contact-info checks above apply

    for (const re of PLACEHOLDERS) {
      const m = t.match(re);
      if (m && !isFact(m[0])) { add(b, { category: "Content", severity: "error", rule: "placeholder", message: "Template / placeholder text left on page", found: excerpt(t, m.index ?? 0) }); break; }
    }

    for (const m of t.matchAll(/\b([A-Za-z]+)\b/g)) {
      const w = m[1].toLowerCase();
      const fix = Object.prototype.hasOwnProperty.call(MISSPELLINGS, w) ? MISSPELLINGS[w] : undefined;
      if (!fix) continue;
      if (w === "breaks" && !/\b(car|vehicle|brake|pad|rotor|repair|service|stop)/i.test(t)) continue;
      add(b, { category: "Spelling", severity: w === "breaks" || w.startsWith("tyre") ? "warning" : "error", rule: "misspelling", message: `Possible misspelling: "${m[1]}"`, found: excerpt(t, m.index ?? 0), expected: fix });
    }
    const dbl = t.match(/\b(\w{2,})\s+\1\b/i);
    if (dbl && !/^(that|had|is|bye|no|so|very|go)$/i.test(dbl[1]))
      add(b, { category: "Spelling", severity: "error", rule: "double-word", message: `Repeated word "${dbl[1]} ${dbl[1]}"`, found: excerpt(t, dbl.index ?? 0) });
    const nsp = t.match(/[a-z]{2}[.!?,][A-Z][a-z]{2,}/);
    if (nsp && !/\.(com|net|org|co)/i.test(nsp[0]))
      add(b, { category: "Spelling", severity: "info", rule: "missing-space", message: "Missing space after punctuation", found: excerpt(t, nsp.index ?? 0) });
    for (const [re, fix] of HYPHENATE) {
      const m = t.match(re);
      if (m && fix && !fix.includes("OK"))
        add(b, { category: "Style", severity: "info", rule: "compound-adjective", message: `Compound adjective may need a hyphen: "${m[0]}"`, found: excerpt(t, m.index ?? 0), expected: fix });
    }
    const cy = t.match(/(?:©|&copy;|copyright)\s*(\d{4})(?:\s*[-–]\s*(\d{4}))?/i);
    if (cy) {
      const y = Number(cy[2] || cy[1]);
      if (y < new Date().getFullYear())
        add(b, { category: "Content", severity: "warning", rule: "copyright-year", message: "Copyright year is out of date", found: cy[0], expected: String(new Date().getFullYear()) });
    }
  }

  // ---------- links ----------
  for (const l of p.links) {
    const h = l.href;
    if (!h || h === "#") {
      if (l.text) add(l, { category: "Links", severity: "warning", rule: "empty-link", message: "Link has no destination (# or empty)", found: l.text });
      continue;
    }
    if (/^tel:/i.test(h)) {
      const d = digits(h);
      if (!d) { add(l, { category: "Contact info", severity: "error", rule: "tel-empty", message: "Click-to-call link has no phone number", found: `${l.text || "(no text)"} → ${h}` }); continue; }
      if (factPhones.size && !factPhones.has(d))
        add(l, { category: "Contact info", severity: "error", rule: "tel-mismatch", message: "Click-to-call number doesn't match Jira", found: h, expected: facts.phones.join(", ") });
      const shown = l.text.match(PHONE_RE)?.[0];
      if (shown && digits(shown) !== d)
        add(l, { category: "Contact info", severity: "error", rule: "tel-text-mismatch", message: "Displayed phone differs from the click-to-call link", found: `${shown} → ${h}` });
      continue;
    }
    if (/^mailto:/i.test(h)) {
      const e = decodeURIComponent(h.slice(7).split("?")[0]).toLowerCase();
      if (factEmails.size && !factEmails.has(e))
        add(l, { category: "Contact info", severity: "error", rule: "mailto-mismatch", message: "Email link doesn't match Jira", found: e, expected: facts.emails.join(", ") });
      continue;
    }
    let host = "";
    try { host = new URL(l.abs).hostname; } catch { continue; }
    for (const [platform, re] of Object.entries(SOCIAL_HOSTS)) {
      if (!re.test(host)) continue;
      const path = new URL(l.abs).pathname.replace(/\/+$/, "");
      if (!path && platform !== "google")
        add(l, { category: "Links", severity: "error", rule: "social-generic", message: `${cap(platform)} link points to the generic homepage, not the client's profile`, found: l.abs });
      const expected = facts.socials.filter((s) => s.platform.toLowerCase() === platform || SOCIAL_HOSTS[s.platform.toLowerCase()]?.test(host));
      if (expected.length && path && !expected.some((s) => sameSocial(s.url, l.abs)))
        add(l, { category: "Links", severity: "error", rule: "social-mismatch", message: `${cap(platform)} link doesn't match Jira`, found: l.abs, expected: expected.map((s) => s.url).join(", ") });
      break;
    }
    if (/^http:\/\//i.test(h)) add(l, { category: "Links", severity: "info", rule: "insecure-link", message: "Link uses http:// instead of https://", found: h });
  }

  // ---------- ShopGenie "Book appointment" buttons: custom button, opens the booking widget — must have no href ----------
  for (const bb of p.bookButtons || []) {
    if (bb.href !== null)
      add(bb, { category: "Links", severity: "error", rule: "book-btn-href", message: "ShopGenie booking button (.shopgenie-book-appt-bt) has a link — remove the href so it opens the booking widget", found: `${bb.text || "(button)"} → ${bb.href || '(empty href="")'}` });
  }

  // ---------- images ----------
  const altCount = new Map<string, number>();
  const bizNames = [facts.businessName, ...facts.altNames].filter(Boolean);
  const bizName = facts.businessName;
  for (const img of p.images) {
    if (img.decorative) continue; // (images in the reviews section are checked too — review icons need the business name)
    const file = img.src.split("/").pop()?.split("?")[0] || img.src;
    if (img.alt === null) {
      add(img, { category: "Images", severity: "error", rule: "alt-missing", message: "Image has no alt attribute", found: file });
      continue;
    }
    if (img.alt === "") {
      add(img, { category: "Images", severity: bizName ? "error" : "warning", rule: "alt-empty", message: bizName ? `Image alt text is empty — every alt text needs a description ending with “ | ${bizName}”` : "Image alt text is empty (OK only if purely decorative)", found: file, expected: bizName ? `(describe the image) | ${bizName}` : undefined });
      continue;
    }
    const a = img.alt;
    // every alt text ends with " | Business Name"
    if (bizName && !bizNames.some((n) => sameBusiness(lastPart(a), n))) {
      const other = lastPart(a);
      add(img, { category: "Images", severity: "error", rule: "alt-no-business-name",
        message: other ? `Alt text ends with “| ${other}” — it must end with “ | ${bizName}”` : `Alt text must end with “ | ${bizName}”`,
        found: `${file} — alt: ${JSON.stringify(a)}`, expected: `${(other ? a.slice(0, a.lastIndexOf("|")) : a).trim()} | ${bizName}` });
    }
    if (/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(a) || /^(img|dsc|image|photo|pic|screenshot|shutterstock|istock|adobestock)[-_ ]?\d+/i.test(a) || (/^[\w-]{10,}$/.test(a) && /\d/.test(a) && !/\s/.test(a)))
      add(img, { category: "Images", severity: "warning", rule: "alt-filename", message: "Alt text looks like a file name", found: a });
    else if (/^(image|picture|photo|graphic) of\b/i.test(a))
      add(img, { category: "Images", severity: "info", rule: "alt-redundant", message: 'Alt text starts with "image/picture of" (redundant)', found: a });
    if (a.length > 125) add(img, { category: "Images", severity: "info", rule: "alt-long", message: `Alt text is long (${a.length} chars)`, found: a.slice(0, 140) + "…" });
    if (a.length < 4) add(img, { category: "Images", severity: "warning", rule: "alt-short", message: "Alt text is too short to be descriptive", found: a });
    if (!img.global) altCount.set(a.toLowerCase(), (altCount.get(a.toLowerCase()) || 0) + 1);
  }
  for (const [a, n] of altCount) if (n > 2)
    add(pageLevel, { category: "Images", severity: "info", rule: "alt-duplicate", message: `${n} images share the same alt text`, found: a });

  // ---------- SEO ----------
  if (!p.title) add(pageLevel, { category: "SEO", severity: "error", rule: "title-missing", message: "Page has no <title>" });
  else {
    if (p.title.length > 65) add(pageLevel, { category: "SEO", severity: "info", rule: "title-long", message: `Title is ${p.title.length} chars (aim ≤ 60)`, found: p.title });
    // Titles end with "<location> | <Business Name>" — e.g. "Brake Repair in Lincoln, NE | The Auto Connection"
    if (bizName && !bizNames.some((n) => sameBusiness(lastPart(p.title), n)))
      add(pageLevel, { category: "SEO", severity: "error", rule: "title-no-business-suffix", message: `Meta title must end with “ | ${bizName}”`, found: p.title,
        expected: `${(lastPart(p.title) ? p.title.slice(0, p.title.lastIndexOf("|")) : p.title).trim()} | ${bizName}` });
    const L = facts.locations[0];
    if (L?.city && !isLocationPage(path)) {
      const before = (lastPart(p.title) ? p.title.slice(0, p.title.lastIndexOf("|")) : p.title).trim();
      const stName = REGION_NAMES[L.state.toUpperCase()] || "";
      const cityRe = new RegExp(`\\b${reEsc(L.city)}\\b`, "i");
      const atEnd = new RegExp(`\\b${reEsc(L.city)}(?:,?\\s+(?:${reEsc(L.state)}${stName ? `|${reEsc(stName)}` : ""}))?\\.?\\s*$`, "i");
      const want = `${L.city}, ${L.state.toUpperCase()} | ${bizName || "Business Name"}`;
      // another state in the title ("…, TX |" for a Nebraska shop) is a copy-paste from another site
      const otherState = [...before.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1]).find((st) => STATE_CODES.has(st) && st !== L.state.toUpperCase());
      if (otherState) add(pageLevel, { category: "SEO", severity: "error", rule: "title-other-location", message: `Meta title names another state (${otherState}) — the shop is in ${L.city}, ${L.state.toUpperCase()}`, found: p.title, expected: `… ${want}` });
      else if (!cityRe.test(before)) add(pageLevel, { category: "SEO", severity: "warning", rule: "title-no-location", message: `Meta title has no location before the business name`, found: p.title, expected: `… ${want}` });
      else if (!atEnd.test(before)) add(pageLevel, { category: "SEO", severity: "warning", rule: "title-location-position", message: `The location should come right before “ | ${bizName || "Business Name"}”`, found: p.title, expected: `… ${want}` });
    }
    for (const re of PLACEHOLDERS) if (re.test(p.title)) add(pageLevel, { category: "SEO", severity: "error", rule: "title-placeholder", message: "Title contains placeholder text", found: p.title });
  }
  if (!p.metaDescription) add(pageLevel, { category: "SEO", severity: "error", rule: "meta-missing", message: "Missing meta description" });
  else if (p.metaDescription.length > 160) add(pageLevel, { category: "SEO", severity: "info", rule: "meta-long", message: `Meta description is ${p.metaDescription.length} chars (aim ≤ 160)`, found: p.metaDescription });
  if (p.h1s.length === 0) add(pageLevel, { category: "SEO", severity: "error", rule: "h1-missing", message: "Page has no H1 heading" });
  if (p.h1s.length > 1) add(pageLevel, { category: "SEO", severity: "error", rule: "h1-multiple", message: `Page has ${p.h1s.length} H1 headings — use one`, found: p.h1s.join(" | ") });

  return out;
}

function checkNameVariants(b: Block, names: string[], display: string, add: (b: Block, f: Omit<Finding, "path" | "url" | "selector" | "source" | "global">) => void) {
  const text = normName(b.text);
  const words = text.split(" ");
  for (const n of names) {
    const nw = n.split(" ");
    if (nw.join("").length < 6) continue;
    if (text.includes(n)) continue;
    for (let i = 0; i + nw.length <= words.length; i++) {
      const win = words.slice(i, i + nw.length).join(" ");
      if (win[0] !== n[0]) continue;
      const d = lev(win, n);
      if (d > 0 && d <= Math.max(1, Math.floor(n.length * 0.15))) {
        if (names.includes(win)) continue;
        // ignore a possessive on the last word ("Joe's Auto Repair's")
        if (win.replace(/'?s$/, "") === n) continue;
        add(b, { category: "Business name", severity: "error", rule: "name-variant", message: `Business name spelled differently than Jira ("${win}")`, found: b.text.length > 140 ? b.text.slice(0, 140) + "…" : b.text, expected: display });
        return;
      }
    }
  }
}

export function sitewide(pages: { path: string; url: string; data: PageData }[], facts: Facts): Finding[] {
  const out: Finding[] = [];
  const site = { path: "Site-wide", url: "", selector: "", source: "rule" as const, global: true };
  const allText = pages.map((p) => p.data.blocks.map((b) => b.text).join("\n")).join("\n");
  const allTextNorm = normName(allText);
  const allTel = pages.flatMap((p) => p.data.links.filter((l) => /^tel:/i.test(l.href)).map((l) => digits(l.href)));
  const allDigits = new Set([...[...allText.matchAll(PHONE_RE)].map((m) => digits(m[0])), ...allTel]);

  for (const ph of facts.phones) if (digits(ph).length === 10 && !allDigits.has(digits(ph)))
    out.push({ ...site, category: "Contact info", severity: "warning", rule: "fact-phone-absent", message: "Jira phone number not found anywhere on the site", expected: formatPhone(ph) });
  const recipients = new Set(pages.flatMap((p) => p.data.formRecipients || []));
  for (const e of facts.emails) if (!allText.toLowerCase().includes(e.toLowerCase()) && !recipients.has(e.toLowerCase()) && !pages.some((p) => p.data.links.some((l) => l.href.toLowerCase().includes(e.toLowerCase()))))
    out.push({ ...site, category: "Contact info", severity: "warning", rule: "fact-email-absent", message: "Jira email isn't shown on the site and no contact form sends to it", expected: e });
  // contact forms (hidden "dmformsendto") should send to the shop's email
  if (facts.emails.length) for (const r of recipients) if (!facts.emails.some((e) => e.toLowerCase() === r))
    out.push({ ...site, category: "Contact info", severity: "error", rule: "form-recipient-mismatch", message: "A contact form sends to an email that isn't in Jira", found: r, expected: facts.emails.join(", ") });
  if (facts.businessName && !allTextNorm.includes(normName(facts.businessName)) && !(bizKey(facts.businessName).length > 3 && allTextNorm.includes(bizKey(facts.businessName))))
    out.push({ ...site, category: "Business name", severity: "error", rule: "fact-name-absent", message: "Business name from Jira never appears on the site", expected: facts.businessName });
  const allStreetNorm = normStreet(allText);
  for (const l of facts.locations) {
    if (l.street && !allStreetNorm.includes(normStreet(l.street)))
      out.push({ ...site, category: "Contact info", severity: "warning", rule: "fact-street-absent", message: "Jira street address not found on the site", expected: l.street });
    if (l.zip && !allText.includes(l.zip))
      out.push({ ...site, category: "Contact info", severity: "warning", rule: "fact-zip-absent", message: "Jira ZIP code not found on the site", expected: `${l.city}, ${l.state} ${l.zip}` });
  }
  for (const s of facts.socials) {
    if (!pages.some((p) => p.data.links.some((l) => sameSocial(l.abs, s.url))))
      out.push({ ...site, category: "Links", severity: "warning", rule: "fact-social-absent", message: `Jira ${s.platform} link isn't linked anywhere`, expected: s.url });
  }
  for (const s of facts.services) {
    if (s.length > 2 && !allTextNorm.includes(normName(s)))
      out.push({ ...site, category: "Content", severity: "warning", rule: "fact-service-absent", message: "Service from Jira isn't mentioned on the site", expected: s });
  }
  for (const c of facts.citiesServed) {
    if (c.length > 2 && !allTextNorm.includes(normName(c)))
      out.push({ ...site, category: "Content", severity: "info", rule: "fact-city-absent", message: "City served (Jira) isn't mentioned on the site", expected: c });
  }

  // Hours consistency when no Jira hours
  if (!facts.hours.length) {
    const seen = new Map<Day, Set<string>>();
    for (const p of pages) for (const b of p.data.blocks) for (const h of parseHours(b.text)) {
      if (!seen.has(h.day)) seen.set(h.day, new Set());
      seen.get(h.day)!.add(normHoursValue(h.value));
    }
    for (const d of DAYS) if ((seen.get(d)?.size || 0) > 1)
      out.push({ ...site, category: "Hours", severity: "error", rule: "hours-inconsistent", message: `${DAY_LABEL[d]} hours differ across pages`, found: [...seen.get(d)!].join(" vs ") });
  }

  // Duplicate titles / descriptions
  const dup = (key: "title" | "metaDescription", label: string) => {
    const m = new Map<string, string[]>();
    for (const p of pages) { const v = p.data[key]; if (v) m.set(v, [...(m.get(v) || []), p.path]); }
    for (const [v, paths] of m) if (paths.length > 1)
      out.push({ ...site, category: "SEO", severity: "warning", rule: `duplicate-${key}`, message: `Duplicate ${label} on ${paths.length} pages: ${paths.join(", ")}`, found: v });
  };
  dup("title", "title"); dup("metaDescription", "meta description");
  return out;
}

const excerpt = (t: string, i: number) => (i > 30 ? "…" : "") + t.slice(Math.max(0, i - 30), i + 60) + (t.length > i + 60 ? "…" : "");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

const STATE_CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "));

export function fingerprint(f: Finding) {
  const scope = f.global ? "G" : f.path;
  // No selector: Duda renders desktop + mobile copies of the same element; report the text once per page.
  return [f.source, f.rule, scope, (f.found || f.message).toLowerCase().slice(0, 160)].join("|");
}
