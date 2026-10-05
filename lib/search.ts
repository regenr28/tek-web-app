import { one, run } from "./db";
import { encrypt, decrypt, mask } from "./secrets";
import { safeFetch } from "./net";
import { groqBrowserSearch, parseJson } from "./ai";

/**
 * Web + Google Maps search for Data Collection research. Free tiers, no credit card:
 *  - SerpApi: 250 searches / month (Google, Google Maps with place_id + CID)
 *  - Serper:  2,500 searches one-time (Google, Maps with placeId + cid)
 *  - Tavily:  1,000 credits / month (web search only)
 *  - Groq browser search (last resort, uses the Groq AI key)
 * Providers are tried in order; one that's out of credits is skipped and the next is used.
 */

export type SearchProviderId = "serpapi" | "serper" | "tavily";
export const SEARCH_IDS: SearchProviderId[] = ["serpapi", "serper", "tavily"];
export const SEARCH_INFO: Record<SearchProviderId, { label: string; env: string; signup: string; note: string; maps: boolean }> = {
  serpapi: { label: "SerpApi", env: "SERPAPI_API_KEY", signup: "https://serpapi.com/users/sign_up", note: "250 free searches every month. Finds the Google Business Profile (Place ID + CID).", maps: true },
  serper: { label: "Serper", env: "SERPER_API_KEY", signup: "https://serper.dev/signup", note: "2,500 free searches (one-time). Also finds Place ID + CID.", maps: true },
  tavily: { label: "Tavily", env: "TAVILY_API_KEY", signup: "https://app.tavily.com", note: "1,000 free credits every month. Web search only (no Maps).", maps: false },
};

type Cfg = { enabled: boolean; keyEnc?: string };
type Settings = { order: SearchProviderId[]; providers: Record<SearchProviderId, Cfg> };

async function getSettings(): Promise<Settings> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'search'");
  const saved = row ? (JSON.parse(row.value) as Partial<Settings>) : {};
  const providers = Object.fromEntries(SEARCH_IDS.map((id) => [id, { enabled: true, ...(saved.providers?.[id] || {}) }])) as Settings["providers"];
  const order = [...(saved.order || []).filter((x) => SEARCH_IDS.includes(x)), ...SEARCH_IDS.filter((x) => !(saved.order || []).includes(x))];
  return { order, providers };
}
const keyOf = (id: SearchProviderId, c: Cfg) => (c.keyEnc ? decrypt(c.keyEnc) : "") || process.env[SEARCH_INFO[id].env] || "";

export async function publicSearchSettings() {
  const s = await getSettings();
  const month = new Date().toISOString().slice(0, 7);
  const usage = Object.fromEntries(await Promise.all(SEARCH_IDS.map(async (id) => [id, (await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [`usage:${id}:${month}`]))?.count || 0])));
  return {
    order: s.order,
    providers: Object.fromEntries(s.order.map((id) => {
      const k = keyOf(id, s.providers[id]);
      return [id, { enabled: s.providers[id].enabled, hasKey: !!k, keyHint: mask(k), keySource: s.providers[id].keyEnc ? "settings" : k ? "env" : "none", usedThisMonth: usage[id], ...SEARCH_INFO[id] }];
    })),
  };
}

