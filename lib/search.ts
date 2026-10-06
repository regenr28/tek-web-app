import { one, run } from "./db";
import { encrypt, decrypt, mask } from "./secrets";
import { safeFetch } from "./net";
import { groqBrowserSearch, parseJson } from "./ai";

/**
 * Web + Google Maps search for Data Collection research. Every provider here has a free plan with no credit card:
 *  Maps (Place ID + CID): OpenWeb Ninja 500/mo · SerpApi 250/mo · Apify ~1,250 places/mo · HasData ~100/mo · Serper 2,500 one-time
 *  Web only: Tavily 1,000/mo · Linkup (free monthly credit) · Exa (free monthly credit)
 *  Plus Groq's AI browser search (uses the Groq AI key) — tried FIRST for web/social searches so the
 *  Maps credits are saved for finding the Google Business Profile.
 * Providers are tried in order; one that's out of credits rests and the next is used.
 */

export type SearchProviderId = "openwebninja" | "serpapi" | "apify" | "hasdata" | "serper" | "tavily" | "linkup" | "exa";
export const SEARCH_IDS: SearchProviderId[] = ["openwebninja", "serpapi", "apify", "hasdata", "serper", "tavily", "linkup", "exa"];
export const SEARCH_INFO: Record<SearchProviderId, { label: string; env: string; signup: string; note: string; maps: boolean; web: boolean }> = {
  openwebninja: { label: "OpenWeb Ninja", env: "OPENWEBNINJA_API_KEY", signup: "https://www.openwebninja.com", note: "500 businesses free every month (Local Business Data API). Finds the GBP with Place ID + CID.", maps: true, web: false },
  serpapi: { label: "SerpApi", env: "SERPAPI_API_KEY", signup: "https://serpapi.com/users/sign_up", note: "250 free searches every month. Finds the GBP (Place ID + CID) and does Google web search.", maps: true, web: true },
  apify: { label: "Apify", env: "APIFY_API_TOKEN", signup: "https://console.apify.com/sign-up", note: "$5 free usage every month ≈ 1,250 GBP lookups (Google Maps Scraper). Slower: 20–60 s per lookup.", maps: true, web: false },
  hasdata: { label: "HasData", env: "HASDATA_API_KEY", signup: "https://app.hasdata.com/sign-up", note: "1,000 free credits every month ≈ 100 Maps searches. Gives the Place ID (no CID).", maps: true, web: false },
  serper: { label: "Serper", env: "SERPER_API_KEY", signup: "https://serper.dev/signup", note: "2,500 free searches (one-time). Finds Place ID + CID and does Google web search.", maps: true, web: true },
  tavily: { label: "Tavily", env: "TAVILY_API_KEY", signup: "https://app.tavily.com", note: "1,000 free credits every month. Web search only.", maps: false, web: true },
  linkup: { label: "Linkup", env: "LINKUP_API_KEY", signup: "https://app.linkup.so", note: "Free monthly credit. Web search only.", maps: false, web: true },
  exa: { label: "Exa", env: "EXA_API_KEY", signup: "https://dashboard.exa.ai", note: "Free monthly credit. Web search only.", maps: false, web: true },
};

type Cfg = { enabled: boolean; keyEnc?: string };
type Settings = { order: SearchProviderId[]; providers: Record<SearchProviderId, Cfg>; aiFirst: boolean };

async function getSettings(): Promise<Settings> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'search'");
  const saved = row ? (JSON.parse(row.value) as Partial<Settings>) : {};
  const providers = Object.fromEntries(SEARCH_IDS.map((id) => [id, { enabled: true, ...(saved.providers?.[id] || {}) }])) as Settings["providers"];
  const order = [...(saved.order || []).filter((x) => SEARCH_IDS.includes(x)), ...SEARCH_IDS.filter((x) => !(saved.order || []).includes(x))];
  return { order, providers, aiFirst: saved.aiFirst ?? true };
}
const keyOf = (id: SearchProviderId, c: Cfg) => (c.keyEnc ? decrypt(c.keyEnc) : "") || process.env[SEARCH_INFO[id].env] || "";

