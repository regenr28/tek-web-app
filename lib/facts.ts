/** "Truthy" facts about a client, sourced from the Jira export (PDF/XLSX/CSV). */

export type Location = { label?: string; street: string; city: string; state: string; zip: string; phone?: string };
export type DayHours = { day: Day; value: string }; // value like "8:00 AM - 5:00 PM" or "Closed"
export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Facts = {
  businessName: string;
  altNames: string[]; // accepted variants (e.g. "Joe's Auto")
  phones: string[];
  emails: string[];
  locations: Location[];
  hours: DayHours[];
  websiteDomain: string;
  socials: { platform: string; url: string }[];
  services: string[];
  citiesServed: string[];
  custom: { key: string; value: string }[];
  notes: string;
};

export const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABEL: Record<Day, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function emptyFacts(): Facts {
  return {
    businessName: "", altNames: [], phones: [], emails: [], locations: [], hours: [],
    websiteDomain: "", socials: [], services: [], citiesServed: [], custom: [], notes: "",
  };
}

export function normalizeFacts(f: Partial<Facts> | null | undefined): Facts {
  const e = emptyFacts();
  if (!f) return e;
  return {
    ...e,
    ...f,
    altNames: arr(f.altNames), phones: arr(f.phones), emails: arr(f.emails),
    locations: Array.isArray(f.locations) ? f.locations : [],
    hours: Array.isArray(f.hours) ? f.hours : [],
    socials: Array.isArray(f.socials) ? f.socials : [],
    services: arr(f.services), citiesServed: arr(f.citiesServed),
    custom: Array.isArray(f.custom) ? f.custom : [],
  };
}
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

// ---------- normalizers shared with the rule engine ----------

export const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

export const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const ZIP_RE = /\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/g;
const STREET_SUFFIX = "(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Pkwy|Parkway|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail|Ter|Terrace|Pike|Loop|Sq|Square|Row|Run|Pass|Expy|Expressway|Fwy|Freeway)";
export const STREET_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w'.-]*\\s+){1,4}${STREET_SUFFIX}\\b\\.?(?:\\s*(?:#|Suite|Ste\\.?|Unit)\\s*[\\w-]+)?`, "g");

export const normStreet = (s: string) =>
  s.toLowerCase()
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd").replace(/\bdrive\b/g, "dr").replace(/\blane\b/g, "ln")
    .replace(/\bhighway\b/g, "hwy").replace(/\bparkway\b/g, "pkwy").replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl").replace(/\bsuite\b/g, "ste").replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s").replace(/\beast\b/g, "e").replace(/\bwest\b/g, "w")
    .replace(/[^a-z0-9]/g, "");

export function formatPhone(d: string) {
  const x = digits(d);
  return x.length === 10 ? `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}` : d;
}

// ---------- heuristic extraction from Jira text ----------

const LABELS: { key: string; re: RegExp }[] = [
  { key: "businessName", re: /^(?:business|company|shop|dba|legal|client|account|store)\s*(?:name)?\s*$/i },
  { key: "phone", re: /phone|tel|mobile|cell|contact number|call/i },
  { key: "email", re: /e-?mail/i },
  { key: "address", re: /address|location|street/i },
  { key: "city", re: /^city$/i },
  { key: "state", re: /^state|province$/i },
  { key: "zip", re: /zip|postal/i },
  { key: "hours", re: /hours|schedule|open/i },
  { key: "website", re: /website|domain|url/i },
  { key: "cities", re: /cities|service area|areas? served|nearby/i },
  { key: "services", re: /services?|specialt/i },
  { key: "social", re: /facebook|instagram|yelp|google|twitter|x\.com|linkedin|youtube|tiktok|social/i },
];

