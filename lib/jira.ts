import { readXlsx } from "./xlsx";
import { assertSafeZip, isZip } from "./parse";
import { HttpError } from "./security";

/** All values per Jira field (multi-select fields repeat the same column name). Keys have "Custom field (…)" removed. */
export type JiraFields = Record<string, string[]>;
export type ProjectType = "basic" | "advanced" | "mso";

export type JiraProject = {
  key: string;
  summary: string;
  url: string;
  shopName: string;
  type: ProjectType | null;
  typeLabel: string;
  templateNumber: string;
  template: string;           // e.g. "Single Location Template 31"
  pages: string[];            // requested pages (incl. "other pages")
  previewUrl: string;
  liveUrl: string;
  tekmetricId: string;
  created: string;
  activity: { type: string; author: string; date: string; details: string }[];
};

export const TYPE_LABEL: Record<ProjectType, string> = {
  basic: "Basic Site (Single Page Site)",
  advanced: "Advanced Site (Multi-Page Site)",
  mso: "MSO Site (Multiple Shops, 1 Site)",
};
// Same wording as the team's sheet: "HP Only - Single Location 28", "Single Location Template 31", "MSO Design 14"
const TEMPLATE_PREFIX: Record<ProjectType, string> = { basic: "HP Only - Single Location", advanced: "Single Location Template", mso: "MSO Design" };

const clean = (k: string) => k.replace(/^Custom field \((.*)\)$/i, "$1").replace(/\)Id$/, " Id").trim();

export function parseJiraXlsx(buf: Uint8Array): { fields: JiraFields; activity: JiraProject["activity"] } {
  if (!isZip(buf)) throw new HttpError(400, "That isn't an XLSX file. In Jira, use Export → Export Excel.");
  assertSafeZip(buf);
  const sheets = readXlsx(buf);
  const main = sheets.find((s) => s.rows.length >= 2 && s.rows[0].length > 5) || sheets[0];
  if (!main || main.rows.length < 2) throw new HttpError(400, "No work item found in that export");
  const [head, vals] = main.rows;
  const fields: JiraFields = {};
  head.forEach((h, i) => {
    const v = (vals[i] || "").trim();
    if (!h || !v) return;
    const k = clean(h);
    (fields[k] ||= []).push(v);
  });
  applyPayload(fields);
  applyDescription(fields);
  const act = sheets.find((s) => /activity/i.test(s.name));
  const activity = (act?.rows.slice(1) || []).map((r) => ({ type: r[0] || "", author: r[1] || "", date: r[2] || "", details: (r[3] || "").slice(0, 4000) }));
  return { fields, activity };
}

/** First field whose name matches, all values joined. */
export function pick(f: JiraFields, ...patterns: RegExp[]): string {
  for (const re of patterns) {
    const k = Object.keys(f).find((x) => re.test(x));
    if (k) return f[k].join("\n").trim();
  }
  return "";
}
export function pickAll(f: JiraFields, re: RegExp): string[] {
  return Object.keys(f).filter((k) => re.test(k)).flatMap((k) => f[k]).map((s) => s.trim()).filter(Boolean);
}

export function detectType(f: JiraFields): { type: ProjectType | null; templateNumber: string; template: string } {
  const designKey = Object.keys(f).find((k) => /preferred.*design|design selection|template/i.test(k));
  const designVal = designKey ? f[designKey][0] : "";
  const hay = [pick(f, /^Website Type$/i), pick(f, /^Summary$/i), designKey || "", designVal].join(" | ");
  let type: ProjectType | null = null;
  if (/\bMSO\b|multiple shops/i.test(hay)) type = "mso";
  else if (/\bbasic\b|single page|\bHP only\b|home ?page only/i.test(hay)) type = "basic";
  else if (/advanced|multi-page|single location/i.test(hay)) type = "advanced";
  const n = designVal.match(/(\d+)(?:\.0+)?/)?.[1] || "";
  const num = n ? String(Number(n)) : ""; // "#Single Location 07" → 7
  const template = type && num ? `${TEMPLATE_PREFIX[type]} ${num}` : designVal;
  return { type, templateNumber: num, template };
}

const httpOnly = (u: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : "");
const splitList = (s: string) => s.split(/[\n,;•|]+/).map((x) => x.trim()).filter((x) => x && !/^other$/i.test(x));

