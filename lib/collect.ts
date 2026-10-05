import areaCodes from "./areaCodes.json";
import type { JiraFields, JiraProject } from "./jira";
import { pick, pickAll } from "./jira";
import { emptyFacts, parseHours, type Facts } from "./facts";

/**
 * "Data Collection" — the same fields, labels and order as the Shopgenie/Tekmetric guideline sheet.
 * Jira is the source of truth; research only fills gaps and adds notes.
 */

export const FIELDS = [
  { key: "shopName", label: "Shop Name:" },
  { key: "cityState", label: "City, State:" },
  { key: "address", label: "Complete Shop Address:" },
  { key: "gbpLink", label: "GBP Link:" },
  { key: "placeId", label: "GBP Place ID:" },
  { key: "phone", label: "Shop Phone Number:" },
  { key: "email", label: "Email:" },
  { key: "businessType", label: "Business Type:" },
  { key: "hours", label: "Shop Hours:" },
  { key: "existingWebsite", label: "Existing Website to scan for additional Info:" },
  { key: "domain", label: "Domain to be used:" },
  { key: "socials", label: "Social Accounts to scan for additional info:" },
  { key: "services", label: "Primary Services:" },
  { key: "vehicles", label: "Vehicles Serviced:" },
  { key: "coupons", label: "Coupons or promotions:" },
  { key: "warranties", label: "Warranties:" },
  { key: "financing", label: "Financing:" },
  { key: "certifications", label: "Certifications:" },
  { key: "about", label: 'Short "About Us" description for their auto shop:' },
  { key: "faq", label: "Additional FAQ:" },
  { key: "amenities", label: "Benefits/Amenities:" },
  { key: "specialNotes", label: "Special notes:" },
  { key: "template", label: "Template" },
  { key: "date", label: "Date:" },
  { key: "jiraUrl", label: "Hubspot URL:" },
  { key: "editorUrl", label: "Editor URL:" },
] as const;

export type FieldKey = (typeof FIELDS)[number]["key"];
export type Source = "jira" | "gbp" | "website" | "search" | "ai" | "rule" | "manual" | "";
export type Status = "ok" | "review" | "missing";
export type CField = { value: string; note: string; source: Source; status: Status; manual?: boolean };
/** Per-shop fields for MSO sites (same labels as the guideline sheet's MSO block). */
export const LOC_FIELDS = [
  { key: "gbpName", label: "GBP Name" },
  { key: "address", label: "Complete Shop Address" },
  { key: "gbpLink", label: "GBP Link" },
  { key: "placeId", label: "GBP Place ID" },
  { key: "phone", label: "Shop Phone Number" },
  { key: "email", label: "Email for Job Application" },
  { key: "hours", label: "Shop Hours" },
  { key: "socials", label: "Social Accounts to Scan for Additional Info" },
] as const;
export type LocKey = (typeof LOC_FIELDS)[number]["key"];
export type Loc = { city: string; state: string; tekmetricId: string; fields: Record<LocKey, CField> };

/** Fields that live per location on MSO sites (hidden from the shared list). */
export const PER_LOCATION: FieldKey[] = ["address", "gbpLink", "placeId", "phone", "email", "hours", "socials"];
/** The MSO block in the guideline sheet words a few shared labels differently. */
export const MSO_LABELS: Partial<Record<FieldKey, string>> = {
  existingWebsite: "Existing Website to Scan for Additional Info:", domain: "Domain to Be Used:", coupons: "Coupons or Promotions:",
  about: "Short “About Us” Description:", faq: "Additional FAQ", amenities: "Benefits/Amenities :", specialNotes: "Other notes:",
};

export type Collection = {
  locations: Loc[];
  fields: Record<FieldKey, CField>;
  pages: string[];
  minServices: number;
  minAmenities: number;
  research: Record<string, { at: string; ok: boolean; summary: string }>;
};

export const INSPECTION_STATES = ["TX", "HI", "VA", "MD", "MA", "WV", "VT", "NC", "NH", "LA"];
export const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "));

const F = (value = "", source: Source = "", status: Status = value ? "ok" : "missing", note = ""): CField => ({ value, note, source, status });