/** Turn free text + optional [label, value] rows into best-guess facts. The user reviews/edits after. */
export function extractFacts(text: string, rows: string[][] = []): Facts {
  const f = emptyFacts();
  const pairs: [string, string][] = [];

  for (const r of rows) {
    const cells = r.map((c) => String(c ?? "").trim()).filter(Boolean);
    if (cells.length >= 2) pairs.push([cells[0], cells.slice(1).join(" ")]);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /&()#-]{1,40}?)\s*[:\-–]\s+(.+)$/);
    if (m) pairs.push([m[1].trim(), m[2].trim()]);
  }

  let city = "", state = "", zip = "", street = "";
  for (const [rawLabel, value] of pairs) {
    const label = rawLabel.replace(/^custom\s*field\s*\((.*)\)$/i, "$1").trim();
    const k = LABELS.find((l) => l.re.test(label))?.key;
    if (!k) { if (value.length < 200) f.custom.push({ key: label, value }); continue; }
    if (k === "businessName" && !f.businessName) f.businessName = value;
    else if (k === "city") city = value;
    else if (k === "state") state = value;
    else if (k === "zip") zip = value;
    else if (k === "address" && !street) street = value;
    else if (k === "services") f.services.push(...splitList(value));
    else if (k === "cities") f.citiesServed.push(...splitList(value));
    else if (k === "website" && !f.websiteDomain) f.websiteDomain = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }

  const blob = text + "\n" + pairs.map((p) => p.join(": ")).join("\n");
  for (const m of blob.matchAll(PHONE_RE)) {
    const p = formatPhone(m[0]);
    if (!f.phones.includes(p)) f.phones.push(p);
  }
  for (const m of blob.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (!f.emails.includes(e)) f.emails.push(e);
  }
  for (const m of blob.matchAll(/https?:\/\/(?:www\.)?(facebook|instagram|yelp|twitter|x|linkedin|youtube|tiktok|google|g)\.[a-z./]+[^\s"'<>)]*/gi)) {
    const platform = m[1].toLowerCase() === "g" ? "google" : m[1].toLowerCase();
    if (!f.socials.some((s) => s.url === m[0])) f.socials.push({ platform, url: m[0] });
  }

  // Address: "123 Main St, Springfield, IL 62701"
  const FULL_ADDR = /(\d{1,6}\s[^,\n|]{3,60}),\s*([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+(\d{5})/;
  const full = (street.match(FULL_ADDR) || blob.match(FULL_ADDR));
  if (full) f.locations.push({ street: full[1].trim(), city: full[2].trim(), state: full[3], zip: full[4] });
  else if (street || zip) {
    const z = street.match(/([A-Za-z .'-]+),?\s+([A-Z]{2})\s+(\d{5})/);
    f.locations.push({ street: street.split(",")[0].trim(), city: city || z?.[1]?.trim() || "", state: state || z?.[2] || "", zip: zip || z?.[3] || "" });
  }

  f.hours = parseHours(blob);
  f.services = uniq(f.services);
  f.citiesServed = uniq(f.citiesServed);
  f.notes = "";
  return f;
}

const splitList = (v: string) => v.split(/[,;\n•|]/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 80);
const uniq = (a: string[]) => [...new Set(a)];

// ---------- hours ----------

const DAY_ALIASES: [RegExp, Day][] = [
  [/^mon/i, "mon"], [/^tue/i, "tue"], [/^wed/i, "wed"], [/^thu/i, "thu"], [/^fri/i, "fri"], [/^sat/i, "sat"], [/^sun/i, "sun"],
];
const dayOf = (s: string): Day | null => DAY_ALIASES.find(([re]) => re.test(s.trim()))?.[1] ?? null;
const DAY_WORD = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?";
const TIME = "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)";
const HOURS_RE = new RegExp(
  `(${DAY_WORD})(?:\\s*(?:-|–|—|to|thru|through)\\s*(${DAY_WORD}))?\\s*[:,]?\\s*(?:(${TIME})\\s*(?:-|–|—|to)\\s*(${TIME})|(closed|by appointment(?: only)?|24 hours))`,
  "gi"
);

export function normTime(t: string) {
  const m = t.toLowerCase().replace(/\./g, "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (!m) return t.trim();
  return `${Number(m[1])}:${m[2] ?? "00"} ${m[3].toUpperCase()}`;
}

/** Returns one entry per day found. Later mentions don't override earlier ones. */
export function parseHours(text: string): DayHours[] {
  const out = new Map<Day, string>();
  for (const m of text.matchAll(HOURS_RE)) {
    const d1 = dayOf(m[1]); if (!d1) continue;
    const d2 = m[2] ? dayOf(m[2]) : d1; if (!d2) continue;
    const value = m[5] ? cap(m[5]) : `${normTime(m[3])} - ${normTime(m[4])}`;
    const i1 = DAYS.indexOf(d1), i2 = DAYS.indexOf(d2);
    const span = i2 >= i1 ? DAYS.slice(i1, i2 + 1) : [...DAYS.slice(i1), ...DAYS.slice(0, i2 + 1)];
    for (const d of span) if (!out.has(d)) out.set(d, value);
  }
  return DAYS.filter((d) => out.has(d)).map((d) => ({ day: d, value: out.get(d)! }));
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function normHoursValue(v: string) {
  const m = v.match(new RegExp(`(${TIME})\\s*(?:-|–|—|to)\\s*(${TIME})`, "i"));
  if (m) return `${normTime(m[1])} - ${normTime(m[2])}`;
  return v.trim().toLowerCase();
}
