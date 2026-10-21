import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { loadProject } from "@/lib/projects";
import { getPhotos, updatePhotos, photosText, OTHER_LIST } from "@/lib/photos";
import { visionProviders } from "@/lib/ai";
import { splitLinesKeep } from "@/lib/collect";

async function view(id: number) {
  const s = await getPhotos(id);
  let services = s.services;
  if (!services.length) { try { services = splitLinesKeep((await loadProject(id)).collection.fields.services.value); } catch { /* no project data */ } }
  const zips = new Set(s.results.map((r) => r.zip));
  return { services, others: OTHER_LIST, results: s.results, providers: await visionProviders(), text: photosText({ services, results: s.results }, zips.size > 1) };
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  return Response.json(await view(await idOf(ctx)));
});

/** Save the services list, move a photo to another group, or clear all results. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const body = await parseBody(req, z.object({
    services: z.string().max(8000).optional(),
    move: z.object({ key: z.string().max(600), category: z.string().max(200) }).optional(),
    clear: z.boolean().optional(),
  }).strict());
  const id = await idOf(ctx);
  await updatePhotos(id, body);
  return Response.json(await view(id));
});
