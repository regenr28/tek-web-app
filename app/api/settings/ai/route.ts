import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { publicAiSettings, saveAiSettings } from "@/lib/ai";

const Prov = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(120).regex(/^[\w./:@-]*$/).optional(),
  baseUrl: z.string().trim().max(300).refine((u) => u === "" || /^https:\/\//i.test(u) || (process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL), "must be https://").optional(),
  apiKey: z.string().trim().max(500).optional(),
  clearKey: z.boolean().optional(),
}).strict();
const Body = z.object({
  order: z.array(z.enum(["gemini", "groq", "openrouter", "custom"])).max(4).optional(),
  visionAlt: z.boolean().optional(),
  providers: z.object({ gemini: Prov.optional(), groq: Prov.optional(), openrouter: Prov.optional(), custom: Prov.optional() }).strict().optional(),
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
