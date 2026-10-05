import { one, run } from "./db";
import { encrypt, decrypt, mask } from "./secrets";
import { UA } from "./crawl";
import { safeFetch } from "./net";
import { getPolicy } from "./policy";

export type ProviderId = "cerebras" | "mistral" | "groq" | "cloudflare" | "gemini" | "openrouter" | "custom";
export type ProviderCfg = { enabled: boolean; model: string; keyEnc?: string; baseUrl?: string; accountId?: string };
export type AiSettings = { order: ProviderId[]; providers: Record<ProviderId, ProviderCfg>; visionAlt: boolean };

type Info = { label: string; defaultModel: string; env: string; signup: string; note: string; base?: string };
export const PROVIDER_INFO: Record<ProviderId, Info> = {
  cerebras: { label: "Cerebras", defaultModel: "gpt-oss-120b", env: "CEREBRAS_API_KEY", base: "https://api.cerebras.ai/v1", signup: "https://cloud.cerebras.ai", note: "Free: very fast, ~5 req/min, 1M tokens/day. No card." },
  mistral: { label: "Mistral", defaultModel: "mistral-small-latest", env: "MISTRAL_API_KEY", base: "https://api.mistral.ai/v1", signup: "https://console.mistral.ai/api-keys", note: "Free 'Experiment' plan, ~1 req/sec. No card (phone verification)." },
  groq: { label: "Groq", defaultModel: "openai/gpt-oss-120b", env: "GROQ_API_KEY", base: "https://api.groq.com/openai/v1", signup: "https://console.groq.com/keys", note: "Free: ~30 req/min, 8K tokens/min, 1K req/day. Can also search the web (fallback)." },
  cloudflare: { label: "Cloudflare Workers AI", defaultModel: "@cf/openai/gpt-oss-120b", env: "CLOUDFLARE_API_TOKEN", signup: "https://dash.cloudflare.com/profile/api-tokens", note: "Free 10,000 neurons/day. Needs the Account ID too (env CLOUDFLARE_ACCOUNT_ID)." },
  gemini: { label: "Google Gemini", defaultModel: "gemini-flash-latest", env: "GEMINI_API_KEY", signup: "https://aistudio.google.com/apikey", note: "Free tier: Flash models, ~10 req/min. Can look at images for alt-text checks." },
  openrouter: { label: "OpenRouter", defaultModel: "openrouter/free", env: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", signup: "https://openrouter.ai/keys", note: "Free models (':free' or the openrouter/free router). 50 req/day without credits." },
  custom: { label: "Custom (OpenAI-compatible)", defaultModel: "", env: "CUSTOM_AI_API_KEY", signup: "", note: "Any OpenAI-compatible endpoint." },
};

export const PROVIDER_IDS = ["cerebras", "mistral", "groq", "cloudflare", "gemini", "openrouter", "custom"] as const;
const ALL: ProviderId[] = [...PROVIDER_IDS];
const DEFAULTS: AiSettings = {
  order: ALL,
  providers: Object.fromEntries(ALL.map((id) => [id, { enabled: id !== "custom", model: PROVIDER_INFO[id].defaultModel, baseUrl: "" }])) as Record<ProviderId, ProviderCfg>,
  visionAlt: true,
};

export async function getAiSettings(): Promise<AiSettings> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'ai'");
  const saved = row ? (JSON.parse(row.value) as Partial<AiSettings>) : {};
  const providers = JSON.parse(JSON.stringify(DEFAULTS.providers)) as Record<ProviderId, ProviderCfg>;
  for (const id of ALL) providers[id] = { ...providers[id], ...(saved.providers?.[id] || {}) };
  // Saved order first, then any provider added in a later release
  const savedOrder = (saved.order || []).filter((id) => ALL.includes(id));
  const order = [...savedOrder, ...ALL.filter((id) => !savedOrder.includes(id))];
  return { order, providers, visionAlt: saved.visionAlt ?? DEFAULTS.visionAlt };
}

