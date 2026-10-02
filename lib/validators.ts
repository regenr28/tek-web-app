import { z } from "zod";
import { HttpError } from "./security";
import { getPolicy, hostAllowed } from "./policy";
import { resolveDudaUrl } from "./crawl";

export const SITE_STATUSES = ["not_started", "in_progress", "needs_fixes", "fixed", "passed", "published"] as const;

const httpUrl = z.string().trim().max(2000).refine((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } }, "must be a full http(s) link");

/** Preview links must point at an allowed host (Super Admin → Settings → Security). */
export async function assertCrawlable(url: string) {
  if (/my\.duda\.co\/home\/site\//i.test(url)) throw new HttpError(400, "That's the Duda editor link — it needs a login. Paste the preview / share link (…/preview/<site id>?…) or the live site URL instead.");
  const host = new URL(resolveDudaUrl(url)).hostname;
  const p = await getPolicy();
  if (!hostAllowed(host, p.crawlHosts)) throw new HttpError(400, `${host} isn't on the allowed crawl domains. A Super Admin can add it in Settings → Security.`);
}

export const SiteCreate = z.object({
  name: z.string().trim().min(1).max(120),
  preview_url: httpUrl,
  live_url: httpUrl.optional().or(z.literal("")),
  jira_key: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/).optional(),
  assignee_id: z.number().int().positive().nullable().optional(),
});

export const SitePatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  preview_url: httpUrl.optional(),
  live_url: httpUrl.or(z.literal("")).nullable().optional(),
  jira_key: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/).nullable().optional(),
  duda_site_id: z.string().trim().max(60).regex(/^[A-Za-z0-9_-]*$/).nullable().optional(),
  status: z.enum(SITE_STATUSES).optional(),
  assignee_id: z.number().int().positive().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
}).strict();

export const FindingUpdate = z.object({
  status: z.enum(["open", "done", "ignored"]).optional(),
  assignee_id: z.number().int().positive().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
}).strict();

export const BulkFindingUpdate = FindingUpdate.extend({ ids: z.array(z.number().int().positive()).min(1).max(1000) }).strict();

const S = (n: number) => z.string().trim().max(n);
const arr = (n: number, len = 200) => z.array(S(len)).max(n).default([]);
export const FactsSchema = z.object({
  businessName: S(200).default(""),
  altNames: arr(20),
  phones: arr(20, 40),
  emails: arr(20),
  locations: z.array(z.object({ label: S(100).optional(), street: S(200), city: S(100), state: S(40), zip: S(20), phone: S(40).optional() })).max(30).default([]),
  hours: z.array(z.object({ day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), value: S(100) })).max(7).default([]),
  websiteDomain: S(200).default(""),
  socials: z.array(z.object({ platform: S(40), url: S(500) })).max(30).default([]),
  services: arr(100),
  citiesServed: arr(100),
  custom: z.array(z.object({ key: S(100), value: S(1000) })).max(100).default([]),
  notes: S(4000).default(""),
});