export function emptyCollection(): Collection {
  return {
    fields: Object.fromEntries(FIELDS.map((f) => [f.key, F()])) as Record<FieldKey, CField>,
    locations: [], pages: [], minServices: 8, minAmenities: 8, research: {},
  };
}

export function normalizeCollection(c: Partial<Collection> | null | undefined): Collection {
  const e = emptyCollection();
  if (!c) return e;
  for (const f of FIELDS) if (c.fields?.[f.key]) e.fields[f.key] = { ...e.fields[f.key], ...c.fields[f.key] };
  const locations = (Array.isArray(c.locations) ? c.locations : []).map((l) => ({
    city: l.city || "", state: l.state || "", tekmetricId: l.tekmetricId || "",
    fields: Object.fromEntries(LOC_FIELDS.map((f) => [f.key, { ...F(), ...(l.fields?.[f.key] || {}) }])) as Record<LocKey, CField>,
  }));
  return { ...e, ...c, fields: e.fields, locations, pages: Array.isArray(c.pages) ? c.pages : [], research: c.research || {} };
}

// ---------- helpers ----------

const SMALL_UPPER = /^(ac|a\/c|ev|ase|abs|cv|rv|suv|uv|tpms|oem|dot|ac\/heat|hvac|led|awd|4wd|fwd|rwd|bmw|vw|gm|pac|napa|aaa|bbb|usa|faq|ii|iii)$/i;
/** Title Case each word ("hybrid and EV" → "Hybrid And EV"), keeping acronyms upper-case. */
export function titleCase(s: string) {
  return s.trim().replace(/\s+/g, " ").split(" ").map((w) =>
    w.split(/([/-])/).map((p) => (/^\d+x\d+$/i.test(p) ? p.toLowerCase() : SMALL_UPPER.test(p) ? p.toUpperCase() : /^[A-Z0-9]{2,}$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())).join("")
  ).join(" ");
}

/** List items: one per line if the client used lines, otherwise split on commas/semicolons ("36,000" stays whole). */
export const splitLines = (s: string) => {
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : s.split(/(?<!\b(?:years?|yrs?|months?|mos?|miles?|mi))\s*,(?![^(]*\))(?!\d{3}\b)|;|•|\.\s+(?=[A-Z])/i);
  return parts.map((x) => x.replace(/^[\s\-*•]+|^\d+[.)]\s+/g, "").replace(/[,.;]\s*$/, "").trim()).filter((x) => x.length > 1 && !/^other$/i.test(x));
};
export const uniqLines = (a: string[]) => { const seen = new Set<string>(); return a.filter((x) => { const k = x.toLowerCase().replace(/[^a-z0-9]/g, ""); if (seen.has(k)) return false; seen.add(k); return true; }); };

export function formatPhone(raw: string) {
  const d = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw.trim();
}

export function checkPhone(raw: string, state: string): { value: string; ok: boolean; note: string } {
  const d = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length !== 10) return { value: raw.trim(), ok: false, note: `Phone "${raw}" isn't a 10-digit US number.` };
  const ac = d.slice(0, 3);
  if (/^[01]/.test(ac) || /^[01]/.test(d.slice(3))) return { value: formatPhone(d), ok: false, note: "Phone number format is invalid (area code / exchange can't start with 0 or 1)." };
  const map = areaCodes as Record<string, string | string[]>;
  const st = map[ac];
  if (!st) return { value: formatPhone(d), ok: false, note: `Area code ${ac} isn't a known US area code — double-check the number.` };
  const states = Array.isArray(st) ? st : [st];
  if (state && !states.includes(state)) return { value: formatPhone(d), ok: false, note: `Area code ${ac} belongs to ${states.join("/")}, but the shop is in ${state}. Could be a cell/VoIP number — please verify.` };
  return { value: formatPhone(d), ok: true, note: "" };
}

