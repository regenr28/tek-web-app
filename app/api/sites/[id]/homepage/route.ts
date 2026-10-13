import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { one } from "@/lib/db";
import { getLibrary, getState, saveState, matchPrompt, lineIssue, lineLimits, toText, refreshIssues, reviseHomepage, type HpState } from "@/lib/homepage";
import { getPromptState, savePromptState, defaultServices } from "@/lib/prompts";
import { loadProject } from "@/lib/projects";

export const maxDuration = 300;

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
  const ps = await getPromptState(siteId);
  const fromCollection = defaultServices((await loadProject(siteId)).collection);
  return { template: row.template, prompts: lib.prompts.map((p) => ({ id: p.id, name: p.name })), suggested: suggested?.id || null, selected: s.selected || suggested?.id || null, versions, current: s.current,
    services: ps.services ?? fromCollection, servicesFromCollection: fromCollection, servicesCustom: !!ps.services };
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
  undo: z.object({ version: z.number().int().min(0).max(10), item: z.string().max(20) }).strict().optional(),
  /** service topics for the Services section (null = back to Data Collection's Primary Services) */
  services: z.array(z.string().trim().min(1).max(120)).max(30).nullable().optional(),
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
    refreshIssues(v, [it]);
  }
  if (b.undo) {
    const v = st.versions[b.undo.version];
    const it = v?.sections.flatMap((s) => s.items).find((x) => x.id === b.undo!.item);
    if (!it || it.prev === undefined) throw new HttpError(404, "Nothing to undo");
    [it.text, it.prev] = [it.prev, it.text];
    refreshIssues(v, [it]);
  }
  if (b.services !== undefined) {
    const ps = await getPromptState(id);
    if (b.services === null) delete ps.services; else ps.services = [...new Set<string>(b.services)];
    await savePromptState(id, ps);
  }
  await saveState(id, st);
  return Response.json(await view(id, st));
});

const Revise = z.object({
  version: z.number().int().min(0).max(10),
  item: z.string().max(20).optional(),
  section: z.number().int().min(0).max(60).optional(),
  instruction: z.string().trim().min(2).max(1500),
}).strict().refine((x) => x.item || x.section !== undefined, "Pick a line or a section");

/** "Ask AI": rewrite one line or a whole section the way the person asks. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  await rateLimit(`hp-revise:${me.id}`, 120, 3600);
  const b = await parseBody(req, Revise);
  const r = await reviseHomepage(id, b);
  return Response.json({ ...(await view(id)), revised: r.changed });
});
