import { handle, requireUser, HttpError } from "@/lib/auth";
import { listModels, PROVIDER_IDS, type ProviderId } from "@/lib/ai";

export const GET = handle(async (req: Request) => {
  await requireUser("super_admin");
  const p = new URL(req.url).searchParams.get("provider") as ProviderId;
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) throw new HttpError(400, "Unknown provider");
  try { return Response.json({ models: await listModels(p) }); } catch (e) { throw new HttpError(400, (e as Error).message); }
});
