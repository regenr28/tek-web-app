import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { publicSearchSettings, saveSearchSettings, SEARCH_IDS } from "@/lib/search";
import { getTemplateRules, saveTemplateRules } from "@/lib/projects";

export const GET = handle(async () => {
  await requireUser("admin");
  return Response.json({ search: await publicSearchSettings(), templates: await getTemplateRules() });
});

const Prov = z.object({ enabled: z.boolean().optional(), apiKey: z.string().trim().max(300).optional(), clearKey: z.boolean().optional() }).strict();
const Body = z.object({
  search: z.object({
    order: z.array(z.enum(SEARCH_IDS as [string, ...string[]])).max(3).optional(),
    providers: z.object({ serpapi: Prov.optional(), serper: Prov.optional(), tavily: Prov.optional() }).strict().optional(),
  }).strict().optional(),
  templates: z.object({
    defaultAmenities: z.number().int().min(0).max(40),
    defaultServices: z.number().int().min(0).max(40),
    rules: z.array(z.object({ match: z.string().trim().min(1).max(80), amenities: z.number().int().min(0).max(40) })).max(200),
  }).optional(),
}).strict();

export const PUT = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  const b = await parseBody(req, Body);
  if (b.search) await saveSearchSettings(b.search as Parameters<typeof saveSearchSettings>[0]);
  if (b.templates) await saveTemplateRules(b.templates);
  await logEvent("settings.research_changed", me.id, { keysChanged: Object.entries(b.search?.providers || {}).filter(([, p]) => p?.apiKey || p?.clearKey).map(([k]) => k), templates: !!b.templates });
  return Response.json({ search: await publicSearchSettings(), templates: await getTemplateRules() });
});
