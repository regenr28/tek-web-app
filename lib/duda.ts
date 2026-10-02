/** Optional: only active when DUDA_API_USERNAME / DUDA_API_PASSWORD are set in Vercel env. */
import { emptyFacts, formatPhone, type Facts, type Day } from "./facts";

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
  if (!r.ok) throw new Error(`Duda API ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
