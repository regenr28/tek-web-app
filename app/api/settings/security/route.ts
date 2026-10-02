import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getPolicy, savePolicy } from "@/lib/policy";

export const GET = handle(async () => { await requireUser("super_admin"); return Response.json(await getPolicy()); });

const Host = z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must look like example.com or *.example.com");
const Body = z.object({
  mfaRequired: z.enum(["all", "admins", "off"]).optional(),
  sessionIdleHours: z.number().int().min(1).max(24).optional(),
  sessionMaxDays: z.number().int().min(1).max(30).optional(),
  crawlHosts: z.array(Host).min(1).max(200).optional(),
});

export const PUT = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  const b = await parseBody(req, Body);
  const p = await savePolicy(b);
  await logEvent("settings.security_changed", me.id, b);
  return Response.json(p);
});