export async function publicSearchSettings() {
  const s = await getSettings();
  const month = new Date().toISOString().slice(0, 7);
  const usage = Object.fromEntries(await Promise.all(SEARCH_IDS.map(async (id) => [id, (await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [`usage:${id}:${month}`]))?.count || 0])));
  return {
    order: s.order, aiFirst: s.aiFirst,
    providers: Object.fromEntries(s.order.map((id) => {
      const k = keyOf(id, s.providers[id]);
      return [id, { enabled: s.providers[id].enabled, hasKey: !!k, keyHint: mask(k), keySource: s.providers[id].keyEnc ? "settings" : k ? "env" : "none", usedThisMonth: usage[id], ...SEARCH_INFO[id] }];
    })),
  };
}

export async function saveSearchSettings(input: { order?: SearchProviderId[]; aiFirst?: boolean; providers?: Partial<Record<SearchProviderId, { enabled?: boolean; apiKey?: string; clearKey?: boolean }>> }) {
  const s = await getSettings();
  if (typeof input.aiFirst === "boolean") s.aiFirst = input.aiFirst;
  if (input.order) s.order = [...input.order, ...SEARCH_IDS.filter((x) => !input.order!.includes(x))];
  for (const [id, p] of Object.entries(input.providers || {}) as [SearchProviderId, { enabled?: boolean; apiKey?: string; clearKey?: boolean }][]) {
    const c = s.providers[id];
    if (!c || !p) continue;
    if (typeof p.enabled === "boolean") c.enabled = p.enabled;
    if (p.clearKey) delete c.keyEnc;
    if (p.apiKey?.trim()) c.keyEnc = encrypt(p.apiKey.trim());
  }
  await run("INSERT INTO settings (key, value) VALUES ('search', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
}

async function countUse(id: string) {
  const month = new Date().toISOString().slice(0, 7);
  await run(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, 0, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1`, [`usage:${id}:${month}`]).catch(() => {});
}

const cooling = new Map<string, number>();

async function getJ(url: string, headers: Record<string, string> = {}, body?: unknown, timeoutMs = 25000) {
  const r = await safeFetch(url, {
    hosts: ["serpapi.com", "google.serper.dev", "api.tavily.com", "api.openwebninja.com", "api.apify.com", "api.hasdata.com", "api.linkup.so", "api.exa.ai"], method: body ? "POST" : "GET",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, timeoutMs, maxBytes: 5 * 1024 * 1024,
  });
  const raw = r.text() || "{}";
  let j;
  try { j = JSON.parse(raw); } catch { throw Object.assign(new Error(`HTTP ${r.status}: ${raw.replace(/\s+/g, " ").slice(0, 140)}`), { status: r.status }); }
  if (r.status >= 400 || j?.error) throw Object.assign(new Error(String(j?.error || j?.message || `HTTP ${r.status}`).slice(0, 160)), { status: r.status });
  return j;
}

async function providers(kind: "maps" | "web", only?: SearchProviderId) {
  const s = await getSettings();
  if (only) { const k = keyOf(only, s.providers[only]); return k && SEARCH_INFO[only][kind] ? [{ id: only, key: k }] : []; }
  const ok = s.order.filter((id) => s.providers[id].enabled && keyOf(id, s.providers[id]) && SEARCH_INFO[id][kind] && !((cooling.get(id) || 0) > Date.now()));
  // Web searches use web-only providers first, so the Maps-capable credits are kept for GBP lookups
  const list = kind === "web" ? [...ok.filter((id) => !SEARCH_INFO[id].maps), ...ok.filter((id) => SEARCH_INFO[id].maps)] : ok;
  return list.map((id) => ({ id, key: keyOf(id, s.providers[id]) }));
}

export async function searchAvailable() {
  return { web: (await providers("web")).length > 0, maps: (await providers("maps")).length > 0 };
}

// ---------- Google Maps (GBP) ----------

export type Place = {
  title: string; address: string; phone: string; website: string; rating: number | null; reviews: number | null;
  placeId: string; cid: string; type: string; hours: Record<string, string>; source: string;
  /** Google "feature id" 0x…:0x… (needed by some review APIs) */
  fid?: string;
};

const cidFromDataId = (dataId: string) => { const h = dataId.match(/:0x([0-9a-f]+)/i)?.[1]; return h ? BigInt("0x" + h).toString() : ""; };

function hoursMap(h: unknown): Record<string, string> {
  if (!h || typeof h !== "object") return {};
  if (Array.isArray(h)) {
    // [{ day: "Monday", hours: "8 AM to 5 PM" }] (Apify) · [{ day, time }] (HasData) · [{ monday: "..." }] (SerpApi)
    return Object.assign({}, ...h.map((x) => {
      if (!x || typeof x !== "object") return {};
      const o = x as Record<string, unknown>;
      if (typeof o.day === "string") return { [o.day.toLowerCase()]: String(o.hours ?? o.time ?? "") };
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
    }));
  }
  return Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : null);

export async function mapsSearch(query: string, only?: SearchProviderId): Promise<{ places: Place[]; provider: string }> {
  const errors: string[] = [];
  for (const p of await providers("maps", only)) {
    try {
      let places: Place[] = [];
      if (p.id === "openwebninja") {
        const j = await getJ(`https://api.openwebninja.com/local-business-data/search?query=${encodeURIComponent(query)}&limit=5&region=us&language=en`, { "x-api-key": p.key });
        places = (Array.isArray(j.data) ? j.data : []).slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.name || ""), address: String(x.full_address || x.address || ""), phone: String(x.phone_number || ""), website: String(x.website || ""),
          rating: num(x.rating), reviews: num(x.review_count), placeId: String(x.place_id || ""),
          cid: String(x.cid || "") || cidFromDataId(String(x.google_id || "")), type: String(x.type || (Array.isArray(x.subtypes) ? x.subtypes.join(", ") : "")),
          hours: hoursMap(x.working_hours), source: "OpenWeb Ninja", fid: String(x.google_id || x.business_id || ""),
        }));
      } else if (p.id === "serpapi") {
        const j = await getJ(`https://serpapi.com/search.json?engine=google_maps&type=search&hl=en&gl=us&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(p.key)}`);
        const list = j.place_results ? [j.place_results] : j.local_results || [];
        places = list.slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phone || ""), website: String(x.website || ""),
          rating: typeof x.rating === "number" ? x.rating : null, reviews: typeof x.reviews === "number" ? x.reviews : null,
          placeId: String(x.place_id || ""), cid: String(x.data_cid || "") || cidFromDataId(String(x.data_id || "")),
          type: String(x.type || (Array.isArray(x.types) ? x.types.join(", ") : "")), hours: hoursMap(x.operating_hours || (x.hours as unknown)), source: "SerpApi", fid: String(x.data_id || ""),
        }));
      } else if (p.id === "apify") {
        // Google Maps Scraper actor, run synchronously (one search, no reviews/images, to keep it quick and cheap)
        const j = await getJ("https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?timeout=150&format=json",
          { Authorization: `Bearer ${p.key}` },
          { searchStringsArray: [query], maxCrawledPlacesPerSearch: 3, language: "en", countryCode: "us", maxReviews: 0, maxImages: 0, scrapePlaceDetailPage: false, skipClosedPlaces: false },
          170_000);
        places = (Array.isArray(j) ? j : []).slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phone || x.phoneUnformatted || ""), website: String(x.website || ""),
          rating: num(x.totalScore), reviews: num(x.reviewsCount), placeId: String(x.placeId || ""),
          cid: String(x.cid || "") || cidFromDataId(String(x.fid || "")), type: String(x.categoryName || (Array.isArray(x.categories) ? x.categories.join(", ") : "")),
          hours: hoursMap(x.openingHours), source: "Apify", fid: String(x.fid || ""),
        }));
      } else if (p.id === "hasdata") {
        const j = await getJ(`https://api.hasdata.com/scrape/google-maps/search?q=${encodeURIComponent(query)}&gl=us&hl=en`, { "x-api-key": p.key }, undefined, 40000);
        const list = j.placeResults ? [j.placeResults] : j.localResults || [];
        places = list.slice(0, 5).map((x: Record<string, any>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phone || ""), website: String(x.website || ""),
          rating: num(x.rating), reviews: num(x.reviews), placeId: String(x.placeId || ""),
          cid: String(x.cid || "") || cidFromDataId(String(x.dataId || x.data_id || "")), type: String(x.type || ""),
          hours: hoursMap(x.workingHours?.days || x.workingHours), source: "HasData", fid: String(x.dataId || x.data_id || ""),
        }));
      } else if (p.id === "serper") {
        const j = await getJ("https://google.serper.dev/maps", { "X-API-KEY": p.key }, { q: query, gl: "us", hl: "en" });
        places = (j.places || []).slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phoneNumber || ""), website: String(x.website || ""),
          rating: typeof x.rating === "number" ? x.rating : null, reviews: typeof x.ratingCount === "number" ? x.ratingCount : null,
          placeId: String(x.placeId || ""), cid: String(x.cid || ""), type: String(x.type || (Array.isArray(x.types) ? x.types.join(", ") : "")),
          hours: hoursMap(x.openingHours), source: "Serper", fid: String(x.fid || x.dataId || ""),
        }));
      }
      await countUse(p.id);
      return { places, provider: SEARCH_INFO[p.id].label };
    } catch (e) {
      errors.push(`${SEARCH_INFO[p.id].label}: ${(e as Error).message}`);
      if (!only) cooling.set(p.id, Date.now() + restMs(e));
    }
  }
  throw new Error(errors.length ? errors.join(" · ") : only ? "Add this provider's API key first." : "No Maps search key — add a free key (OpenWeb Ninja, SerpApi, Apify, HasData or Serper) in Settings → Research.");
}

