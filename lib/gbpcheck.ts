import { all, one, run } from "./db";
import { mapsSearch, type Place } from "./search";
import { nameSimilarity } from "./research";
import { registrable, shopNameFromSite } from "./health";
import { FLAG_LABEL } from "./health";

/**
 * "Does the shop's Google Business Profile link to this website?" — one Maps lookup per site (uses Maps search credits),
 * guided by what the homepage shows (Maps link, phone, address). Results are kept for 30 days.
 */

export type GbpStatus = "ok" | "other" | "none" | "not_found" | "error";
export type GbpResult = { status: GbpStatus; website?: string; title?: string; address?: string; phone?: string; cid?: string; placeId?: string; matchedBy?: string; query?: string; provider?: string; error?: string };
export const GBP_LABEL: Record<GbpStatus, string> = {
  ok: "GBP links to this website", other: "GBP links to a different website", none: "GBP has no website link", not_found: "Couldn't find the GBP", error: "GBP check failed",
};

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const hostOf = (u: string) => { try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase(); } catch { return ""; } };

/** Which search result is this shop? Same Maps ID as the homepage's map link > same phone > same street number > similar name. */
export function pickPlace(places: Place[], shop: string, hints: { phone?: string; address?: string; gbp?: { cid: string; placeId: string } }): { place: Place; by: string } | null {
  const byId = places.find((p) => (hints.gbp?.cid && p.cid === hints.gbp.cid) || (hints.gbp?.placeId && p.placeId === hints.gbp.placeId));
  if (byId) return { place: byId, by: "the map link on their website" };
  const byPhone = hints.phone ? places.find((p) => digits(p.phone) === hints.phone) : undefined;
  if (byPhone) return { place: byPhone, by: "phone number" };
  const num = hints.address?.match(/^\d+/)?.[0];
  const byAddr = num ? places.find((p) => p.address.startsWith(num + " ") && nameSimilarity(shop, p.title) >= 0.3) : undefined;
  if (byAddr) return { place: byAddr, by: "street address" };
  const byName = places.find((p) => nameSimilarity(shop, p.title) >= 0.6);
  return byName ? { place: byName, by: "name (double-check)" } : null;
}

export function compareWebsite(gbpWebsite: string, domain: string): GbpStatus {
  if (!gbpWebsite.trim()) return "none";
  const a = registrable(hostOf(gbpWebsite)), b = registrable(domain);
  return a && a === b ? "ok" : "other";
}

export async function checkGbp(id: number): Promise<GbpResult> {
  const s = await one<{ site_name: string; domain: string; health_json: string | null; gbp_json: string | null }>("SELECT site_name, domain, health_json, gbp_json FROM websites WHERE id = ?", [id]);
  if (!s) throw new Error("Website not found");
  const info = s.health_json ? JSON.parse(s.health_json) : {};
  const hints = (info.page || {}) as { phone?: string; address?: string; gbp?: { cid: string; placeId: string; title: string } };
  const shop = shopNameFromSite(s.site_name);
  const query = hints.address ? `${shop} ${hints.address}` : hints.gbp?.title ? `${hints.gbp.title}` : `${shop} ${s.domain}`;
  let r: GbpResult;
  try {
    const found = await mapsSearch(query);
    const hit = pickPlace(found.places, shop, hints);
    r = hit
      ? { status: compareWebsite(hit.place.website, s.domain), website: hit.place.website, title: hit.place.title, address: hit.place.address, phone: hit.place.phone, cid: hit.place.cid, placeId: hit.place.placeId, matchedBy: hit.by, query, provider: found.provider }
      : { status: "not_found", query, provider: found.provider };
  } catch (e) { r = { status: "error", query, error: (e as Error).message.slice(0, 300) }; }
  const prev = s.gbp_json ? (JSON.parse(s.gbp_json) as GbpResult).status : null;
  if (r.status !== "error") {
    await run("UPDATE websites SET gbp_json = ?, gbp_checked_at = datetime('now') WHERE id = ?", [JSON.stringify(r), id]);
    // alert when the GBP starts pointing elsewhere (not on the first check of a site — that shows in the list instead)
    if (prev && prev !== r.status && (r.status === "other" || r.status === "none"))
      await run("INSERT INTO website_events (website_id, kind, health, title, detail) VALUES (?, 'warning', 'ok', ?, ?)",
        [id, FLAG_LABEL[r.status === "other" ? "gbp_other" : "gbp_none"], r.status === "other" ? `GBP "${r.title}" now links to ${r.website}` : `GBP "${r.title}" has no website link`]);
  } else await run("UPDATE websites SET gbp_json = ? WHERE id = ?", [JSON.stringify(r), id]);
  return r;
}

/** Checks the GBP of live sites that were never checked (then the oldest), until `limit` or the time budget runs out. */
export async function checkGbpBatch(limit: number, budgetMs = 240_000): Promise<{ done: number; remaining: number; stoppedBy?: string }> {
  const started = Date.now();
  const due = () => all<{ id: number }>(`SELECT id FROM websites WHERE health = 'ok' AND (gbp_checked_at IS NULL OR gbp_checked_at < datetime('now', '-30 days'))
    ORDER BY gbp_checked_at IS NOT NULL, gbp_checked_at, id LIMIT ?`, [limit]);
  let done = 0, stoppedBy: string | undefined;
  for (const { id } of await due()) {
    if (Date.now() - started > budgetMs) { stoppedBy = "time"; break; }
    const r = await checkGbp(id);
    done++;
    if (r.status === "error" && /credit|limit|quota|No Maps search key|402|429/i.test(r.error || "")) { stoppedBy = r.error; break; }
  }
  const remaining = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM websites WHERE health = 'ok' AND (gbp_checked_at IS NULL OR gbp_checked_at < datetime('now', '-30 days'))`))?.n || 0;
  return { done, remaining, stoppedBy };
}
