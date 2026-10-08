import { z } from "zod";
import { all, one, run } from "@/lib/db";
import { handle, requireUser, hashPassword, HttpError, hasRole, ACCESS_VALUES } from "@/lib/auth";
import { parseBody, passwordProblem, logEvent } from "@/lib/security";

export const GET = handle(async () => {
  const me = await requireUser();
  const cols = hasRole(me, "admin") ? "id, email, name, role, active, access, mfa_enabled, last_login_at, created_at" : "id, email, name, role, active";
  return Response.json(await all(`SELECT ${cols} FROM users ORDER BY active DESC, name`));
});

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().max(200),
  role: z.enum(["member", "admin", "super_admin"]).default("member"),
  /** What they can open (Projects / All Websites). Only a Super Admin can set it. */
  access: z.enum(ACCESS_VALUES).optional(),
});

export const POST = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, Body);
  if (b.role !== "member" && !hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can create admins");
  if (b.access && b.access !== "all" && !hasRole(me, "super_admin")) throw new HttpError(403, "Only a Super Admin can limit what a member can see");
  const access = b.role === "super_admin" ? "all" : b.access || "all";
  const pw = passwordProblem(b.password, b.email);
  if (pw) throw new HttpError(400, `Temporary password: ${pw}`);
  if (await one("SELECT id FROM users WHERE email = ?", [b.email])) throw new HttpError(409, "That email already has an account");
  // Temporary password: the person must choose their own (and set up 2FA) on first sign-in.
  const { lastId } = await run("INSERT INTO users (email, name, password_hash, role, access, must_change_password) VALUES (?,?,?,?,?,1)",
    [b.email, b.name, await hashPassword(b.password), b.role, access]);
  await logEvent("user.created", me.id, { target: lastId, role: b.role, access });
  return Response.json({ id: lastId });
});
