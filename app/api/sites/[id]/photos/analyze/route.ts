import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { analyzePhoto, markFailed, getPhotos } from "@/lib/photos";
import { visionProviders } from "@/lib/ai";

export const maxDuration = 120;

/** One photo (already shrunk in the browser) → which service it shows. The photo itself is not stored. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`photos:${me.id}`, 5000, 3600);
  const body = await parseBody(req, z.object({
    key: z.string().min(1).max(600), file: z.string().min(1).max(300), zip: z.string().max(200),
    mime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    b64: z.string().max(950_000).regex(/^[A-Za-z0-9+/=]+$/).optional(),
    failed: z.string().max(300).optional(),
  }).strict());
  const id = await idOf(ctx);
  if (body.failed) { await markFailed(id, { key: body.key, file: body.file, zip: body.zip, reason: body.failed }); return Response.json({ ok: true, providers: await visionProviders() }); }
  if (!body.b64 || !body.mime) return Response.json({ error: "No image" }, { status: 400 });
  const services = (await getPhotos(id)).services;
  const r = await analyzePhoto(id, { key: body.key, file: body.file, zip: body.zip, mime: body.mime, b64: body.b64, services });
  return Response.json({ ...r, providers: await visionProviders() });
});
