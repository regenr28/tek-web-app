import { handle, requireUser, HttpError } from "@/lib/auth";
import { dudaEnabled, templateList, templateNavBySite } from "@/lib/duda";
import { flattenNav, templateDefaults, keyOf, SELECTABLE } from "@/lib/navqa";

/** The team's templates (read only) — and, with ?site=<template site>, that template's menu and its must-build items. */
export const GET = handle(async (req: Request) => {
  await requireUser("member", { area: "projects" });
  if (!dudaEnabled()) throw new HttpError(400, "The site-settings connection isn't set up (Vercel env).");
  const site = new URL(req.url).searchParams.get("site") || "";
  const list = await templateList();
  if (site) {
    const t = list.find((x) => x.base_site_name === site);
    if (!t) throw new HttpError(404, "Template not found");
    const nav = await templateNavBySite(site);
    const items = flattenNav(nav).map((m) => ({ ...m, key: keyOf(m), selectable: SELECTABLE.includes(keyOf(m)) }));
    return Response.json({ name: t.template_name.trim(), items, mustBuild: templateDefaults(nav).map((m) => ({ title: m.title, url: m.url })) });
  }
  const family = (n: string) => (/^hp only\s*-\s*single/i.test(n) ? "HP Only - Single Location (Basic)" : /^single location template/i.test(n) ? "Single Location Template (Advanced)" : /^mso template/i.test(n) ? "MSO Template (MSO)" : "Other templates");
  return Response.json({
    templates: list.map((t) => ({ name: t.template_name.trim(), site: t.base_site_name, id: t.template_id, pages: t.template_properties?.page_count ?? null, editor: t.editor || "", family: family(t.template_name.trim()) }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name, undefined, { numeric: true })),
  });
});
