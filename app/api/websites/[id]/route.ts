import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { one } from "@/lib/db";

/** Full details of the last domain check for one website. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const r = await one<{ health_json: string | null }>("SELECT health_json FROM websites WHERE id = ?", [id]);
  if (!r) throw new HttpError(404, "Not found");
  return Response.json({ info: r.health_json ? JSON.parse(r.health_json) : null });
});
