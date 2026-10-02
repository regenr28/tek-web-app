import { z } from "zod";
import { one, run } from "@/lib/db";
import { handle, requireUser, checkPassword, hashPassword, destroyUserSessions, HttpError } from "@/lib/auth";
import { parseBody, passwordProblem, rateLimit, logEvent } from "@/lib/security";

const Body = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });

export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  await rateLimit(`pw:${me.id}`, 5, 900);
  const { currentPassword, newPassword } = await parseBody(req, Body);
  const u = await one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [me.id]);
  if (!u || !(await checkPassword(currentPassword, u.password_hash))) {
    await logEvent("password.change_bad_current", me.id);
    throw new HttpError(400, "Current password is wrong");
  }
  const problem = passwordProblem(newPassword, me.email);
  if (problem) throw new HttpError(400, problem);
  if (await checkPassword(newPassword, u.password_hash)) throw new HttpError(400, "New password must be different");
  await run("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?", [await hashPassword(newPassword), me.id]);
  await destroyUserSessions(me.id, true); // sign out every other device
  await logEvent("password.changed", me.id);
  return Response.json({ ok: true });
});