const restMs = (e: unknown) => ((e as { status?: number }).status === 429 || (e as { status?: number }).status === 402 || /limit|credit|quota|run out|exceed|insufficient|usage/i.test((e as Error).message) ? 3_600_000 : 30_000);

// ---------- GBP reviews ----------

export type Review = { text: string; rating: number; author: string; date: string };

const str = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { original?: unknown }).original === "string" ? String((v as { original: string }).original) : "");
function toReviews(list: unknown): Review[] {
  if (!Array.isArray(list)) return [];
  return list.map((x: any) => ({
    text: str(x?.extracted_snippet?.original) || str(x?.snippet) || str(x?.text) || str(x?.review_text) || str(x?.textTranslated) || str(x?.content) || str(x?.body),
    rating: Number(x?.rating ?? x?.stars ?? x?.review_rating ?? x?.score ?? 0) || 0,
    author: str(x?.user?.name) || str(x?.author_name) || str(x?.name) || str(x?.author) || str(x?.reviewer?.name),
    date: str(x?.iso_date) || str(x?.date) || str(x?.review_datetime_utc) || str(x?.publishedAtDate) || str(x?.isoDate),
  })).filter((r) => r.text.trim().length > 0);
}

/** Pulls the most relevant Google reviews for one listing (1–2 searches). Tries the Maps providers in order. */
export async function placeReviews(ids: { placeId?: string; cid?: string; fid?: string }): Promise<{ reviews: Review[]; provider: string }> {
  const errors: string[] = [];
  const { placeId = "", cid = "", fid = "" } = ids;
  for (const p of await providers("maps")) {
    try {
      let reviews: Review[] = [];
      if (p.id === "openwebninja") {
        const bid = fid || placeId; if (!bid) continue;
        const j = await getJ(`https://api.openwebninja.com/local-business-data/business-reviews?business_id=${encodeURIComponent(bid)}&limit=40&sort_by=most_relevant&region=us&language=en`, { "x-api-key": p.key });
        const d = j.data;
        reviews = toReviews(Array.isArray(d) ? (d[0]?.reviews ?? d) : d?.reviews);
      } else if (p.id === "serpapi") {
        if (!placeId && !fid) continue;
        const base = `https://serpapi.com/search.json?engine=google_maps_reviews&hl=en&sort_by=qualityScore&${placeId ? `place_id=${encodeURIComponent(placeId)}` : `data_id=${encodeURIComponent(fid)}`}&api_key=${encodeURIComponent(p.key)}`;
        const j = await getJ(base);
        reviews = toReviews(j.reviews);
        if (j.serpapi_pagination?.next_page_token && reviews.length < 20) {
          const j2 = await getJ(`${base}&num=20&next_page_token=${encodeURIComponent(j.serpapi_pagination.next_page_token)}`).catch(() => null);
          if (j2) { reviews.push(...toReviews(j2.reviews)); await countUse(p.id); }
        }
      } else if (p.id === "apify") {
        const url = placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : cid ? `https://maps.google.com/?cid=${cid}` : "";
        if (!url) continue;
        const j = await getJ("https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?timeout=150&format=json",
          { Authorization: `Bearer ${p.key}` },
          { startUrls: [{ url }], maxCrawledPlacesPerSearch: 1, maxReviews: 40, reviewsSort: "mostRelevant", language: "en", maxImages: 0, scrapeReviewsPersonalData: true },
          170_000);
        reviews = toReviews(Array.isArray(j) ? j[0]?.reviews : []);
      } else if (p.id === "hasdata") {
        if (!placeId && !fid) continue;
        const j = await getJ(`https://api.hasdata.com/scrape/google-maps/reviews?${placeId ? `placeId=${encodeURIComponent(placeId)}` : `dataId=${encodeURIComponent(fid)}`}&sortBy=qualityScore&hl=en`, { "x-api-key": p.key }, undefined, 40000);
        reviews = toReviews(j.reviews);
      } else if (p.id === "serper") {
        if (!fid && !cid && !placeId) continue;
        const j = await getJ("https://google.serper.dev/reviews", { "X-API-KEY": p.key }, { ...(fid ? { fid } : {}), ...(cid ? { cid } : {}), ...(placeId ? { placeId } : {}), sortBy: "mostRelevant", gl: "us", hl: "en" });
        reviews = toReviews(j.reviews);
      }
      await countUse(p.id);
      if (reviews.length) return { reviews, provider: SEARCH_INFO[p.id].label };
      errors.push(`${SEARCH_INFO[p.id].label}: no reviews returned`);
    } catch (e) {
      errors.push(`${SEARCH_INFO[p.id].label}: ${(e as Error).message}`);
      cooling.set(p.id, Date.now() + restMs(e));
    }
  }
  throw new Error(errors.length ? errors.join(" · ") : "No Maps key that can read reviews — add OpenWeb Ninja, SerpApi, Apify, HasData or Serper in Settings → Research.");
}

