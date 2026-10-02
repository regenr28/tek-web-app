import { handle, requireUser, HttpError } from "@/lib/auth";
import { listModels, type ProviderId } from "@/lib/ai";

export const GET = handle(async (req: Request) => {
  await requireUser("super_admin");
  const p = new URL(req.url).searchParams.get("provider") as ProviderId;
  if (!["gemini", "groq", "openrouter", "custom"].includes(p)) throw new HttpError(400, "Unknown provider");
  try { return Response.json({ models: await listModels(p) }); } catch (e) { throw new HttpError(400, (e as Error).message); }
});
