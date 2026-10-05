import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { publicAiSettings, saveAiSettings, PROVIDER_IDS } from "@/lib/ai";

const Prov = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(120).regex(/^[\w./:@-]*$/).optional(),
  baseUrl: z.string().trim().max(300).refine((u) => u === "" || /^https:\/\//i.test(u) || (process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL), "must be https://").optional(),
  accountId: z.string().trim().max(64).regex(/^[a-f0-9]*$/i, "must be the hex Account ID").optional(),
  apiKey: z.string().trim().max(500).optional(),
  clearKey: z.boolean().optional(),
}).strict();
const Body = z.object({
  order: z.array(z.enum(PROVIDER_IDS)).max(PROVIDER_IDS.length).optional(),
  visionAlt: z.boolean().optional(),
  providers: z.object(Object.fromEntries(PROVIDER_IDS.map((id) => [id, Prov.optional()])) as Record<(typeof PROVIDER_IDS)[number], z.ZodOptional<typeof Prov>>).strict().optional(),
}).strict();

export const GET = handle(async () => { await requireUser("super_admin"); return Response.json(await publicAiSettings()); });
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  const b = await parseBody(req, Body);
  await saveAiSettings(b);
  const changedKeys = Object.entries(b.providers || {}).filter(([, p]) => p?.apiKey || p?.clearKey).map(([k]) => k);
  await logEvent("settings.ai_changed", me.id, { keysChanged: changedKeys });
  return Response.json(await publicAiSettings());
});
