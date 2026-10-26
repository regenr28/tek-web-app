import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getAuditSettings, saveAuditSettings } from "@/lib/audit";

/** Pages every QA audit skips (e.g. /image-credits). */
export const GET = handle(async () => {
  await requireUser("member", { area: "projects" });
  return Response.json(await getAuditSettings());
});

export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, z.object({ ignorePaths: z.array(z.string().max(200)).max(50) }).strict());
  const r = await saveAuditSettings(b);
  await logEvent("audit.settings_saved", me.id, { ignorePaths: r.ignorePaths.length });
  return Response.json(r);
});
