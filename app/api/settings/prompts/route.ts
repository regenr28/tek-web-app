import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getPrompts, savePrompt, DEFAULT_PROMPTS, PROMPT_INFO, VARIABLES, type PromptKey } from "@/lib/prompts";

/** Location / FAQ / Meta / Service pages / URL redirect prompts (the homepage prompts have their own route). */
export const GET = handle(async () => {
  await requireUser("admin");
  return Response.json({ prompts: await getPrompts(), defaults: DEFAULT_PROMPTS, info: PROMPT_INFO, variables: VARIABLES });
});

const Body = z.object({ key: z.enum(PROMPT_INFO.map((p) => p.key) as [PromptKey, ...PromptKey[]]), text: z.string().max(30000) }).strict();

/** Save one prompt ("" = back to the default). */
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, Body);
  await savePrompt(b.key, b.text);
  await logEvent("prompts.saved", me.id, { key: b.key, reset: !b.text.trim() });
  return Response.json({ prompts: await getPrompts(), defaults: DEFAULT_PROMPTS, info: PROMPT_INFO, variables: VARIABLES });
});
