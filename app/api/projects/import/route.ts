import { after } from "next/server";
import { handle, requireUser, HttpError } from "@/lib/auth";
import { rateLimit, logEvent } from "@/lib/security";
import { importJira, loadProject } from "@/lib/projects";
import { createJob, runJob, selfBase, makeHandOff, type JobStep } from "@/lib/runner";

export const runtime = "nodejs";
export const maxDuration = 300;

/** "Add Project": upload the Jira XLSX export → project + first Data Collection draft. */
export const POST = handle(async (req: Request) => {
  const me = await requireUser("member", { area: "projects" });
  await rateLimit(`jira-import:${me.id}`, 120, 3600);
  if (Number(req.headers.get("content-length") || 0) > 4.5 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose the Jira XLSX export");
  if (!/\.xlsx$/i.test(file.name)) throw new HttpError(400, "Upload the .xlsx file from Jira (Export → Export Excel)");
  if (file.size > 4 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
  const r = await importJira(new Uint8Array(await file.arrayBuffer()), me.id);
  await logEvent("project.imported", me.id, { site: r.id, key: r.project.key, created: r.created });

  // New project with an existing website: read it right away (all internal URLs, warranty text, NAPA/TechNet links).
  // Free — no search credits. If Jira lists NAPA AutoCare or TechNet, also check that program's shop profile.
  let autoResearch: JobStep[] = [];
  if (r.created) {
    try {
      const { collection: c } = await loadProject(r.id);
      if (c.fields.existingWebsite.value.trim()) autoResearch.push("website");
      if (/\bnapa\b|\btech\s?net\b/i.test(c.fields.certifications.value)) autoResearch.push("programs");
      if (autoResearch.length) {
        const { job, token, existing } = await createJob(r.id, autoResearch, me.id);
        if (!existing) { const handOff = makeHandOff(selfBase(req)); after(() => runJob(job.id, token, handOff)); }
      }
    } catch (e) { autoResearch = []; console.error("[import] auto research not started", e); }
  }
  return Response.json({ id: r.id, created: r.created, key: r.project.key, name: r.project.shopName, type: r.project.typeLabel, template: r.project.template, autoResearch });
});