// ---------- Web search ----------

export type WebResult = { title: string; url: string; snippet: string; rating?: number; reviews?: number; ai?: boolean };

async function groqSearch(query: string, num: number): Promise<WebResult[]> {
  const text = await groqBrowserSearch(`Search the web for: ${query}\nReturn ONLY JSON: {"results":[{"title":"","url":"","snippet":""}]} with up to ${num} real result URLs you actually opened or saw in search results. Never guess or build URLs.`);
  const j = parseJson<{ results?: WebResult[] }>(text);
  return (j?.results || []).filter((r) => typeof r?.url === "string" && /^https?:\/\/[^\s"'<>]+$/.test(r.url)).map((r) => ({ title: String(r.title || ""), url: r.url, snippet: String(r.snippet || "").slice(0, 400), ai: true }));
}

export async function webSearch(query: string, num = 10, only?: SearchProviderId): Promise<{ results: WebResult[]; provider: string }> {
  const errors: string[] = [];
  const s = await getSettings();
  // 1) Groq AI browser search first (free, daily limits) — results are marked so they get a "double-check" note
  if (!only && s.aiFirst && !((cooling.get("groq") || 0) > Date.now())) {
    try {
      const results = await groqSearch(query, num);
      if (results.length) return { results, provider: "Groq AI search" };
      errors.push("Groq AI search: no results");
    } catch (e) {
      errors.push(`Groq AI search: ${(e as Error).message.slice(0, 120)}`);
      if (!/No Groq key/.test((e as Error).message)) cooling.set("groq", Date.now() + restMs(e));
    }
  }
  // 2) Search APIs — web-only ones first
  for (const p of await providers("web", only)) {
    try {
      let results: WebResult[] = [];
      if (p.id === "tavily") {
        const j = await getJ("https://api.tavily.com/search", { Authorization: `Bearer ${p.key}` }, { query, max_results: Math.min(num, 10), search_depth: "basic" });
        results = (j.results || []).map((x: Record<string, any>) => ({ title: x.title || "", url: x.url || "", snippet: String(x.content || "").slice(0, 400) }));
      } else if (p.id === "linkup") {
        const j = await getJ("https://api.linkup.so/v1/search", { Authorization: `Bearer ${p.key}` }, { q: query, depth: "standard", outputType: "searchResults" });
        results = (j.results || []).slice(0, num).map((x: Record<string, any>) => ({ title: x.name || x.title || "", url: x.url || "", snippet: String(x.content || "").slice(0, 400) }));
      } else if (p.id === "exa") {
        const j = await getJ("https://api.exa.ai/search", { "x-api-key": p.key }, { query, numResults: Math.min(num, 10), type: "auto", contents: { text: { maxCharacters: 400 } } });
        results = (j.results || []).map((x: Record<string, any>) => ({ title: x.title || "", url: x.url || "", snippet: String(x.text || "").slice(0, 400) }));
      } else if (p.id === "serpapi") {
        const j = await getJ(`https://serpapi.com/search.json?engine=google&hl=en&gl=us&num=${num}&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(p.key)}`);
        results = (j.organic_results || []).map((x: Record<string, any>) => ({
          title: x.title || "", url: x.link || "", snippet: x.snippet || "",
          rating: x.rich_snippet?.top?.detected_extensions?.rating, reviews: x.rich_snippet?.top?.detected_extensions?.reviews,
        }));
      } else if (p.id === "serper") {
        const j = await getJ("https://google.serper.dev/search", { "X-API-KEY": p.key }, { q: query, gl: "us", hl: "en", num });
        results = (j.organic || []).map((x: Record<string, any>) => ({ title: x.title || "", url: x.link || "", snippet: x.snippet || "", rating: x.rating, reviews: x.ratingCount }));
      }
      await countUse(p.id);
      return { results: results.filter((r) => /^https?:\/\//.test(r.url)), provider: SEARCH_INFO[p.id].label };
    } catch (e) {
      errors.push(`${SEARCH_INFO[p.id].label}: ${(e as Error).message}`);
      if (!only) cooling.set(p.id, Date.now() + restMs(e));
    }
  }
  if (only) throw new Error(errors.join(" · ") || "Add this provider's API key first.");
  // 3) Groq as a last resort when "AI first" is off
  if (!s.aiFirst) {
    try {
      const results = await groqSearch(query, num);
      if (results.length) return { results, provider: "Groq AI search" };
    } catch (e) { errors.push(`Groq AI search: ${(e as Error).message.slice(0, 120)}`); }
  }
  throw new Error(errors.join(" · ") || "No web search available — add a Groq AI key, or a free Tavily/Linkup/Exa/SerpApi/Serper key in Settings → Research.");
}

/** Settings → Research "Test": one real search with just this provider (uses 1 credit). */
export async function testSearchProvider(id: SearchProviderId): Promise<string> {
  if (SEARCH_INFO[id].maps) {
    const r = await mapsSearch("Googleplex 1600 Amphitheatre Pkwy Mountain View CA", id);
    const p = r.places[0];
    if (!p) return `${r.provider} answered but returned no places.`;
    return `Works — found "${p.title}"${p.placeId ? ` · Place ID ✓` : " · no Place ID"}${p.cid ? ` · CID ✓` : " · no CID"}`;
  }
  const r = await webSearch("Tekmetric auto repair shop software", 5, id);
  return `Works — ${r.results.length} result(s), e.g. ${r.results[0]?.url || "none"}`;
}
