import { z } from "zod";
import { one, run } from "@/lib/db";
import { handle, hashPassword, createSession, HttpError } from "@/lib/auth";
import { parseBody, rateLimit, clientIp, logEvent, passwordProblem } from "@/lib/security";
import { safeEqual, configProblems } from "@/lib/secrets";

const Body = z.object({
  setupToken: z.string().max(200),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().max(200),
});

/** First run only. Needs SETUP_TOKEN from Vercel env, so nobody else can claim the Super Admin account. */
export const POST = handle(async (req: Request) => {
  await rateLimit(`setup:${await clientIp()}`, 5, 900);
  const problems = configProblems();
  if (problems.length) throw new HttpError(503, `Server isn't configured yet. Missing env: ${problems.join(", ")}`);
  const b = await parseBody(req, Body);
  if (!safeEqual(b.setupToken, process.env.SETUP_TOKEN!)) {
    await logEvent("setup.bad_token", null);
    throw new HttpError(403, "Setup token is incorrect");
  }
  const pw = passwordProblem(b.password, b.email);
  if (pw) throw new HttpError(400, pw);
  if ((await one<{ n: number }>("SELECT COUNT(*) AS n FROM users"))?.n) throw new HttpError(403, "Setup already completed");
  const { lastId } = await run(
    "INSERT INTO users (email, name, password_hash, role, password_changed_at) VALUES (?,?,?, 'super_admin', datetime('now'))",
    [b.email, b.name, await hashPassword(b.password)]
  );
  await logEvent("setup.super_admin_created", lastId);
  await createSession(lastId, true);
  return Response.json({ ok: true });
});
