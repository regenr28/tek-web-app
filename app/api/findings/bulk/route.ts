import { handle, requireUser } from "@/lib/auth";
import { applyUpdate } from "@/lib/findings";
import { parseBody } from "@/lib/security";
import { BulkFindingUpdate } from "@/lib/validators";

export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "projects" });
  const { ids, ...rest } = await parseBody(req, BulkFindingUpdate);
  await applyUpdate(ids, rest, me.id);
  return Response.json({ ok: true });
});
