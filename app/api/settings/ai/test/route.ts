import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { parseBody, rateLimit } from "@/lib/security";
import { callAI, PROVIDER_IDS } from "@/lib/ai";

export const maxDuration = 60;
export const POST = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  await rateLimit(`ai-test:${me.id}`, 20, 600);
  const { provider } = await parseBody(req, z.object({ provider: z.enum(PROVIDER_IDS) }));
  const t0 = Date.now();
  try {
    const r = await callAI({ only: provider, system: 'Reply with JSON only: {"ok":true,"said":"<one short sentence>"}', user: "Say hello to the QA team." });
    return Response.json({ ok: true, ms: Date.now() - t0, model: r.model, reply: r.text.slice(0, 200) });
  } catch (e) { throw new HttpError(400, (e as Error).message.slice(0, 300)); }
});