const SUFFIX = /\b(st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|place|cir|circle|trl|trail|ter|terrace|pike|loop|sq|square|row|run|pass|expy|fwy|plaza|suite|ste|unit|#\s?\w+)\.?$/i;

/** "11183 Trails End Rd. Truckee, CA 96161" → { city: "Truckee", state: "CA", zip: "96161" } */
export function parseCityState(address: string): { city: string; state: string; zip: string } {
  const a = address.replace(/,?\s*(USA|United States)\.?$/i, "").trim();
  const m = a.match(/^(.*?)[,\s]+([A-Z]{2})\.?\s*(\d{5})?(?:-\d{4})?\s*$/);
  if (!m || !STATES.has(m[2])) return { city: "", state: "", zip: "" };
  const before = m[1].trim();
  let city = before.includes(",") ? before.split(",").pop()!.trim() : "";
  if (!city) {
    // no comma: city follows the street suffix ("…Trails End Rd. Truckee")
    const words = before.split(/\s+/);
    for (let i = words.length - 1; i > 0; i--) {
      if (SUFFIX.test(words.slice(0, i).join(" "))) { city = words.slice(i).join(" "); break; }
    }
  }
  return { city: city.replace(/^\d+\s+/, ""), state: m[2], zip: m[3] || "" };
}

/**
 * Jira's Shop Address can hold several shops, each often split over two lines:
 * "1385 E. Hwy 24\n\nMoberly, MO 65270\n\n\n1901 N. Baltimore St.\n\nKirksville, MO 63501"
 */
export function parseAddresses(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim().replace(/\s*[;|]\s*$/, "")).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    for (const part of l.split(/\s*;\s*|\s+\|\s+/)) {
      cur.push(part);
      if (/\b[A-Z]{2}\.?\s*\d{5}(-\d{4})?\s*$/.test(part)) { out.push(cur.join(", ").replace(/,\s*,/g, ",").replace(/\s+,/g, ",")); cur = []; }
    }
  }
  if (cur.length) out.push(cur.join(", "));
  return out.filter((a) => a.length > 5);
}

/** "Moberly and Kirksville, MO" / "Austin, TX and Tulsa, OK" — the sheet's combined City, State. */
export function combinedCityState(locs: { city: string; state: string }[]) {
  const ok = locs.filter((l) => l.city && l.state);
  if (!ok.length) return "";
  const join = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
  const states = [...new Set(ok.map((l) => l.state))];
  return states.length === 1 ? `${join(ok.map((l) => l.city))}, ${states[0]}` : join(ok.map((l) => `${l.city}, ${l.state}`));
}

export function newLocation(): Loc {
  return { city: "", state: "", tekmetricId: "", fields: Object.fromEntries(LOC_FIELDS.map((f) => [f.key, F()])) as Record<LocKey, CField> };
}

export const stripCountry = (a: string) => a.replace(/,?\s*(USA|United States|US)\.?$/i, "").trim();

export function websiteUrl(raw: string) {
  const s = raw.trim().split(/\s+/)[0];
  if (!s || !/\./.test(s)) return "";
  const host = s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return `https://${host.startsWith("www.") || host.split(".").length > 2 ? host : "www." + host}/`;
}
export const domainOf = (url: string) => {
  const h = url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return h ? (h.startsWith("www.") ? h : "www." + h) : "";
};

const KNOWN_CERTS = ["AAA", "ACDelco", "Advance Auto Parts", "AMSOIL", "ASA", "ASCCA", "ASE Blue Seal", "ASE Master", "ASE", "ATRA", "Auto Value", "AutoZone", "BBB", "BG", "Bosch", "Bumper To Bumper", "Carquest", "CarShield", "Carfax", "Motorcraft", "Mopar", "NAPA AutoCare", "NAPA", "RepairPal", "Technet", "Worldpac", "Endurance", "CNA National", "Fidelity Warranty Services", "K&N", "Lifetime BG Protection Plan", "NFIB", "Professional Automotive Care", "PAC", "Route 66", "AutoNetTV", "ATI"];

export function certsMentioned(text: string): string[] {
  const out: string[] = [];
  for (const c of KNOWN_CERTS) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, c.length <= 4 ? "" : "i");
    if (re.test(text) && !out.some((o) => o.toLowerCase().includes(c.toLowerCase()))) out.push(c);
  }
  return out;
}

// ---------- Jira → first draft ----------

