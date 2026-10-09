import { z } from "zod";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody, rateLimit } from "@/lib/security";
import { loadProject } from "@/lib/projects";
import { aiAvailable } from "@/lib/ai";
import {
  getPromptState, savePromptState, isOnePager, serviceAreasOf, splitAreas, metaPagesFor, defaultServices, defaultOldUrls, promptVars,
  getPromptRules, rulesFor, genLocation, genFaq, genMeta, genServicePage, genRedirects, scanDestination, metaCsv, metaText, servicesCsv, serviceText, redirectCsvParts,
  type PromptState,
} from "@/lib/prompts";

export const maxDuration = 300;

async function view(siteId: number, st?: PromptState) {
  const p = await loadProject(siteId);
  const s = st || (await getPromptState(siteId));
  const services = s.services ?? defaultServices(p.collection);
  const onePager = isOnePager(p.row);
  const areas = serviceAreasOf(s, p.evidence);
  const rules = await getPromptRules();
  return {
    onePager, template: p.row.template, projectType: p.row.project_type,
    vars: promptVars(p.collection, p.row, s.services, areas.list),
    rules: Object.fromEntries((["location", "faq", "meta", "services", "redirects"] as const).map((k) => [k, rulesFor(rules, k)])) as Record<"location" | "faq" | "meta" | "services" | "redirects", string[]>,
    services,
    metaPagesDefault: metaPagesFor(p.collection, p.row),
    oldUrlsDefault: defaultOldUrls(p.evidence),
    destUrlDefault: p.row.preview_url || "",
    serviceAreas: areas,
    domain: p.collection.fields.domain.value,
    location: s.location || null,
    faq: s.faq || null,
    meta: s.meta ? { ...s.meta, text: metaText(s.meta.rows), csv: metaCsv(s.meta.rows) } : null,
    servicePages: Object.fromEntries(Object.entries(s.servicePages || {}).map(([k, v]) => [k, { ...v, text: serviceText(k, v) }])),
    servicesCsv: s.servicePages && Object.keys(s.servicePages).length ? servicesCsv(s, services) : "",
    redirects: s.redirects ? { ...s.redirects, csvParts: redirectCsvParts(s.redirects.rows) } : null,
    ai: await aiAvailable(),
  };
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  return Response.json(await view(await idOf(ctx)));
});

const Gen = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), instruction: z.string().max(1500).optional() }).strict(),
  z.object({ kind: z.literal("faq"), instruction: z.string().max(1500).optional() }).strict(),
  z.object({ kind: z.literal("meta"), pages: z.array(z.string().trim().min(1).max(80)).max(40).optional(), instruction: z.string().max(1500).optional() }).strict(),
  z.object({ kind: z.literal("service"), service: z.string().trim().min(1).max(120), instruction: z.string().max(1500).optional() }).strict(),
  z.object({ kind: z.literal("scan"), url: z.string().trim().min(4).max(500) }).strict(),
  z.object({
    kind: z.literal("redirects"), oldText: z.string().max(200000), destUrl: z.string().max(500), destText: z.string().max(50000),
    fullAnchors: z.boolean(), instruction: z.string().max(1500).optional(),
  }).strict(),
]);

/** Write (or revise, with an instruction) one kind of content. Each call is one AI request. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  await rateLimit(`prompts:${me.id}`, 200, 3600);
  const b = await parseBody(req, Gen);
  const rev = "instruction" in b && b.instruction?.trim() ? { instruction: b.instruction } : undefined;
  if (b.kind === "scan") return Response.json(await scanDestination(b.url).catch((e) => { throw new HttpError(400, `Couldn't scan that site: ${(e as Error).message.slice(0, 160)}`); }));
  if (b.kind === "location") await genLocation(id, rev);
  else if (b.kind === "faq") await genFaq(id, rev);
  else if (b.kind === "meta") await genMeta(id, b.pages, rev);
  else if (b.kind === "service") await genServicePage(id, b.service, rev);
  else await genRedirects(id, { oldText: b.oldText, destUrl: b.destUrl, destText: b.destText, fullAnchors: b.fullAnchors }, rev);
  return Response.json(await view(id));
});

const Edit = z.object({
  services: z.array(z.string().trim().min(1).max(120)).max(30).nullable().optional(),
  /** cities the shop covers, as pasted (one per line or "Elburn, IL · Batavia, IL"); null = back to what research found */
  serviceAreas: z.string().max(4000).nullable().optional(),
  locationText: z.string().max(20000).optional(),
  faqText: z.string().max(20000).optional(),
  metaRows: z.array(z.object({ page: z.string().max(80), title: z.string().max(300), description: z.string().max(600) }).strict()).max(40).optional(),
  service: z.object({
    name: z.string().max(120),
    sections: z.array(z.object({ label: z.string().max(60), title: z.string().max(300), content: z.string().max(20000) }).strict()).max(6).optional(),
    metaTitle: z.string().max(300).optional(), metaDescription: z.string().max(600).optional(),
    remove: z.literal(true).optional(),
  }).strict().optional(),
  redirectRows: z.array(z.object({ from: z.string().max(500), to: z.string().max(500), type: z.string().max(5) }).strict()).max(2000).optional(),
}).strict();

/** Save the person's own edits. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireUser("member", { area: "projects" });
  const id = await idOf(ctx);
  const b = await parseBody(req, Edit);
  const st = await getPromptState(id);
  if (b.serviceAreas !== undefined) { const list = b.serviceAreas === null ? [] : splitAreas(b.serviceAreas); if (list.length) st.serviceAreas = list; else delete st.serviceAreas; }
  if (b.services !== undefined) { if (b.services === null) delete st.services; else st.services = [...new Set<string>(b.services)]; }
  if (b.locationText !== undefined && st.location) st.location.text = b.locationText;
  if (b.faqText !== undefined && st.faq) st.faq.text = b.faqText;
  if (b.metaRows && st.meta) st.meta.rows = b.metaRows;
  if (b.service) {
    const sp = st.servicePages?.[b.service.name];
    if (!sp) throw new HttpError(404, "Service page not found");
    if (b.service.remove) delete st.servicePages![b.service.name];
    else {
      if (b.service.sections) sp.sections = b.service.sections;
      if (b.service.metaTitle !== undefined) sp.metaTitle = b.service.metaTitle;
      if (b.service.metaDescription !== undefined) sp.metaDescription = b.service.metaDescription;
    }
  }
  if (b.redirectRows && st.redirects) st.redirects.rows = b.redirectRows.map((r) => ({ ...r, type: "301" }));
  await savePromptState(id, st);
  return Response.json(await view(id, st));
});
