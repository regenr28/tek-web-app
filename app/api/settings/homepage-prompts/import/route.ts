import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { rateLimit, logEvent, parseBody } from "@/lib/security";
import { parsePromptRows, saveLibrary, getLibrary, builtinPrompts } from "@/lib/homepage";

export const maxDuration = 30;

/**
 * Import the prompts from the guidelines workbook. The browser opens the (often 5 MB+) .xlsx itself and sends only the
 * "My homepage prompt" sheet's cells — Vercel caps uploads at 4.5 MB. Replaces the current list.
 */
const Body = z.union([
  z.object({ rows: z.array(z.array(z.string().max(40000)).max(40)).min(1).max(5000) }).strict(),
  z.object({ builtin: z.literal(true) }).strict(),
]);

/** {rows}: the sheet's cells (xlsx, or a .txt/.tsv copy — the browser turns both into rows). {builtin}: the prompts shipped with the app. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("admin");
  await rateLimit(`hp-import:${me.id}`, 20, 3600);
  const b = await parseBody(req, Body);
  const cur = await getLibrary();
  const lib = "rows" in b ? parsePromptRows(b.rows) : { rules: "", prompts: builtinPrompts(), importedAt: new Date().toISOString() };
  await saveLibrary({ ...lib, rules: lib.rules || cur.rules });
  await logEvent("homepage.prompts_imported", me.id, { count: lib.prompts.length, builtin: !("rows" in b) });
  return Response.json(await getLibrary());
});