export function fromJira(jira: JiraProject, f: JiraFields, opts: { minAmenities: number; editorUrl?: string }): Collection {
  const c = emptyCollection();
  c.minAmenities = opts.minAmenities;
  const set = (k: FieldKey, v: Partial<CField>) => { c.fields[k] = { ...c.fields[k], ...v }; };

  set("shopName", F(jira.shopName, "jira", jira.shopName ? "review" : "missing", jira.shopName ? "Verify it matches the Google Business Profile name." : ""));

  const rawAddr = pick(f, /^Shop Address$/i, /mailing address/i);
  const loc = parseCityState(rawAddr);
  set("address", F(stripCountry(rawAddr), "jira", rawAddr ? "review" : "missing", rawAddr ? "From Jira — replace with the exact GBP address." : "No shop address in Jira."));
  set("cityState", F(loc.city && loc.state ? `${loc.city}, ${loc.state}` : "", "jira", loc.city ? "review" : "missing"));

  const phoneRaw = pick(f, /^Shop Phone Number$/i, /phone/i);
  if (phoneRaw) { const p = checkPhone(phoneRaw, loc.state); set("phone", F(p.value, "jira", p.ok ? "ok" : "review", p.note)); }

  const jobs = pick(f, /what email would you like to (use|receive).*job/i);
  const primary = pick(f, /^Primary Contact Email$/i, /company email/i);
  if (jobs) set("email", F(jobs.toLowerCase(), "jira"));
  else if (primary) set("email", F(primary.toLowerCase(), "jira", "review", "No job-applications email in Jira — used the Primary Contact Email."));

  set("businessType", F("Auto Repair Shop", "rule", "ok"));

  const hours = pick(f, /^Shop Hours$/i, /hours/i);
  set("hours", F(hours, "jira", hours ? "review" : "missing", hours ? "Jira is the source of truth — formatting and GBP comparison happen during research." : "No hours in Jira."));

  const existing = /yes/i.test(pick(f, /^Existing Website$/i)) || !!pick(f, /^Current Website$/i);
  const cur = websiteUrl(pick(f, /^Current Website$/i));
  if (existing && cur) set("existingWebsite", F(cur, "jira", "review", "Check it isn't outdated or from a previous brand."));

  const dom = pick(f, /what is that domain/i);
  if (dom) set("domain", F(domainOf(dom), "jira"));
  else if (cur) set("domain", F(domainOf(cur), "rule", "review", "No domain given in Jira — using their current website's domain."));

  const socials = uniqLines(splitLines(pick(f, /^Social Links$/i)).filter((s) => /^https?:\/\//i.test(s) || /\.(com|net|org)/i.test(s)));
  set("socials", F(socials.join("\n\n"), "jira", "review", socials.length ? "Search found accounts will be added during research." : "No social links in Jira — research will look for them."));

  const services = uniqLines(splitLines(pick(f, /^Primary Services$/i)).map(titleCase));
  set("services", F(services.join("\n"), "jira", services.length >= c.minServices ? "ok" : "review",
    services.length < c.minServices ? `Only ${services.length} service(s) provided — need at least ${c.minServices}. Research will look for more.` : ""));

  const excludes = /yes/i.test(pick(f, /types of vehicles you do not service/i));
  const notServiced = pick(f, /vehicles not serviced/i);
  set("vehicles", excludes && notServiced
    ? F(`All Makes and Models EXCEPT ${notServiced.replace(/\s+/g, " ").trim()}`, "rule", "ok")
    : F("All Makes and Models", "rule", "ok"));

  const wants = (re: RegExp) => jira.pages.some((p) => re.test(p));
  const coupons = pick(f, /^Coupons$/i, /coupon|promotion|special/i);
  set("coupons", F(coupons, "jira", coupons ? "ok" : wants(/coupon|special/i) ? "review" : "missing", !coupons && wants(/coupon|special/i) ? "Coupons page requested but none provided — research will look on their website/socials." : ""));

  const warranty = pick(f, /warrant/i);
  set("warranties", F(warranty, "jira", warranty ? "ok" : "review", warranty ? "" : "No warranty in Jira — research will check NAPA AutoCare / PAC and their socials."));

  const financing = Object.entries(f).filter(([k]) => /financ/i.test(k) && !/pages/i.test(k)).flatMap(([, v]) => v).join("\n");
  set("financing", F(financing, "jira", financing ? "ok" : wants(/financ/i) ? "review" : "missing", !financing && wants(/financ/i) ? "Financing page requested — research will check their current website." : ""));

  const certs = uniqLines([
    ...pickAll(f, /select any relevant shop affiliations|^Affiliations$/i).filter((x) => !/^other$/i.test(x)),
    ...splitLines(pick(f, /list any other affiliations/i)),
  ]);
  const about = pick(f, /^About Us$/i);
  const faq = pick(f, /faq/i);
  const extra = certsMentioned(`${about}\n${faq}`).filter((m) => !certs.some((x) => x.toLowerCase().includes(m.toLowerCase())));
  set("certifications", F(uniqLines([...certs, ...extra]).join("\n"), "jira", extra.length ? "review" : certs.length ? "ok" : "review",
    extra.length ? `Added ${extra.join(", ")} — mentioned in their About Us/FAQ but not selected in the form.` : certs.length ? "" : "No certifications in Jira — research will look for ASE, NAPA, AAA, etc."));

  set("about", F(about, "jira", about ? "ok" : "review", about ? "Jira About Us is the fact (dates/years win over other sources)." : "No About Us — research will look on their website/Facebook."));
  if (faq) set("faq", F(faq, "jira", "ok", /warrant/i.test(faq) && !warranty ? "FAQ mentions a warranty — check the Warranties field." : ""));

  const amenities = uniqLines(splitLines(pick(f, /^Amenities$/i, /benefit/i)).map(titleCase));
  set("amenities", F(amenities.join("\n"), "jira", amenities.length >= c.minAmenities ? "ok" : "review",
    amenities.length < c.minAmenities ? `Template needs ${c.minAmenities}; Jira has ${amenities.length}. Research will add more from their website/socials.` : ""));

  const instr = [pick(f, /^Instructions$/i), pick(f, /what other sections/i)].filter(Boolean).join("\n\n");
  set("specialNotes", F(instr, "jira", instr ? "review" : "ok", instr ? "Special instructions from Jira — read before building." : ""));

  set("template", F(jira.template, "jira", jira.template ? "ok" : "missing"));
  set("date", F(new Date().toISOString().slice(0, 10), "rule", "ok"));
  set("jiraUrl", F(jira.url, "jira", jira.url ? "ok" : "missing"));
  if (opts.editorUrl) set("editorUrl", F(opts.editorUrl, "manual", "ok"));

  c.pages = jira.pages;

  // ---- MSO: one block per shop ----
  const addrs = parseAddresses(rawAddr);
  if (jira.type === "mso" || addrs.length > 1) {
    const n = Math.max(addrs.length, 1);
    const phones = (phoneRaw.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []).map((x) => x.trim());
    const tmIds = (jira.tekmetricId || "").split(/[,;\s/]+/).filter(Boolean);
    const socialsAll = splitLinesKeep(c.fields.socials.value);
    for (let i = 0; i < n; i++) {
      const L = newLocation();
      const a = addrs[i] || "";
      const pc = parseCityState(a);
      L.city = pc.city; L.state = pc.state; L.tekmetricId = tmIds[i] || "";
      const lf = L.fields;
      lf.gbpName = F("", "", "missing", "Filled from the Google Business Profile during research.");
      lf.address = F(stripCountry(a), "jira", a ? "review" : "missing", a ? "From Jira — replace with the exact GBP address." : `Jira lists ${addrs.length} address(es) — add this one.`);
      const ph = phones.length >= n ? phones[i] : phones[0] || "";
      if (ph) {
        const chk = checkPhone(ph, pc.state);
        lf.phone = F(chk.value, "jira", chk.ok && phones.length >= n ? "ok" : "review",
          [phones.length < n && n > 1 ? `Only ${phones.length} phone number provided — used it for all ${n} locations.` : "", chk.note].filter(Boolean).join(" "));
      }
      lf.email = { ...c.fields.email };
      if (c.fields.hours.value) lf.hours = F(c.fields.hours.value, "jira", "review", n > 1 ? "Only one set of hours provided — used it for all locations. Formatting and GBP comparison happen during research." : c.fields.hours.note);
      const cityTok = pc.city.toLowerCase().replace(/[^a-z]/g, "");
      const mine = socialsAll.filter((u) => cityTok && u.toLowerCase().replace(/[^a-z]/g, "").includes(cityTok));
      const unassigned = socialsAll.filter((u) => !addrs.some((x) => { const t = parseCityState(x).city.toLowerCase().replace(/[^a-z]/g, ""); return t && u.toLowerCase().replace(/[^a-z]/g, "").includes(t); }));
      const list = i === 0 ? [...mine, ...unassigned] : mine;
      lf.socials = F(uniqLines(list).join("\n\n"), list.length ? "jira" : "", "review", list.length ? "" : "Research will look for this location's Facebook/Yelp/etc.");
      c.locations.push(L);
    }
    set("cityState", F(combinedCityState(c.locations), "jira", "review"));
    for (const k of PER_LOCATION) c.fields[k] = { value: "", note: "Per location — see the Locations section.", source: "rule", status: "ok" };
    if (tmIds.length > 1) set("specialNotes", { note: joinNote(c.fields.specialNotes.note, `Tekmetric IDs per location: ${c.locations.map((l, i) => `${l.city || `Location ${i + 1}`} → ${l.tekmetricId || "?"}`).join(", ")}.`) });
  }
  applyRules(c);
  return c;
}

/** Rules that must hold no matter where values came from. Re-run after every research step. */
export function applyRules(c: Collection) {
  const states = [...new Set([c.fields.cityState.value.match(/,\s*([A-Z]{2})\b/)?.[1] || "", ...c.locations.map((l) => l.state)].filter(Boolean))];
  const insp = states.filter((st) => INSPECTION_STATES.includes(st));
  const svc = splitLinesKeep(c.fields.services.value);
  if (insp.length && !svc.some((s) => /state inspection/i.test(s))) {
    svc.push("State Inspection");
    c.fields.services.value = svc.join("\n");
    c.fields.services.note = joinNote(c.fields.services.note, `Added "State Inspection" — required for ${insp.join(", ")}.`);
  }
  if (svc.length >= c.minServices && c.fields.services.status === "review" && /need at least/.test(c.fields.services.note)) {
    c.fields.services.note = c.fields.services.note.replace(/Only \d+ service\(s\) provided — need at least \d+\. Research will look for more\.\s*/, "");
    if (!c.fields.services.note) c.fields.services.status = "ok";
  }
  const am = splitLinesKeep(c.fields.amenities.value);
  if (am.length >= c.minAmenities && /Template needs/.test(c.fields.amenities.note)) {
    c.fields.amenities.note = c.fields.amenities.note.replace(/Template needs \d+; Jira has \d+\. Research will add more from their website\/socials\.\s*/, "");
    if (!c.fields.amenities.note) c.fields.amenities.status = "ok";
  }
  for (const k of Object.keys(c.fields) as FieldKey[]) if (!c.fields[k].value && c.fields[k].status === "ok" && k !== "faq" && k !== "specialNotes" && !(c.locations.length && PER_LOCATION.includes(k))) c.fields[k].status = "missing";
  if (c.locations.length) c.fields.cityState.value = c.fields.cityState.manual ? c.fields.cityState.value : combinedCityState(c.locations) || c.fields.cityState.value;
  return c;
}

export const splitLinesKeep = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
export const joinNote = (a: string, b: string) => (a.includes(b) ? a : [a, b].filter(Boolean).join("\n"));

// ---------- output ----------

/** Rows in the same order/labels as the guideline sheet (single-location or MSO block). */
export function sheetRows(c: Collection): string[][] {
  const rows: string[][] = [["Please use the details below for my prompt that I'm going to enter:", "", "", INSPECTION_STATES.join(", "), "State Inspection"]];
  const v = (k: FieldKey) => c.fields[k];
  const push = (label: string, f: CField | { value: string; note: string }) => rows.push([label, f.value, f.note, ""]);
  const tail = () => {
    rows.push(["", "I will send a new prompt", "", ""]);
    for (const k of ["template", "date", "jiraUrl", "editorUrl"] as FieldKey[]) push(FIELDS.find((f) => f.key === k)!.label, v(k));
  };
  if (!c.locations.length) {
    for (const f of FIELDS) { if (f.key === "template") break; push(f.label, v(f.key)); }
    tail();
    ["Pages:", ...c.pages].forEach((pg, i) => { const r = 2 + i; while (rows.length <= r) rows.push(["", "", "", ""]); rows[r][3] = pg; });
  } else {
    push("Shop Name:", v("shopName"));
    push("City, State:", v("cityState"));
    c.locations.forEach((L, i) => {
      const n = i + 1;
      for (const lf of LOC_FIELDS) {
        const f = L.fields[lf.key];
        const note = lf.key === "gbpName" ? [L.city && L.state ? `${L.city}, ${L.state}` : "", f.note].filter(Boolean).join(" — ") : f.note;
        rows.push([`${lf.label} ${n}:`, f.value, note, ""]);
      }
    });
    const shared: FieldKey[] = ["businessType", "existingWebsite", "domain", "services", "vehicles", "coupons", "warranties", "financing", "certifications", "about", "faq", "amenities", "specialNotes"];
    for (const k of shared) push(MSO_LABELS[k] || FIELDS.find((f) => f.key === k)!.label, v(k));
    tail();
    c.pages.forEach((pg, i) => { const r = 2 + i; while (rows.length <= r) rows.push(["", "", "", ""]); rows[r][3] = pg; });
  }
  return rows;
}

/** Tab-separated block that pastes straight into the guideline sheet at A1 (A label, B value, C note, D pages). */
export function toSheetTsv(c: Collection) {
  const q = (x: string) => (/[\t\n"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  return sheetRows(c).map((r) => r.map((x) => q(x || "")).join("\t")).join("\n");
}

/** Plain "Label: value" text (for chat, email or notes). */
export function toPlainText(c: Collection) {
  return sheetRows(c).slice(1).filter((r) => r[0]).map((r) => `${r[0]} ${r[1]}`.trim()).join("\n");
}

/** Feed the QA audit: Data Collection → the "truth" facts the audit compares the site against. */
export function toFacts(c: Collection): Facts {
  const f = emptyFacts();
  const v = (k: FieldKey) => c.fields[k].value.trim();
  f.businessName = v("shopName");
  if (v("phone")) f.phones = [v("phone")];
  if (v("email")) f.emails = [v("email")];
  const toLoc = (addr: string, label?: string) => { const m = addr.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})/); return m ? [{ label, street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] }] : []; };
  if (c.locations.length) {
    f.locations = c.locations.flatMap((L) => toLoc(L.fields.address.value, L.city));
    f.phones = uniqLines(c.locations.map((L) => L.fields.phone.value).filter(Boolean));
    f.emails = uniqLines(c.locations.map((L) => L.fields.email.value.toLowerCase()).filter(Boolean));
    f.hours = parseHours(c.locations[0].fields.hours.value);
    f.altNames = uniqLines(c.locations.map((L) => L.fields.gbpName.value).filter((n) => n && n !== f.businessName));
  } else {
    f.locations = toLoc(v("address"));
    f.hours = parseHours(v("hours"));
  }
  f.websiteDomain = v("domain").replace(/^www\./, "");
  f.socials = splitLinesKeep(c.locations.length ? c.locations.map((L) => L.fields.socials.value).join("\n") : v("socials")).filter((u) => /^https?:\/\//.test(u)).map((url) => ({ platform: (url.match(/(facebook|instagram|yelp|youtube|linkedin|tiktok|twitter|x|pinterest|google)\./i)?.[1] || "other").toLowerCase(), url }));
  f.services = splitLinesKeep(v("services"));
  f.citiesServed = c.locations.length ? uniqLines(c.locations.map((L) => L.city).filter(Boolean)) : [v("cityState").split(",")[0]?.trim()].filter(Boolean);
  const custom: [string, FieldKey][] = [["Warranty", "warranties"], ["Coupons", "coupons"], ["Financing", "financing"], ["Certifications", "certifications"], ["Amenities", "amenities"], ["Vehicles serviced", "vehicles"]];
  f.custom = custom.filter(([, k]) => v(k)).map(([key, k]) => ({ key, value: v(k).slice(0, 1000) }));
  f.notes = [v("about"), v("specialNotes")].filter(Boolean).join("\n\n").slice(0, 3900);
  return f;
}