export function keyFor(id: ProviderId, cfg: ProviderCfg) {
  return (cfg.keyEnc ? decrypt(cfg.keyEnc) : "") || process.env[PROVIDER_INFO[id].env] || "";
}
const accountFor = (cfg: ProviderCfg) => cfg.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";

function baseFor(id: ProviderId, cfg: ProviderCfg) {
  if (id === "cloudflare") { const a = accountFor(cfg); return a ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(a)}/ai/v1` : ""; }
  if (id === "custom") return (cfg.baseUrl || "").replace(/\/+$/, "");
  return PROVIDER_INFO[id].base || "";
}

const ready = (id: ProviderId, cfg: ProviderCfg) => !!keyFor(id, cfg) && !!cfg.model && (id !== "cloudflare" || !!accountFor(cfg)) && (id !== "custom" || !!cfg.baseUrl);

/** Safe view for the settings page — never returns raw keys. */
export async function publicAiSettings() {
  const s = await getAiSettings();
  const cool = await cooldowns();
  return {
    order: s.order, visionAlt: s.visionAlt,
    providers: Object.fromEntries(s.order.map((id) => {
      const cfg = s.providers[id];
      const k = keyFor(id, cfg);
      return [id, {
        enabled: cfg.enabled, model: cfg.model, baseUrl: cfg.baseUrl || "", accountId: cfg.accountId || (process.env.CLOUDFLARE_ACCOUNT_ID && id === "cloudflare" ? "(from env)" : ""),
        hasKey: !!k, ready: ready(id, cfg), keyHint: mask(k), keySource: cfg.keyEnc ? "settings" : k ? "env" : "none",
        coolingUntil: cool[id] && cool[id] > Date.now() ? cool[id] : null, ...PROVIDER_INFO[id],
      }];
    })),
  };
}

export async function saveAiSettings(input: { order?: ProviderId[]; visionAlt?: boolean; providers?: Partial<Record<ProviderId, { enabled?: boolean; model?: string; baseUrl?: string; accountId?: string; apiKey?: string; clearKey?: boolean }>> }) {
  const s = await getAiSettings();
  if (input.order) s.order = [...input.order.filter((id) => ALL.includes(id)), ...ALL.filter((id) => !input.order!.includes(id))];
  if (typeof input.visionAlt === "boolean") s.visionAlt = input.visionAlt;
  for (const [id, p] of Object.entries(input.providers || {}) as [ProviderId, NonNullable<typeof input.providers>[ProviderId]][]) {
    if (!p || !s.providers[id]) continue;
    const cfg = s.providers[id];
    if (typeof p.enabled === "boolean") cfg.enabled = p.enabled;
    if (typeof p.model === "string") cfg.model = p.model.trim();
    if (typeof p.baseUrl === "string") cfg.baseUrl = p.baseUrl.trim();
    if (typeof p.accountId === "string") cfg.accountId = p.accountId.trim();
    if (p.clearKey) delete cfg.keyEnc;
    if (p.apiKey && p.apiKey.trim()) cfg.keyEnc = encrypt(p.apiKey.trim());
  }
  await run("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
}

export async function aiAvailable() {
  const s = await getAiSettings();
  return s.order.some((id) => s.providers[id].enabled && ready(id, s.providers[id]));
}

// ---------- cooldowns: a rate-limited provider is skipped until it recovers, so work never stalls ----------

let coolCache: { at: number; v: Record<string, number> } | null = null;
async function cooldowns(): Promise<Record<string, number>> {
  if (coolCache && Date.now() - coolCache.at < 5000) return coolCache.v;
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'ai_cooldown'");
  const v = row ? (JSON.parse(row.value) as Record<string, number>) : {};
  coolCache = { at: Date.now(), v };
  return v;
}
async function coolDown(id: string, ms: number) {
  const v = { ...(await cooldowns()), [id]: Date.now() + ms };
  coolCache = { at: Date.now(), v };
  await run("INSERT INTO settings (key, value) VALUES ('ai_cooldown', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(v)]);
}

class HttpFail extends Error { constructor(public status: number, msg: string, public retryAfter = 0) { super(msg); } }

/** How long to rest a provider after a failure. */
function restFor(e: unknown) {
  if (e instanceof HttpFail) {
    if (e.status === 429) return Math.max(e.retryAfter * 1000, /day|daily|quota|exhaust/i.test(e.message) ? 3_600_000 : 60_000);
    if (e.status === 402 || e.status === 403) return 3_600_000; // out of credits / not allowed
    if (e.status === 401) return 6 * 3_600_000; // bad key
    if (e.status >= 500) return 30_000;
  }
  return 20_000; // timeout / network
}

// ---------- calling ----------

type ImagePart = { mime: string; b64: string };
type CallOpts = { system: string; user: string; images?: ImagePart[]; only?: ProviderId; json?: boolean; maxTokens?: number };

export class AiError extends Error {}

/**
 * Tries providers in the Super Admin's order. A provider that hits its limit (429/quota) is put on
 * cooldown and the next one is used immediately, so a long job keeps going across providers.
 */
export async function callAI(opts: CallOpts): Promise<{ text: string; provider: ProviderId; model: string }> {
  const s = await getAiSettings();
  const errors: string[] = [];
  const cool = await cooldowns();
  let ids = opts.only ? [opts.only] : s.order.filter((id) => s.providers[id].enabled && ready(id, s.providers[id]));
  if (!opts.only) {
    const fresh = ids.filter((id) => !(cool[id] > Date.now()));
    // if everyone is cooling down, try the one that recovers first rather than failing
    ids = fresh.length ? fresh : [...ids].sort((a, b) => (cool[a] || 0) - (cool[b] || 0)).slice(0, 1);
  }
  for (const id of ids) {
    const cfg = s.providers[id];
    const key = keyFor(id, cfg);
    if (!key) continue;
    const images = id === "gemini" ? opts.images : undefined;
    try {
      const text = id === "gemini"
        ? await gemini(key, cfg.model, opts.system, opts.user, images)
        : await openAiCompat(id, key, cfg, opts.system, opts.user, opts.json !== false, opts.maxTokens);
      return { text, provider: id, model: cfg.model };
    } catch (e) {
      errors.push(`${PROVIDER_INFO[id].label}: ${(e as Error).message.slice(0, 160)}`);
      if (!opts.only) await coolDown(id, restFor(e)).catch(() => {});
    }
  }
  throw new AiError(errors.length ? errors.join(" · ") : "No AI provider is configured. Ask a Super Admin to add a free API key in Settings → AI providers.");
}

const devHttp = () => process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 50000) {
  const r = await safeFetch(url, { hosts: "public", httpsOnly: !devHttp(), method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), timeoutMs, maxBytes: 4 * 1024 * 1024 });
  const txt = r.text();
  if (r.status >= 400) throw new HttpFail(r.status, `HTTP ${r.status}${r.status === 429 ? " (rate limited)" : ""}: ${txt.slice(0, 200)}`, Number(r.headers.get("retry-after")) || 0);
  return JSON.parse(txt);
}

async function getJson(url: string, headers: Record<string, string>) {
  const r = await safeFetch(url, { hosts: "public", httpsOnly: !devHttp(), headers, timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 });
  const j = JSON.parse(r.text() || "{}");
  if (r.status >= 400) throw new Error(j?.error?.message || j?.errors?.[0]?.message || `HTTP ${r.status}`);
  return j;
}

async function gemini(key: string, model: string, system: string, user: string, images?: ImagePart[]) {
  const parts: unknown[] = [{ text: user }];
  for (const im of images || []) parts.push({ inline_data: { mime_type: im.mime, data: im.b64 } });
  const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  });
  const text = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
  if (!text) throw new Error("Empty response" + (j?.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : ""));
  return text;
}

async function openAiCompat(id: ProviderId, key: string, cfg: ProviderCfg, system: string, user: string, json = true, maxTokens?: number) {
  const base = baseFor(id, cfg);
  if (!base) throw new Error(id === "cloudflare" ? "Missing Cloudflare Account ID" : "Missing base URL");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (id === "openrouter") { headers["HTTP-Referer"] = "https://github.com/duda-preview-audit"; headers["X-Title"] = "Duda Preview Audit"; }
  const body: Record<string, unknown> = { model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json && (id === "groq" || id === "mistral" || id === "cerebras")) body.response_format = { type: "json_object" };
  if (/gpt-oss/.test(cfg.model)) body.reasoning_effort = "low"; // fewer hidden tokens = more free requests
  const j = await post(base + "/chat/completions", headers, body);
  const text = j?.choices?.[0]?.message?.content || j?.result?.response || "";
  if (!text) throw new Error("Empty response");
  return typeof text === "string" ? text : JSON.stringify(text);
}

/** Groq's built-in browser search — used only as a last-resort web search when no search API key works. */
export async function groqBrowserSearch(question: string): Promise<string> {
  const s = await getAiSettings();
  const key = keyFor("groq", s.providers.groq);
  if (!key) throw new Error("No Groq key");
  const model = /gpt-oss/.test(s.providers.groq.model) ? s.providers.groq.model : "openai/gpt-oss-120b";
  const j = await post("https://api.groq.com/openai/v1/chat/completions", { Authorization: `Bearer ${key}` }, {
    model, temperature: 0.1, reasoning_effort: "low", tools: [{ type: "browser_search" }], tool_choice: "required",
    messages: [{ role: "user", content: question }],
  });
  return j?.choices?.[0]?.message?.content || "";
}

export async function listModels(id: ProviderId): Promise<string[]> {
  const s = await getAiSettings();
  const cfg = s.providers[id];
  const key = keyFor(id, cfg);
  if (!key) throw new Error("Add an API key first");
  if (id === "gemini") {
    const j = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key });
    return (j.models || []).filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent")).map((m: { name: string }) => m.name.replace(/^models\//, ""));
  }
  if (id === "cloudflare") {
    const a = accountFor(cfg);
    if (!a) throw new Error("Add the Cloudflare Account ID first");
    const j = await getJson(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(a)}/ai/models/search?task=Text%20Generation&per_page=100`, { Authorization: `Bearer ${key}` });
    return (j.result || []).map((m: { name: string }) => m.name);
  }
  const j = await getJson(baseFor(id, cfg) + "/models", { Authorization: `Bearer ${key}` });
  let ids: string[] = (j.data || []).map((m: { id: string }) => m.id);
  if (id === "openrouter") ids = ["openrouter/free", ...ids.filter((m) => m.endsWith(":free"))];
  return ids;
}

