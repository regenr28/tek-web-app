import { headers } from "next/headers";
import { z } from "zod";
import { one, run } from "./db";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

// ---------- request context ----------

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-vercel-forwarded-for") || h.get("x-real-ip") || h.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 64) || "unknown";
}

export async function userAgent(): Promise<string> {
  return ((await headers()).get("user-agent") || "").slice(0, 200);
}

/**
 * CSRF defence for every state-changing request: the browser-set Origin (or Sec-Fetch-Site)
 * must match this site. Session cookies are also SameSite=Strict.
 */
export function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new HttpError(403, "Cross-site request blocked");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!origin || !host) throw new HttpError(403, "Missing Origin header");
  let o: URL;
  try { o = new URL(origin); } catch { throw new HttpError(403, "Bad Origin header"); }
  if (o.host !== host) throw new HttpError(403, "Cross-site request blocked");
}

// ---------- rate limiting (fixed window, stored in the DB so it works across serverless instances) ----------

export async function rateLimit(key: string, limit: number, windowSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSec);
  await run(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`,
    [key, start]
  );
  const r = await one<{ count: number }>("SELECT count FROM rate_limits WHERE key = ?", [key]);
  if ((r?.count ?? 0) > limit) {
    throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((start + windowSec - now) / 60)} minute(s).`);
  }
}

// ---------- security log ----------

export async function logEvent(event: string, userId: number | null, detail?: Record<string, unknown>) {
  try {
    await run("INSERT INTO security_events (user_id, event, ip, detail) VALUES (?,?,?,?)", [userId, event, await clientIp(), detail ? JSON.stringify(detail).slice(0, 1000) : null]);
    // keep the log bounded (~90 days)
    if (Math.random() < 0.02) await run("DELETE FROM security_events WHERE at < datetime('now', '-90 days')");
  } catch { /* never block the request on logging */ }
}

// ---------- validation ----------

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 1_000_000) throw new HttpError(413, "Request too large");
  let data: unknown;
  try { data = await req.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `Invalid ${i?.path.join(".") || "input"}: ${i?.message || "bad value"}`);
  }
  return r.data;
}

export const zId = z.coerce.number().int().positive();
export const zText = (max: number) => z.string().trim().max(max);
export const zUrl = z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "must start with http(s)://");

// ---------- passwords ----------

const COMMON = new Set([
  "password", "password1", "password123", "123456789012", "qwertyuiop", "letmein", "welcome", "admin", "iloveyou",
  "monkey", "dragon", "football", "baseball", "sunshine", "princess", "trustno1", "passw0rd", "changeme", "duda", "tekmetric",
]);

export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters";
  if (pw.length > 128) return "Password must be at most 128 characters";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || [...COMMON].some((c) => c.length >= 6 && lower.includes(c) && lower.length - c.length < 4)) return "That password is too common";
  if (/^(.)\1+$/.test(pw)) return "Password can't be one repeated character";
  if (/^(0123456789|1234567890|abcdefghij)/i.test(pw)) return "Password is too predictable";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "Password can't contain your email name";
  return null;
}
