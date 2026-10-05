import { z } from "zod";
import { run } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseBody } from "@/lib/security";
import { FIELDS, LOC_FIELDS, PER_LOCATION, MSO_LABELS, toSheetTsv, toPlainText, sheetRows, newLocation, combinedCityState, checkPhone, type FieldKey, type LocKey } from "@/lib/collect";
import { HttpError } from "@/lib/security";
import { loadProject, saveProject, dudaSiteId, PREVIEW_HOST } from "@/lib/projects";
import { STEPS } from "@/lib/research";
import { searchAvailable } from "@/lib/search";
import { aiAvailable } from "@/lib/ai";
import { TYPE_LABEL } from "@/lib/jira";

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const p = await loadProject(id);
  const ev = p.evidence;
  return Response.json({
    collection: p.collection,
    labels: p.collection.locations.length ? FIELDS.filter((f) => !PER_LOCATION.includes(f.key)).map((f) => ({ ...f, label: MSO_LABELS[f.key] || f.label })) : FIELDS,
    locLabels: LOC_FIELDS,
    tsv: toSheetTsv(p.collection),
    text: toPlainText(p.collection),
    rows: sheetRows(p.collection),
    project: p.jira ? { ...p.jira.project, typeLabel: p.jira.project.type ? TYPE_LABEL[p.jira.project.type] : p.jira.project.typeLabel } : null,
    editorUrl: p.row.editor_url, previewUrl: p.row.preview_url,
    steps: STEPS,
    evidence: {
      gbpLocs: (ev.gbpLocs || []).map((g) => g ? { provider: g.provider, title: g.place?.title, address: g.place?.address, rating: g.place?.rating, reviews: g.place?.reviews, hours: g.place?.hours, at: g.at } : null),
      gbp: ev.gbp ? { provider: ev.gbp.provider, title: ev.gbp.place?.title, address: ev.gbp.place?.address, rating: ev.gbp.place?.rating, reviews: ev.gbp.place?.reviews, hours: ev.gbp.place?.hours, at: ev.gbp.at } : null,
      website: ev.website ? { url: ev.website.finalUrl, pages: ev.website.pages.filter((x) => /^https?:\/\//i.test(x.url)).map((x) => ({ url: x.url, title: x.title })), signals: ev.website.signals, at: ev.website.at } : null,
      search: ev.search ? { provider: ev.search.provider, queries: ev.search.queries, results: ev.search.results.filter((r) => /^https?:\/\//i.test(r.url)).slice(0, 25).map((r) => ({ title: r.title, url: r.url })), at: ev.search.at } : null,
    },
    available: { ...(await searchAvailable()), ai: await aiAvailable() },
  });
});

const FieldPatch = z.object({ value: z.string().max(20000).optional(), note: z.string().max(5000).optional(), status: z.enum(["ok", "review", "missing"]).optional() }).strict();
const Body = z.object({
  fields: z.partialRecord(z.enum(FIELDS.map((f) => f.key) as [FieldKey, ...FieldKey[]]), FieldPatch).optional(),
  pages: z.array(z.string().trim().max(120)).max(60).optional(),
  minAmenities: z.number().int().min(0).max(40).optional(),
  minServices: z.number().int().min(0).max(40).optional(),
  locations: z.array(z.object({
    index: z.number().int().min(0).max(49),
    fields: z.partialRecord(z.enum(LOC_FIELDS.map((f) => f.key) as [LocKey, ...LocKey[]]), FieldPatch).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().toUpperCase().regex(/^[A-Z]{0,2}$/).optional(),
  }).strict()).max(50).optional(),
  addLocation: z.literal(true).optional(),
  removeLocation: z.number().int().min(0).max(49).optional(),
}).strict();

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const id = await idOf(ctx);
  const b = await parseBody(req, Body);
  const p = await loadProject(id);
  const c = p.collection;
  type F = { value: string; note: string; status: string; manual?: boolean; source: string };
  const applyPatch = (f: F, v: z.infer<typeof FieldPatch>, phoneState?: string) => {
    if (v.value !== undefined && v.value !== f.value) {
      let val = v.value; let st = val.trim() ? "ok" : "missing";
      if (v.note === undefined) f.note = ""; // the old auto-note described the old value
      if (phoneState !== undefined && val.trim()) { // keep the (000) 000-0000 format and re-check the area code
        const ph = checkPhone(val, phoneState); val = ph.value;
        if (!ph.ok) { st = "review"; if (v.note === undefined) f.note = ph.note; }
      }
      f.value = val; f.manual = true; f.source = "manual"; f.status = st;
    }
    if (v.note !== undefined) f.note = v.note;
    if (v.status) f.status = v.status;
  };
  const stateOf = (cs: string) => cs.split(",").pop()?.trim().slice(0, 2).toUpperCase() || "";
  for (const [k, v] of Object.entries(b.fields || {}) as [FieldKey, z.infer<typeof FieldPatch>][]) applyPatch(c.fields[k], v, k === "phone" ? stateOf(c.fields.cityState.value) : undefined);
  if (b.pages) c.pages = b.pages.filter(Boolean);
  for (const lp of b.locations || []) {
    const L = c.locations[lp.index];
    if (!L) throw new HttpError(400, `There is no location ${lp.index + 1}.`);
    if (lp.state !== undefined) L.state = lp.state;
    for (const [k, v] of Object.entries(lp.fields || {}) as [LocKey, z.infer<typeof FieldPatch>][]) applyPatch(L.fields[k] as F, v, k === "phone" ? L.state : undefined);
    if (lp.city !== undefined) L.city = lp.city;
  }
  if (b.addLocation) {
    if (!c.locations.length) {
      // turning a single-location sheet into MSO: move the current values into location 1
      const L1 = newLocation();
      for (const k of ["address", "gbpLink", "placeId", "phone", "email", "hours", "socials"] as const) L1.fields[k] = { ...c.fields[k] };
      const [city, state] = c.fields.cityState.value.split(",").map((x) => x.trim());
      L1.city = city || ""; L1.state = state || "";
      c.locations.push(L1);
      for (const k of PER_LOCATION) c.fields[k] = { value: "", note: "Per location — see the Locations section.", source: "rule", status: "ok" };
    }
    const n = newLocation();
    const first = c.locations[0];
    n.fields.phone = { ...first.fields.phone, note: "Copied from location 1 — replace if this shop has its own number." };
    n.fields.email = { ...first.fields.email };
    n.fields.hours = { ...first.fields.hours, note: "Copied from location 1." };
    c.locations.push(n);
  }
  if (b.removeLocation !== undefined) {
    if (!c.locations[b.removeLocation]) throw new HttpError(400, `There is no location ${b.removeLocation + 1}.`);
    c.locations.splice(b.removeLocation, 1);
  }
  if (c.locations.length && !c.fields.cityState.manual) c.fields.cityState.value = combinedCityState(c.locations) || c.fields.cityState.value;
  if (b.minAmenities !== undefined) c.minAmenities = b.minAmenities;
  if (b.minServices !== undefined) c.minServices = b.minServices;

  // Editor URL → Duda site id → preview link (if we don't have one yet)
  const editor = c.fields.editorUrl.value.trim();
  if (editor && editor !== p.row.editor_url) {
    const sid = dudaSiteId(editor);
    if (!sid) { c.fields.editorUrl.status = "review"; c.fields.editorUrl.note = "That doesn't look like a Duda editor link (https://my.duda.co/home/site/<id>/home)."; }
    else {
      await run("UPDATE sites SET duda_site_id = ?, preview_url = CASE WHEN preview_url = '' OR preview_url IS NULL THEN ? ELSE preview_url END WHERE id = ?",
        [sid, `https://${PREVIEW_HOST}/preview/${sid}`, id]);
    }
  }
  await saveProject(id, c);
  return Response.json({ ok: true, collection: c, tsv: toSheetTsv(c), text: toPlainText(c), rows: sheetRows(c) });
});
