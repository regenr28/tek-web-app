import { handle, requireUser } from "@/lib/auth";
import { applyUpdate } from "@/lib/findings";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { FindingUpdate } from "@/lib/validators";

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  await applyUpdate([id], await parseBody(req, FindingUpdate), me.id);
  return Response.json({ ok: true });
});
