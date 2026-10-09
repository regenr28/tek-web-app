import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getPrompts, savePrompt, getPromptRules, savePromptRules, DEFAULT_PROMPTS, PROMPT_INFO, VARIABLES, RULE_KEYS, type PromptKey, type RuleKey } from "@/lib/prompts";

/** Location / FAQ / Meta / Service pages / URL redirect prompts (the homepage prompts have their own route). */
const out = async () => Response.json({ prompts: await getPrompts(), rules: await getPromptRules(), defaults: DEFAULT_PROMPTS, info: PROMPT_INFO, variables: VARIABLES });

export const GET = handle(async () => {
  await requireUser("admin");
  return out();
});

const Body = z.union([
  z.object({ key: z.enum(PROMPT_INFO.map((p) => p.key) as [PromptKey, ...PromptKey[]]), text: z.string().max(30000) }).strict(),
  z.object({ rules: z.enum(RULE_KEYS as [RuleKey, ...RuleKey[]]), text: z.string().max(8000) }).strict(),
]);

/** Save one prompt ("" = back to the default), or the general rules for one prompt ("all" = every prompt). */
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, Body);
  if ("rules" in b) {
    await savePromptRules(b.rules, b.text);
    await logEvent("prompts.rules_saved", me.id, { key: b.rules, empty: !b.text.trim() });
  } else {
    await savePrompt(b.key, b.text);
    await logEvent("prompts.saved", me.id, { key: b.key, reset: !b.text.trim() });
  }
  return out();
});
