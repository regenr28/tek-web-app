import { one, run } from "./db";

export type MfaPolicy = "all" | "admins" | "off";
export type SecurityPolicy = {
  mfaRequired: MfaPolicy;
  sessionIdleHours: number;   // sign out after this much inactivity
  sessionMaxDays: number;     // hard limit regardless of activity
  crawlHosts: string[];       // preview/live hosts the crawler may fetch ("*.example.com" allowed)
};

export const DEFAULT_CRAWL_HOSTS = ["*.tekmetric.site", "*.multiscreensite.com", "*.dudaone.com", "*.duda.co", "*.mydudapreview.com"];

const DEFAULTS: SecurityPolicy = { mfaRequired: "all", sessionIdleHours: 8, sessionMaxDays: 7, crawlHosts: DEFAULT_CRAWL_HOSTS };

let cache: { at: number; v: SecurityPolicy } | null = null;

export async function getPolicy(): Promise<SecurityPolicy> {
  if (cache && Date.now() - cache.at < 15000) return cache.v;
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'security'");
  const saved = row ? (JSON.parse(row.value) as Partial<SecurityPolicy>) : {};
  const v: SecurityPolicy = {
    mfaRequired: (["all", "admins", "off"] as const).includes(saved.mfaRequired as MfaPolicy) ? saved.mfaRequired! : DEFAULTS.mfaRequired,
    sessionIdleHours: clamp(saved.sessionIdleHours, 1, 24, DEFAULTS.sessionIdleHours),
    sessionMaxDays: clamp(saved.sessionMaxDays, 1, 30, DEFAULTS.sessionMaxDays),
    crawlHosts: Array.isArray(saved.crawlHosts) && saved.crawlHosts.length ? saved.crawlHosts : DEFAULTS.crawlHosts,
  };
  cache = { at: Date.now(), v };
  return v;
}

export async function savePolicy(p: Partial<SecurityPolicy>) {
  const cur = await getPolicy();
  const next = { ...cur, ...p };
  await run("INSERT INTO settings (key, value) VALUES ('security', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  cache = null;
  return getPolicy();
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && v >= lo && v <= hi ? v : d);

/** Exact host or "*.domain" (matches the domain and its subdomains). Extra hosts can be added with CRAWL_ALLOWED_HOSTS. */
export function hostAllowed(host: string, patterns: string[]) {
  const h = host.toLowerCase().replace(/\.$/, "");
  const extra = (process.env.CRAWL_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...patterns, ...extra].some((p) => {
    const q = p.toLowerCase().trim();
    if (q.startsWith("*.")) return h === q.slice(2) || h.endsWith(q.slice(1));
    return h === q;
  });
}
