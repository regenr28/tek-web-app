import crypto from "node:crypto";

/**
 * AES-256-GCM for secrets stored in the database (AI keys, 2FA secrets).
 * The key comes from ENCRYPTION_KEY (Vercel env), so a leaked database alone can't reveal them.
 */
function key() {
  const s = process.env.ENCRYPTION_KEY;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_KEY env var is missing or shorter than 32 characters");
    return crypto.createHash("sha256").update("dev-only-encryption-key").digest();
  }
  return crypto.createHash("sha256").update("dpa:v1:" + s).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1." + [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  try {
    const parts = payload.split(".");
    if (parts[0] !== "v1" || parts.length !== 4) return "";
    const [iv, tag, enc] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const mask = (k: string) => (k ? k.slice(0, 4) + "…" + k.slice(-4) : "");

/** Checks that required production secrets exist; called from the setup page so misconfig is obvious. */
export function configProblems(): string[] {
  const p: string[] = [];
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) p.push("ENCRYPTION_KEY (32+ random characters)");
  if (!process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 16) p.push("SETUP_TOKEN (16+ random characters)");
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) p.push("TURSO_DATABASE_URL");
  return p;
}
