import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { one } from "@/lib/db";
import { getLibrary, getState, saveState, matchPrompt, lineIssue, lineLimits, toText, type HpState } from "@/lib/homepage";

async function view(siteId: number, st?: HpState) {
  const row = await one<{ template: string | null; project_type: string | null }>("SELECT template, project_type FROM sites WHERE id = ?", [siteId]);
  if (!row) throw new HttpError(404, "Project not found");
  const lib = await getLibrary();
  const s = st || (await getState(siteId));
  const suggested = matchPrompt(lib.prompts, row.template || "", row.project_type);
  const versions = s.versions.map((v) => ({
    ...v, text: toText(v),
    sections: v.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => ({ ...it, len: it.text.length, ...lineLimits(it), issue: lineIssue(it) })) })),
  }));
  return { template: row.template, prompts: lib.prompts.map((p) => ({ id: p.id, name: p.name })), suggested: suggested?.id || null, selected: s.selected || suggested?.id || null, versions, current: s.current };
}

/** Homepage content for a project: the generated versions + which template prompt to use. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  return Response.json(await view(await idOf(ctx)));
});

const Body = z.object({
  selected: z.string().max(40).optional(),
  current: z.number().int().min(0).max(10).optional(),
  edit: z.object({ version: z.number().int().min(0).max(10), item: z.string().max(20), text: z.string().max(5000) }).strict().optional(),
}).strict();

/** Pick the prompt, switch version, or edit one line. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const b = await parseBody(req, Body);
  const st = await getState(id);
  if (b.selected !== undefined) {
    const lib = await getLibrary();
    if (!lib.prompts.some((p) => p.id === b.selected)) throw new HttpError(400, "Unknown prompt");
    st.selected = b.selected;
  }
  if (b.current !== undefined && st.versions[b.current]) st.current = b.current;
  if (b.edit) {
    const v = st.versions[b.edit.version];
    const it = v?.sections.flatMap((s) => s.items).find((x) => x.id === b.edit!.item);
    if (!it) throw new HttpError(404, "Line not found");
    it.text = b.edit.text.replace(/\s+/g, " ").trim();
    it.edited = true;
    const ruleNotes = v.issues.filter((x) => /exclamation|without the state/.test(x) && !x.includes(`· ${it.label}:`));
    v.issues = [...v.sections.flatMap((s) => s.items.map((x) => (lineIssue(x) ? `${s.title} · ${x.label}: ${lineIssue(x)}` : "")).filter(Boolean)), ...ruleNotes];
  }
  await saveState(id, st);
  return Response.json(await view(id, st));
});
