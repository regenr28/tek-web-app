import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { saveHealthSettings, healthSettings } from "@/lib/websites";

/** How often all domains are checked automatically. */
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, z.object({ schedule: z.enum(["off", "daily", "weekly"]) }).strict());
  await saveHealthSettings(b);
  await logEvent("websites.schedule", me.id, b);
  return Response.json(await healthSettings());
});
