import { z } from "zod";
import { run } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { parseBody } from "@/lib/security";

export const GET = handle(async () => {
  const u = await requireUser("member", { setup: true });
  return Response.json(u);
});

export const PATCH = handle(async (req: Request) => {
  const me = await requireUser("member", { setup: true });
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(1).max(80) }));
  await run("UPDATE users SET name = ? WHERE id = ?", [name, me.id]);
  return Response.json({ ok: true });
});
