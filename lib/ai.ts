import { one, run } from "./db";
import { encrypt, decrypt, mask } from "./secrets";
import { UA } from "./crawl";
import { safeFetch } from "./net";
import { getPolicy } from "./policy";

export type ProviderId = "gemini" | "groq" | "openrouter" | "custom";
export type ProviderCfg = { enabled: boolean; model: string; keyEnc?: string; baseUrl?: string };
export type AiSettings = { order: ProviderId[]; providers: Record<ProviderId, ProviderCfg>; visionAlt: boolean };

export const PROVIDER_INFO: Record<ProviderId, { label: string; defaultModel: string; env: string; signup: string; note: string }> = {
  gemini: { label: "Google Gemini", defaultModel: "gemini-flash-latest", env: "GEMINI_API_KEY", signup: "https://aistudio.google.com/apikey", note: "Free tier: Flash models, ~10 req/min. Can look at images for alt-text checks." },
  groq: { label: "Groq", defaultModel: "openai/gpt-oss-120b", env: "GROQ_API_KEY", signup: "https://console.groq.com/keys", note: "Free tier: ~30 req/min, 8K tokens/min. Text only." },
  openrouter: { label: "OpenRouter", defaultModel: "openrouter/free", env: "OPENROUTER_API_KEY", signup: "https://openrouter.ai/keys", note: "Free models (':free' or the openrouter/free router). 50 req/day without credits." },
  custom: { label: "Custom (OpenAI-compatible)", defaultModel: "", env: "CUSTOM_AI_API_KEY", signup: "", note: "Any OpenAI-compatible endpoint, e.g. Cerebras, Mistral, a local model." },
};

const DEFAULTS: AiSettings = {
  order: ["gemini", "groq", "openrouter", "custom"],
  providers: {
    gemini: { enabled: true, model: PROVIDER_INFO.gemini.defaultModel },
    groq: { enabled: true, model: PROVIDER_INFO.groq.defaultModel },
    openrouter: { enabled: true, model: PROVIDER_INFO.openrouter.defaultModel },
    custom: { enabled: false, model: "", baseUrl: "" },
  },
  visionAlt: true,
};

export async function getAiSettings(): Promise<AiSettings> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'ai'");
  const saved = row ? (JSON.parse(row.value) as Partial<AiSettings>) : {};
  const providers = { ...DEFAULTS.providers };
  for (const id of Object.keys(providers) as ProviderId[]) providers[id] = { ...providers[id], ...(saved.providers?.[id] || {}) };
  const order = (saved.order?.length ? saved.order : DEFAULTS.order).filter((id) => id in providers) as ProviderId[];
  return { order, providers, visionAlt: saved.visionAlt ?? DEFAULTS.visionAlt };
}

export function keyFor(id: ProviderId, cfg: ProviderCfg) {
  return (cfg.keyEnc ? decrypt(cfg.keyEnc) : "") || process.env[PROVIDER_INFO[id].env] || "";
}

/** Safe view for the settings page — never returns raw keys. */
export async function publicAiSettings() {
  const s = await getAiSettings();
  return {
    order: s.order, visionAlt: s.visionAlt,
    providers: Object.fromEntries(s.order.map((id) => {
      const cfg = s.providers[id];
      const k = keyFor(id, cfg);
      return [id, { enabled: cfg.enabled, model: cfg.model, baseUrl: cfg.baseUrl || "", hasKey: !!k, keyHint: mask(k), keySource: cfg.keyEnc ? "settings" : k ? "env" : "none", ...PROVIDER_INFO[id] }];
    })),
  };
}