/** Pull the first JSON object/array out of a model response. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  try { return JSON.parse(cleaned) as T; } catch { /* try harder */ }
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  for (let end = cleaned.length; end > start; end--) {
    const ch = cleaned[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(cleaned.slice(start, end)) as T; } catch { /* keep shrinking */ }
  }
  return null;
}

export async function fetchImageForAi(url: string): Promise<ImagePart | null> {
  // Duda CDN serves responsive sizes like "-1920w.jpg"; ask for a smaller one first.
  const small = url.replace(/-(\d{3,4})w(\.(?:jpe?g|png|webp))/i, "-640w$2");
  if (small !== url) {
    const r = await fetchImageOnce(small);
    if (r) return r;
  }
  return fetchImageOnce(url);
}

async function fetchImageOnce(url: string): Promise<ImagePart | null> {
  try {
    const { crawlHosts } = await getPolicy();
    // Images come from Duda's CDN or the allowed site domains only.
    const r = await safeFetch(url, { hosts: [...crawlHosts, "*.cdn-website.com"], headers: { "User-Agent": UA }, timeoutMs: 10000, maxBytes: 1_500_000 });
    const mime = (r.headers.get("content-type") || "").split(";")[0];
    if (r.status >= 400 || !/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    return { mime, b64: r.body.toString("base64") };
  } catch { return null; }
}
