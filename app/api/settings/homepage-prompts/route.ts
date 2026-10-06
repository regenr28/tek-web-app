import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getLibrary, saveLibrary } from "@/lib/homepage";
import { randomToken } from "@/lib/secrets";

/** The team's homepage prompts (one per template) + global writing rules. */
export const GET = handle(async () => {
  await requireUser("admin");
  return Response.json(await getLibrary());
});

const Body = z.object({
  rules: z.string().max(10000),
  prompts: z.array(z.object({ id: z.string().max(40).optional(), name: z.string().trim().min(1).max(160), prompt: z.string().min(1).max(30000) }).strict()).max(300),
}).strict();

export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, Body);
  const cur = await getLibrary();
  await saveLibrary({ rules: b.rules, prompts: b.prompts.map((p) => ({ id: p.id || randomToken(6), name: p.name, prompt: p.prompt })), importedAt: cur.importedAt });
  await logEvent("homepage.prompts_saved", me.id, { count: b.prompts.length });
  return Response.json(await getLibrary());
});
