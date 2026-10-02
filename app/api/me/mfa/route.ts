import { z } from "zod";
import QRCode from "qrcode";
import { one, run } from "@/lib/db";
import { handle, requireUser, checkPassword, destroyUserSessions, HttpError } from "@/lib/auth";
import { parseBody, rateLimit, logEvent } from "@/lib/security";
import { encrypt, decrypt, sha256 } from "@/lib/secrets";
import { newSecret, verifyTotp, otpauthUrl, newRecoveryCodes, currentStep } from "@/lib/totp";
import { getPolicy } from "@/lib/policy";

/** Step 1: create a new secret (not active until confirmed). */
export const POST = handle(async () => {
  const me = await requireUser("member", { setup: true });
  if (me.mfa_enabled) throw new HttpError(400, "Two-factor login is already on");
  await rateLimit(`mfa-setup:${me.id}`, 10, 900);
  const secret = newSecret();
  await run("UPDATE users SET mfa_secret_enc = ? WHERE id = ?", [encrypt(secret), me.id]);
  const url = otpauthUrl(secret, me.email);
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  return Response.json({ secret, qr });
});

/** Step 2: confirm with a code from the app → turn on, return one-time recovery codes. */
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  await rateLimit(`mfa-confirm:${me.id}`, 10, 900);
  const { code } = await parseBody(req, z.object({ code: z.string().trim().max(10) }));
  const u = await one<{ mfa_secret_enc: string | null; mfa_enabled: number }>("SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = ?", [me.id]);
  if (!u?.mfa_secret_enc || u.mfa_enabled) throw new HttpError(400, "Start two-factor setup first");
  const step = verifyTotp(decrypt(u.mfa_secret_enc), code.replace(/\s/g, ""), currentStep() - 3);
  if (!step) throw new HttpError(400, "That code didn't match. Make sure your phone's clock is automatic and try the newest code.");
  const codes = newRecoveryCodes();
  await run("UPDATE users SET mfa_enabled = 1, mfa_last_step = ?, recovery_codes = ? WHERE id = ?",
    [step, JSON.stringify(codes.map((c) => sha256(c.replace(/-/g, "")))), me.id]);
  await destroyUserSessions(me.id, true);
  await logEvent("mfa.enabled", me.id);
  return Response.json({ ok: true, recoveryCodes: codes });
});

/** Turn off (only if policy allows) — needs password + a current code. */
export const DELETE = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  await rateLimit(`mfa-off:${me.id}`, 5, 900);
  const policy = await getPolicy();
  if (policy.mfaRequired === "all" || (policy.mfaRequired === "admins" && me.role !== "member"))
    throw new HttpError(400, "Two-factor login is required for your account by the security policy");
  const { password, code } = await parseBody(req, z.object({ password: z.string().max(200), code: z.string().trim().max(10) }));
  const u = await one<{ password_hash: string; mfa_secret_enc: string; mfa_last_step: number }>("SELECT password_hash, mfa_secret_enc, mfa_last_step FROM users WHERE id = ?", [me.id]);
  if (!u || !(await checkPassword(password, u.password_hash)) || !verifyTotp(decrypt(u.mfa_secret_enc), code, u.mfa_last_step))
    throw new HttpError(400, "Password or code is wrong");
  await run("UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, recovery_codes = NULL WHERE id = ?", [me.id]);
  await logEvent("mfa.disabled", me.id);
  return Response.json({ ok: true });
});