export async function saveSearchSettings(input: { order?: SearchProviderId[]; providers?: Partial<Record<SearchProviderId, { enabled?: boolean; apiKey?: string; clearKey?: boolean }>> }) {
  const s = await getSettings();
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

async function getJ(url: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await safeFetch(url, {
    hosts: ["serpapi.com", "google.serper.dev", "api.tavily.com"], method: body ? "POST" : "GET",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, timeoutMs: 25000, maxBytes: 5 * 1024 * 1024,
  });
  const j = JSON.parse(r.text() || "{}");
  if (r.status >= 400 || j?.error) throw Object.assign(new Error(String(j?.error || j?.message || `HTTP ${r.status}`).slice(0, 160)), { status: r.status });
  return j;
}

async function providers(needMaps: boolean) {
  const s = await getSettings();
  return s.order.filter((id) => s.providers[id].enabled && keyOf(id, s.providers[id]) && (!needMaps || SEARCH_INFO[id].maps) && !((cooling.get(id) || 0) > Date.now()))
    .map((id) => ({ id, key: keyOf(id, s.providers[id]) }));
}

export async function searchAvailable() {
  return { web: (await providers(false)).length > 0, maps: (await providers(true)).length > 0 };
}

// ---------- Google Maps (GBP) ----------

export type Place = {
  title: string; address: string; phone: string; website: string; rating: number | null; reviews: number | null;
  placeId: string; cid: string; type: string; hours: Record<string, string>; source: string;
};

const cidFromDataId = (dataId: string) => { const h = dataId.match(/:0x([0-9a-f]+)/i)?.[1]; return h ? BigInt("0x" + h).toString() : ""; };

function hoursMap(h: unknown): Record<string, string> {
  if (!h || typeof h !== "object") return {};
  if (Array.isArray(h)) { // serpapi sometimes: [{ monday: "..." }]
    return Object.assign({}, ...h.map((x) => (typeof x === "object" ? x : {})));
  }
  return Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
}

export async function mapsSearch(query: string): Promise<{ places: Place[]; provider: string }> {
  const errors: string[] = [];
  for (const p of await providers(true)) {
    try {
      let places: Place[] = [];
      if (p.id === "serpapi") {
        const j = await getJ(`https://serpapi.com/search.json?engine=google_maps&type=search&hl=en&gl=us&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(p.key)}`);
        const list = j.place_results ? [j.place_results] : j.local_results || [];
        places = list.slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phone || ""), website: String(x.website || ""),
          rating: typeof x.rating === "number" ? x.rating : null, reviews: typeof x.reviews === "number" ? x.reviews : null,
          placeId: String(x.place_id || ""), cid: String(x.data_cid || "") || cidFromDataId(String(x.data_id || "")),
          type: String(x.type || (Array.isArray(x.types) ? x.types.join(", ") : "")), hours: hoursMap(x.operating_hours || (x.hours as unknown)), source: "SerpApi",
        }));
      } else if (p.id === "serper") {
        const j = await getJ("https://google.serper.dev/maps", { "X-API-KEY": p.key }, { q: query, gl: "us", hl: "en" });
        places = (j.places || []).slice(0, 5).map((x: Record<string, unknown>) => ({
          title: String(x.title || ""), address: String(x.address || ""), phone: String(x.phoneNumber || ""), website: String(x.website || ""),
          rating: typeof x.rating === "number" ? x.rating : null, reviews: typeof x.ratingCount === "number" ? x.ratingCount : null,
          placeId: String(x.placeId || ""), cid: String(x.cid || ""), type: String(x.type || (Array.isArray(x.types) ? x.types.join(", ") : "")),
          hours: hoursMap(x.openingHours), source: "Serper",
        }));
      }
      await countUse(p.id);
      return { places, provider: SEARCH_INFO[p.id].label };
    } catch (e) {
      errors.push(`${SEARCH_INFO[p.id].label}: ${(e as Error).message}`);
      cooling.set(p.id, Date.now() + ((e as { status?: number }).status === 429 || /limit|credit|quota|run out/i.test((e as Error).message) ? 3_600_000 : 30_000));
    }
  }
  throw new Error(errors.length ? errors.join(" · ") : "No Maps search key — add a free SerpApi or Serper key in Settings → Research.");
}

// ---------- Web search ----------

export type WebResult = { title: string; url: string; snippet: string; rating?: number; reviews?: number };

export async function webSearch(query: string, num = 10): Promise<{ results: WebResult[]; provider: string }> {
  const errors: string[] = [];
  for (const p of await providers(false)) {
    try {
      let results: WebResult[] = [];
      if (p.id === "serpapi") {
        const j = await getJ(`https://serpapi.com/search.json?engine=google&hl=en&gl=us&num=${num}&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(p.key)}`);
        results = (j.organic_results || []).map((x: Record<string, any>) => ({
          title: x.title || "", url: x.link || "", snippet: x.snippet || "",
          rating: x.rich_snippet?.top?.detected_extensions?.rating, reviews: x.rich_snippet?.top?.detected_extensions?.reviews,
        }));
      } else if (p.id === "serper") {
        const j = await getJ("https://google.serper.dev/search", { "X-API-KEY": p.key }, { q: query, gl: "us", hl: "en", num });
        results = (j.organic || []).map((x: Record<string, any>) => ({ title: x.title || "", url: x.link || "", snippet: x.snippet || "", rating: x.rating, reviews: x.ratingCount }));
      } else if (p.id === "tavily") {
        const j = await getJ("https://api.tavily.com/search", { Authorization: `Bearer ${p.key}` }, { query, max_results: Math.min(num, 10), search_depth: "basic" });
        results = (j.results || []).map((x: Record<string, any>) => ({ title: x.title || "", url: x.url || "", snippet: String(x.content || "").slice(0, 400) }));
      }
      await countUse(p.id);
      return { results, provider: SEARCH_INFO[p.id].label };
    } catch (e) {
      errors.push(`${SEARCH_INFO[p.id].label}: ${(e as Error).message}`);
      cooling.set(p.id, Date.now() + ((e as { status?: number }).status === 429 || /limit|credit|quota|run out/i.test((e as Error).message) ? 3_600_000 : 30_000));
    }
  }
  // Last resort: ask Groq to browse and return links
  try {
    const text = await groqBrowserSearch(`Search the web for: ${query}\nReturn ONLY JSON: {"results":[{"title":"","url":"","snippet":""}]} with up to ${num} real result URLs you found.`);
    const j = parseJson<{ results?: WebResult[] }>(text);
    if (j?.results?.length) return { results: j.results.filter((r) => /^https?:\/\//.test(r.url)), provider: "Groq browser search" };
    errors.push("Groq browser search: no results");
  } catch (e) { errors.push(`Groq browser search: ${(e as Error).message.slice(0, 120)}`); }
  throw new Error(errors.join(" · ") || "No web search available — add a free SerpApi, Serper or Tavily key in Settings → Research.");
}