export function toProject(fields: JiraFields, activity: JiraProject["activity"]): JiraProject {
  const key = pick(fields, /^Issue key$/i);
  const t = detectType(fields);
  const pages = [
    ...pickAll(fields, /what (pages|sections) do you want/i).filter((p) => !/^other$/i.test(p)),
    ...splitList(pick(fields, /what other pages/i)),
    // new form: one comma-separated "Website Pages" field (sections too, even on a basic one-page site)
    ...splitList(pick(fields, /^Website Pages$/i)),
  ];
  return {
    key,
    summary: pick(fields, /^Summary$/i),
    url: key ? `https://tekmetric.atlassian.net/browse/${key}` : "",
    shopName: pick(fields, /^Name of Shop$/i, /^Shop Name$/i) || pick(fields, /^Summary$/i).split(" - ")[0],
    type: t.type,
    typeLabel: t.type ? TYPE_LABEL[t.type] : pick(fields, /^Website Type$/i),
    templateNumber: t.templateNumber,
    template: t.template,
    pages: [...new Set(pages)],
    previewUrl: httpOnly(pick(fields, /^Site Preview Link$/i)),
    liveUrl: httpOnly(pick(fields, /^Live Site URL$/i)),
    tekmetricId: pick(fields, /^Tekmetric ID$/i),
    created: pick(fields, /^Created$/i),
    activity,
  };
}

// ---------- new Jira form: "Duda Payload" (JSON) ----------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "");
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const t12 = (hhmm: string) => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  const h = Number(m[1]), mi = m[2];
  return `${h % 12 || 12}:${mi} ${h < 12 ? "AM" : "PM"}`;
};
/** {"mon":{"open":"09:00","close":"17:00"},…,"sat":{"closed":true}} → "Mon-Fri 9:00 AM - 5:00 PM; Sat-Sun Closed" */
export function weeklyToText(weekly: unknown): string {
  if (!isObj(weekly)) return "";
  const slot = (d: string) => {
    const v = weekly[d];
    if (!isObj(v)) return "";
    if (v.closed === true) return "Closed";
    const o = str(v.open), c = str(v.close);
    return o && c ? `${t12(o)} - ${t12(c)}` : "";
  };
  const parts: string[] = [];
  for (let i = 0; i < 7; ) {
    const s = slot(DAYS[i]);
    if (!s) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && slot(DAYS[j + 1]) === s) j++;
    parts.push(`${DAY_NAME[DAYS[i]]}${j > i ? `-${DAY_NAME[DAYS[j]]}` : ""} ${s}`);
    i = j + 1;
  }
  return parts.join("; ");
}

/** What each "differentiators" key means in the Data Collection (only clear matches; everything else is kept as a note). */
const DIFF_FIELDS: [RegExp, string][] = [
  [/financ/i, "Financing"], [/warrant|guarantee/i, "Warranty"], [/amenit|benefit|perk/i, "Amenities"], [/coupon|special|promo|discount|offer/i, "Coupons"],
  [/certif|affiliat|ase\b|association/i, "List any other affiliations"], [/about|story|history/i, "About Us"], [/faq/i, "FAQ"],
];
const SECTION_LABEL: Record<string, string> = {
  services: "Services Offered", vehicles: "Vehicles You Work On", financing: "Financing Options", coupons: "Coupons/Specials", specials: "Coupons/Specials",
  warranty: "Warranty", reviews: "Reviews / Testimonials", "about-us": "About Us", about: "About Us", "contact-hours": "Contact / Hours", careers: "Careers/Job Opportunities", faq: "FAQ",
};

/**
 * The new Jira form puts the submission in a JSON "Duda Payload" field. Fill every Data Collection input that the
 * classic columns don't already have from it (the classic columns win when both exist — they come from the same form).
 * Payload details that don't match a known field are kept in "Other Payload Details" so nothing is lost.
 */
