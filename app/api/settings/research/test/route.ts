import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, rateLimit } from "@/lib/security";
import { SEARCH_IDS, testSearchProvider, type SearchProviderId } from "@/lib/search";

export const maxDuration = 300;
const Body = z.object({ id: z.enum(SEARCH_IDS as [SearchProviderId, ...SearchProviderId[]]) }).strict();

export const POST = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  const { id } = await parseBody(req, Body);
  await rateLimit(`searchtest:${me.id}`, 20, 3600);
  try { return Response.json({ ok: true, message: await testSearchProvider(id) }); }
  catch (e) { return Response.json({ ok: false, message: (e as Error).message.slice(0, 300) }); }
});
