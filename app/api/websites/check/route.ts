import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, rateLimit } from "@/lib/security";
import { checkOne } from "@/lib/websites";

export const maxDuration = 60;

/** Check one website's domain right now. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "websites" });
  await rateLimit(`website-check:${me.id}`, 300, 3600);
  const { id } = await parseBody(req, z.object({ id: z.number().int().positive() }).strict());
  await checkOne(id);
  return Response.json({ ok: true });
});
