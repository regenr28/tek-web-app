import { z } from "zod";
import { one, run } from "@/lib/db";
import { handle, checkPassword, createSession, burnTime, HttpError } from "@/lib/auth";
import { parseBody, rateLimit, clientIp, logEvent } from "@/lib/security";

const Body = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200), remember: z.boolean().optional() });
const GENERIC = "Email or password is incorrect, or the account is temporarily locked.";

type Row = { id: number; password_hash: string; active: number; mfa_enabled: number; failed_logins: number; locked_until: string | null };

export const POST = handle(async (req: Request) => {
  const ip = await clientIp();
  await rateLimit(`login-ip:${ip}`, 20, 900);
  const { email, password, remember = false } = await parseBody(req, Body);
  await rateLimit(`login-email:${email}`, 10, 900);

  const u = await one<Row>("SELECT id, password_hash, active, mfa_enabled, failed_logins, locked_until FROM users WHERE email = ?", [email]);
  if (!u) { await burnTime(password); await logEvent("login.unknown_email", null, { email }); throw new HttpError(401, GENERIC); }
  if (u.locked_until && Date.parse(u.locked_until.replace(" ", "T") + "Z") > Date.now()) {
    await burnTime(password);
    await logEvent("login.locked", u.id);
    throw new HttpError(401, GENERIC);
  }
  const ok = await checkPassword(password, u.password_hash);
  if (!ok || !u.active) {
    const fails = u.failed_logins + 1;
    // 5 failures → 15 min lock, doubling each further failure, capped at 24h
    const lockMin = fails >= 5 ? Math.min(15 * 2 ** (fails - 5), 1440) : 0;
    await run(`UPDATE users SET failed_logins = ?, locked_until = ${lockMin ? `datetime('now', '+${lockMin} minutes')` : "locked_until"} WHERE id = ?`, [fails, u.id]);
    await logEvent(u.active ? "login.bad_password" : "login.inactive", u.id, { fails, lockMin });
    throw new HttpError(401, GENERIC);
  }
  await run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", [u.id]);
  if (u.mfa_enabled) {
    await createSession(u.id, false, remember); // the choice carries over to the 2FA step
    await logEvent("login.password_ok_awaiting_2fa", u.id);
    return Response.json({ mfa: true });
  }
  await createSession(u.id, true, remember);
  await run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [u.id]);
  await logEvent("login.success", u.id, { ip, remember });
  return Response.json({ ok: true });
});