export async function saveAiSettings(input: { order?: ProviderId[]; visionAlt?: boolean; providers?: Partial<Record<ProviderId, { enabled?: boolean; model?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean }>> }) {
  const s = await getAiSettings();
  if (input.order) s.order = input.order.filter((id) => id in s.providers);
  if (typeof input.visionAlt === "boolean") s.visionAlt = input.visionAlt;
  for (const [id, p] of Object.entries(input.providers || {}) as [ProviderId, NonNullable<typeof input.providers>[ProviderId]][]) {
    if (!p || !s.providers[id]) continue;
    const cfg = s.providers[id];
    if (typeof p.enabled === "boolean") cfg.enabled = p.enabled;
    if (typeof p.model === "string") cfg.model = p.model.trim();
    if (typeof p.baseUrl === "string") cfg.baseUrl = p.baseUrl.trim();
    if (p.clearKey) delete cfg.keyEnc;
    if (p.apiKey && p.apiKey.trim()) cfg.keyEnc = encrypt(p.apiKey.trim());
  }
  await run("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
}

export async function aiAvailable() {
  const s = await getAiSettings();
  return s.order.some((id) => s.providers[id].enabled && keyFor(id, s.providers[id]) && s.providers[id].model);
}

// ---------- calling ----------

type ImagePart = { mime: string; b64: string };
type CallOpts = { system: string; user: string; images?: ImagePart[]; only?: ProviderId };

export class AiError extends Error {}

export async function callAI(opts: CallOpts): Promise<{ text: string; provider: ProviderId; model: string }> {
  const s = await getAiSettings();
  const errors: string[] = [];
  const ids = opts.only ? [opts.only] : s.order;
  for (const id of ids) {
    const cfg = s.providers[id];
    const key = keyFor(id, cfg);
    if (!cfg.enabled && !opts.only) continue;
    if (!key || !cfg.model) continue;
    // Only Gemini gets images; others fall back to text-only
    const images = id === "gemini" ? opts.images : undefined;
    try {
      const text = id === "gemini" ? await gemini(key, cfg.model, opts.system, opts.user, images) : await openAiCompat(id, key, cfg, opts.system, opts.user);
      return { text, provider: id, model: cfg.model };
    } catch (e) {
      errors.push(`${PROVIDER_INFO[id].label}: ${(e as Error).message}`);
    }
  }
  throw new AiError(errors.length ? errors.join(" · ") : "No AI provider is configured. Ask a Super Admin to add a free API key in Settings.");
}

const devHttp = () => process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 55000) {
  const r = await safeFetch(url, { hosts: "public", httpsOnly: !devHttp(), method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), timeoutMs, maxBytes: 4 * 1024 * 1024 });
  const txt = r.text();
  if (r.status >= 400) throw new Error(`HTTP ${r.status}${r.status === 429 ? " (rate limited)" : ""}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

async function getJson(url: string, headers: Record<string, string>) {
  const r = await safeFetch(url, { hosts: "public", httpsOnly: !devHttp(), headers, timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 });
  const j = JSON.parse(r.text() || "{}");
  if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
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

async function openAiCompat(id: ProviderId, key: string, cfg: ProviderCfg, system: string, user: string) {
  const base = id === "groq" ? "https://api.groq.com/openai/v1" : id === "openrouter" ? "https://openrouter.ai/api/v1" : (cfg.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("Missing base URL");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (id === "openrouter") { headers["HTTP-Referer"] = "https://github.com/duda-preview-audit"; headers["X-Title"] = "Duda Preview Audit"; }
  const body: Record<string, unknown> = { model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (id === "groq") body.response_format = { type: "json_object" };
  const j = await post(base + "/chat/completions", headers, body);
  const text = j?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Empty response");
  return text;
}

export async function listModels(id: ProviderId): Promise<string[]> {
  const s = await getAiSettings();
  const key = keyFor(id, s.providers[id]);
  if (!key) throw new Error("Add an API key first");
  if (id === "gemini") {
    const j = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key });
    return (j.models || []).filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent")).map((m: { name: string }) => m.name.replace(/^models\//, ""));
  }
  const base = id === "groq" ? "https://api.groq.com/openai/v1" : id === "openrouter" ? "https://openrouter.ai/api/v1" : (s.providers.custom.baseUrl || "").replace(/\/+$/, "");
  const j = await getJson(base + "/models", { Authorization: `Bearer ${key}` });
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
