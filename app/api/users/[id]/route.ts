import { z } from "zod";
import { one, run } from "@/lib/db";
import { handle, requireUser, hashPassword, HttpError, hasRole, destroyUserSessions, ACCESS_VALUES, type Role } from "@/lib/auth";
import { parseBody, passwordProblem, logEvent } from "@/lib/security";
import { idOf, type Ctx } from "@/lib/http";

const Body = z.object({
  role: z.enum(["member", "admin", "super_admin"]).optional(),
  active: z.boolean().optional(),
  password: z.string().max(200).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  resetMfa: z.literal(true).optional(),
  unlock: z.literal(true).optional(),
  access: z.enum(ACCESS_VALUES).optional(),
  history: z.boolean().optional(),
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("admin");
  const id = await idOf(ctx);
  const target = await one<{ role: Role; email: string }>("SELECT role, email FROM users WHERE id = ?", [id]);
  if (!target) throw new HttpError(404, "User not found");
  if (target.role !== "member" && !hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can change admins");
  const b = await parseBody(req, Body);
  if (id === me.id && (b.role || b.active === false || b.resetMfa)) throw new HttpError(400, "You can't change your own role, status or 2FA here");

  if (b.role) {
    if (b.role !== "member" && !hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can grant admin roles");
    await run("UPDATE users SET role = ? WHERE id = ?", [b.role, id]);
    await destroyUserSessions(id);
    await logEvent("user.role_changed", me.id, { target: id, role: b.role });
  }
  if (b.access) {
    if (!hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can change what a member can see");
    if (id === me.id) throw new HttpError(400, "You can't change your own access");
    // Takes effect on their next request (access is read from the database each time).
    await run("UPDATE users SET access = ? WHERE id = ?", [b.access, id]);
    await logEvent("user.access_changed", me.id, { target: id, access: b.access });
  }
  if (typeof b.history === "boolean") {
    if (!hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can change what a member can see");
    if (id === me.id) throw new HttpError(400, "You can't change your own access");
    await run("UPDATE users SET can_history = ? WHERE id = ?", [b.history ? 1 : 0, id]);
    await logEvent("user.access_changed", me.id, { target: id, history: b.history });
  }
  if (typeof b.active === "boolean") {
    await run("UPDATE users SET active = ? WHERE id = ?", [b.active ? 1 : 0, id]);
    if (!b.active) await destroyUserSessions(id);
    await logEvent(b.active ? "user.reactivated" : "user.deactivated", me.id, { target: id });
  }
  if (b.name) await run("UPDATE users SET name = ? WHERE id = ?", [b.name, id]);
  if (b.password) {
    const pw = passwordProblem(b.password, target.email);
    if (pw) throw new HttpError(400, pw);
    await run("UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?", [await hashPassword(b.password), id]);
    await destroyUserSessions(id);
    await logEvent("user.password_reset", me.id, { target: id });
  }
  if (b.resetMfa) {
    if (!hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can reset 2FA");
    await run("UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, recovery_codes = NULL WHERE id = ?", [id]);
    await destroyUserSessions(id);
    await logEvent("user.mfa_reset", me.id, { target: id });
  }
  if (b.unlock) {
    await run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", [id]);
    await logEvent("user.unlocked", me.id, { target: id });
  }
  return Response.json({ ok: true });
});