export function applyPayload(fields: JiraFields) {
  const raw = (fields["Duda Payload"] || []).join("\n").trim();
  if (!raw || raw.length > 300_000) return;
  let p: Obj;
  try { const j = JSON.parse(raw); if (!isObj(j)) return; p = j; } catch { fields["Payload Problem"] = ["The Duda Payload in Jira isn't valid JSON — only the classic Jira fields were used."]; return; }
  const set = (k: string, v: string) => { if (v && !(fields[k] || []).some((x) => x.trim())) fields[k] = [v]; };
  const used = new Set<string>();
  const take = (path: string, v: unknown) => { used.add(path); return v; };

  const identity = isObj(p.identity) ? p.identity : {};
  set("Name of Shop", str(take("identity.business_name", identity.business_name)));
  const contact = isObj(p.contact) ? p.contact : {};
  const a = isObj(contact.address) ? contact.address : {};
  used.add("contact.address");
  const cityLine = [str(a.city), [str(a.state), str(a.postal_code)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  set("Shop Address", [str(a.street), cityLine].filter(Boolean).join(", "));
  set("Shop Phone Number", str(take("contact.phone_primary", contact.phone_primary)).replace(/^\+1(?=\d{10}$)/, ""));
  set("Public Email", str(take("contact.email_public", contact.email_public)));
  const hours = isObj(p.hours) ? p.hours : {};
  set("Shop Hours", weeklyToText(take("hours.weekly", hours.weekly)));

  const services = Array.isArray(p.services) ? p.services.map((x) => (isObj(x) ? str(x.name) : str(x))).filter(Boolean) : [];
  used.add("services");
  set("Primary Services", services.join("\n"));
  const featured = Array.isArray(p.services) ? p.services.filter((x) => isObj(x) && x.featured === true).map((x) => str((x as Obj).name)).filter(Boolean) : [];
  if (featured.length && featured.length < services.length) set("Featured Services", featured.join(", "));

  const veh = Array.isArray(p.vehicles_serviced) ? p.vehicles_serviced.map(str).filter(Boolean) : [];
  used.add("vehicles_serviced");
  set("Vehicles Serviced (Makes)", veh.join(", "));
  const vehNot = Array.isArray(p.vehicles_not_serviced) ? p.vehicles_not_serviced.map(str).filter(Boolean) : [];
  if (vehNot.length) { used.add("vehicles_not_serviced"); set("Vehicles Not Serviced", vehNot.join(", ")); set("Are There Any Types Of Vehicles You Do Not Service?", "Yes"); }

  const other: string[] = [];
  const diff = isObj(p.differentiators) ? p.differentiators : {};
  used.add("differentiators");
  for (const [k, v] of Object.entries(diff)) {
    const text = Array.isArray(v) ? v.map(str).filter(Boolean).join("\n") : isObj(v) ? JSON.stringify(v) : str(v);
    if (!text) continue;
    const target = DIFF_FIELDS.find(([re]) => re.test(k))?.[1];
    if (target) set(target, text); else other.push(`${k.replace(/_/g, " ")}: ${text}`);
  }

  const social = isObj(p.social) ? p.social : {};
  used.add("social");
  const gbp = str(social.google_business_profile_url) || str(social.gbp) || str(social.google);
  set("GBP Link", gbp);
  const links = Object.entries(social).filter(([k]) => !/google|gbp/i.test(k)).map(([k, v]) => (str(v) ? `${k.replace(/_/g, " ")}: ${str(v)}` : "")).filter(Boolean);
  set("Social Links", [gbp ? `Google Business Profile: ${gbp}` : "", ...links].filter(Boolean).join("\n"));

  const site = isObj(p.site_structure) ? p.site_structure : {};
  used.add("site_structure");
  const sections = Array.isArray(site.sections) ? site.sections.map(str).filter(Boolean).map((s) => { const k = s.replace(/^other:/i, "").toLowerCase(); return SECTION_LABEL[k] || k.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()); }) : [];
  set("Website Pages", sections.join(", "));

  const tpl = isObj(p.template) ? p.template : {};
  used.add("template");
  set("Design Selection", str(tpl.template_name));
  const integ = isObj(p.integrations) ? p.integrations : {};
  used.add("integrations");
  set("Tekmetric ID", str(integ.tekmetric_shop_id));
  const internal = isObj(p.internal) ? p.internal : {};
  used.add("internal");
  set("Primary Contact Email", str(internal.primary_contact_email));
  set("Instructions", str(internal.special_instructions));
  for (const [k, v] of Object.entries(internal)) if (!["primary_contact_email", "special_instructions"].includes(k) && str(v)) other.push(`${k.replace(/_/g, " ")}: ${str(v)}`);

  // anything else at the top level (e.g. a website or about text added to the form later) — kept, never dropped
  for (const [k, v] of Object.entries(p)) {
    if (used.has(k) || ["identity", "contact", "hours"].includes(k)) continue;
    const text = isObj(v) || Array.isArray(v) ? JSON.stringify(v).slice(0, 600) : str(v);
    if (text) other.push(`${k.replace(/_/g, " ")}: ${text}`);
  }
  if (other.length) set("Other Payload Details", other.join("\n"));
}

/** New form's Description: "*Existing site:* no" / "*Existing site:* yes https://…" → the classic Existing Website fields. */
export function applyDescription(fields: JiraFields) {
  const d = (fields["Description"] || []).join("\n");
  const m = d.match(/\*?Existing site:\*?\s*([^\n]*)/i);
  if (!m) return;
  const val = m[1].trim();
  const url = val.match(/https?:\/\/\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/i)?.[0] || "";
  if (!(fields["Existing Website"] || []).length) fields["Existing Website"] = [url || /^y/i.test(val) ? "Yes, I currently have a website." : /^no/i.test(val) ? "No" : val];
  if (url && !(fields["Current Website"] || []).length) fields["Current Website"] = [url];
}
