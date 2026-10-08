import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { one, run } from "./db";
import { sha256, randomToken } from "./secrets";
import { HttpError, assertSameOrigin, clientIp, userAgent } from "./security";
import { getPolicy } from "./policy";

export { HttpError };

export type Role = "super_admin" | "admin" | "member";
/** Which main areas a non-Super-Admin may open. Super Admins always see everything. */
export type Access = "all" | "projects" | "websites";
export type Area = "projects" | "websites";
export const ACCESS_VALUES = ["all", "projects", "websites"] as const;
export type User = {
  id: number; email: string; name: string; role: Role; active: number; access: Access;
  mfa_enabled: number; must_change_password: number;
  /** true when the user must change their password or turn on 2FA before using the app */
  setupRequired: boolean; needsMfa: boolean; mfaRequired: boolean;
};

const SECURE = process.env.NODE_ENV === "production";
// "__Host-" cookies can only be set over HTTPS, for this exact host, on path "/" — no subdomain can overwrite them.
export const COOKIE = SECURE ? "__Host-dpa_session" : "dpa_session";
const RANK: Record<Role, number> = { member: 1, admin: 2, super_admin: 3 };
const BCRYPT_COST = 12;
const PENDING_MINUTES = 10;

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_COST);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
// Used when the email doesn't exist so response time doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | null = null;
export const burnTime = async (pw: string) => {
  dummyHash ??= bcrypt.hash("not-a-real-password", BCRYPT_COST);
  return bcrypt.compare(pw, await dummyHash);
};

function sqlTime(d: Date) { return d.toISOString().replace("T", " ").slice(0, 19); }

/**
 * Creates a session. mfaOk=false makes a short-lived "password OK, waiting for 2FA code" session.
 * remember=true ("Keep me signed in"): lasts policy.rememberDays and isn't ended by the inactivity timeout.
 */
export async function createSession(userId: number, mfaOk: boolean, remember = false) {
  const policy = await getPolicy();
  const keep = remember && policy.rememberDays > 0;
  const token = randomToken(32);
  const expires = !mfaOk ? new Date(Date.now() + PENDING_MINUTES * 60_000)
    : new Date(Date.now() + (keep ? policy.rememberDays : policy.sessionMaxDays) * 86400_000);
  await run("INSERT INTO sessions (id, user_id, mfa_ok, expires_at, ip, user_agent, remember) VALUES (?,?,?,?,?,?,?)",
    [sha256(token), userId, mfaOk ? 1 : 0, sqlTime(expires), await clientIp(), await userAgent(), keep ? 1 : 0]);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, secure: SECURE, sameSite: "strict", path: "/",
    maxAge: Math.floor((expires.getTime() - Date.now()) / 1000),
  });
}

async function tokenHash() {
  const t = (await cookies()).get(COOKIE)?.value;
  return t && t.length >= 40 && t.length <= 64 ? sha256(t) : null;
}

type SessionRow = { sid: string; mfa_ok: number; last_seen: string; remember: number } & Omit<User, "setupRequired" | "needsMfa" | "mfaRequired">;

async function loadSession(): Promise<SessionRow | null> {
  const h = await tokenHash();
  if (!h) return null;
  const policy = await getPolicy();
  const s = await one<SessionRow>(
    `SELECT s.id AS sid, s.mfa_ok, s.last_seen, s.remember, u.id, u.email, u.name, u.role, u.active, u.access, u.mfa_enabled, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now') AND (s.remember = 1 OR s.last_seen > datetime('now', ?))`,
    [h, `-${policy.sessionIdleHours} hours`]
  );
  if (!s || !s.active) return null;
  return s;
}

export async function pendingSessionUser(): Promise<{ id: number; email: string; remember: boolean } | null> {
  const s = await loadSession();
  return s && !s.mfa_ok ? { id: s.id, email: s.email, remember: !!s.remember } : null;
}

export async function currentUser(): Promise<User | null> {
  const s = await loadSession();
  if (!s || !s.mfa_ok) return null;
  // sliding idle timeout: touch at most every 5 minutes
  if (Date.parse(s.last_seen.replace(" ", "T") + "Z") < Date.now() - 300_000)
    await run("UPDATE sessions SET last_seen = datetime('now') WHERE id = ?", [s.sid]);
  const policy = await getPolicy();
  const mfaRequired = policy.mfaRequired === "all" || (policy.mfaRequired === "admins" && s.role !== "member");
  const needsMfa = !s.mfa_enabled && mfaRequired;
  const { sid: _sid, mfa_ok: _m, last_seen: _l, remember: _r, ...u } = s;
  return { ...u, needsMfa, mfaRequired, setupRequired: needsMfa || !!s.must_change_password };
}

export async function destroySession() {
  const h = await tokenHash();
  if (h) await run("DELETE FROM sessions WHERE id = ?", [h]);
  (await cookies()).delete(COOKIE);
}

/** Sign a user out everywhere (password change, deactivation, role change), optionally keeping the current session. */
export async function destroyUserSessions(userId: number, keepCurrent = false) {
  const h = keepCurrent ? await tokenHash() : null;
  await run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, h || ""]);
  if (Math.random() < 0.05) await run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

export async function currentSessionId() { return tokenHash(); }

export const hasRole = (u: User | null, role: Role) => !!u && RANK[u.role] >= RANK[role];

/** Effective access: Super Admins always see everything; unknown values fall back to "all". */
export const accessOf = (u: Pick<User, "role" | "access">): Access =>
  u.role === "super_admin" ? "all" : (ACCESS_VALUES as readonly string[]).includes(u.access) ? u.access : "all";
export const canSee = (u: Pick<User, "role" | "access"> | null, area: Area) => {
  if (!u) return false;
  const a = accessOf(u);
  return a === "all" || a === area;
};
/** Where to send someone who opened an area they can't see. */
export const homeFor = (u: Pick<User, "role" | "access">) => (canSee(u, "projects") ? "/" : "/websites");

/** Every protected API calls this. `setup: true` lets users with unfinished security setup reach their own account endpoints. */
export async function requireUser(role: Role = "member", opts: { setup?: boolean; area?: Area } = {}): Promise<User> {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Not signed in");
  if (u.setupRequired && !opts.setup) throw new HttpError(403, "Finish your account security setup first", "setup_required");
  if (!hasRole(u, role)) throw new HttpError(403, "You don't have permission for this");
  if (opts.area && !canSee(u, opts.area)) throw new HttpError(403, "Your account doesn't have access to this area");
  return u;
}

/** Route wrapper: CSRF check on writes, JSON errors, no caching, no internal error details leaked. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    let res: Response;
    try {
      const req = args[0];
      if (req instanceof Request) assertSameOrigin(req);
      res = await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) res = Response.json({ error: e.message, code: e.code }, { status: e.status });
      else {
        const ref = randomToken(6);
        console.error(`[error ${ref}]`, e);
        res = Response.json({ error: `Something went wrong (ref ${ref})` }, { status: 500 });
      }
    }
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
}
