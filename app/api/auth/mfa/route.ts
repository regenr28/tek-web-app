import { z } from "zod";
import { one, run } from "@/lib/db";
import { handle, pendingSessionUser, destroySession, createSession, HttpError } from "@/lib/auth";
import { parseBody, rateLimit, logEvent } from "@/lib/security";
import { decrypt, sha256 } from "@/lib/secrets";
import { verifyTotp } from "@/lib/totp";

const Body = z.object({ code: z.string().trim().max(20) });

/** Second login step: 6-digit authenticator code, or a one-time recovery code. */
export const POST = handle(async (req: Request) => {
  const p = await pendingSessionUser();
  if (!p) throw new HttpError(401, "Your sign-in expired. Enter your password again.");
  await rateLimit(`mfa:${p.id}`, 8, 900);
  const { code } = await parseBody(req, Body);
  const u = await one<{ mfa_secret_enc: string; mfa_last_step: number; recovery_codes: string | null }>(
    "SELECT mfa_secret_enc, mfa_last_step, recovery_codes FROM users WHERE id = ? AND active = 1 AND mfa_enabled = 1", [p.id]);
  if (!u) throw new HttpError(401, "Your sign-in expired. Enter your password again.");

  let method = "";
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const step = verifyTotp(decrypt(u.mfa_secret_enc), digits, u.mfa_last_step);
    if (step) { await run("UPDATE users SET mfa_last_step = ? WHERE id = ?", [step, p.id]); method = "totp"; }
  } else {
    const codes: string[] = u.recovery_codes ? JSON.parse(u.recovery_codes) : [];
    const h = sha256(code.toUpperCase().replace(/[^A-F0-9]/g, ""));
    if (codes.includes(h)) {
      await run("UPDATE users SET recovery_codes = ? WHERE id = ?", [JSON.stringify(codes.filter((c) => c !== h)), p.id]);
      method = "recovery_code";
    }
  }
  if (!method) { await logEvent("login.bad_2fa", p.id); throw new HttpError(401, "That code didn't work. Check your authenticator app's time and try again."); }

  // Rotate: drop the pending session and issue a fresh full one.
  await destroySession();
  await createSession(p.id, true);
  await run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [p.id]);
  await logEvent("login.success", p.id, { method });
  return Response.json({ ok: true, usedRecoveryCode: method === "recovery_code" });
});
