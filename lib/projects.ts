import { one, run } from "./db";
import { HttpError } from "./security";
import { parseJiraXlsx, toProject, pick, type JiraFields, type JiraProject } from "./jira";
import { fromJira, normalizeCollection, applyRules, toFacts, type Collection, FIELDS } from "./collect";
import type { Evidence } from "./research";

// ---------- template rules (how many amenities a template needs) ----------

export type TemplateRules = { defaultAmenities: number; defaultServices: number; rules: { match: string; amenities: number }[] };
const DEFAULT_RULES: TemplateRules = { defaultAmenities: 8, defaultServices: 8, rules: [] };

export async function getTemplateRules(): Promise<TemplateRules> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'templates'");
  return row ? { ...DEFAULT_RULES, ...(JSON.parse(row.value) as Partial<TemplateRules>) } : DEFAULT_RULES;
}
export async function saveTemplateRules(r: TemplateRules) {
  await run("INSERT INTO settings (key, value) VALUES ('templates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(r)]);
}
export function amenitiesFor(template: string, r: TemplateRules) {
  const t = template.toLowerCase();
  return r.rules.find((x) => x.match && t.includes(x.match.toLowerCase()))?.amenities ?? r.defaultAmenities;
}

// ---------- Duda links ----------

export const PREVIEW_HOST = process.env.DUDA_PREVIEW_HOST || "websites.tekmetric.site";
export function dudaSiteId(editorUrl: string) {
  return editorUrl.match(/my\.duda\.co\/home\/site\/([a-z0-9]+)/i)?.[1] || editorUrl.match(/\/site\/([a-z0-9]+)/i)?.[1] || "";
}

// ---------- the compact Jira values the AI sees ----------

export function jiraRaw(f: JiraFields) {
  return {
    shopName: pick(f, /^Name of Shop$/i, /^Shop Name$/i), address: pick(f, /^Shop Address$/i), phone: pick(f, /^Shop Phone Number$/i),
    hours: pick(f, /^Shop Hours$/i), services: pick(f, /^Primary Services$/i), amenities: pick(f, /^Amenities$/i),
    coupons: pick(f, /^Coupons$/i), about: pick(f, /^About Us$/i), website: pick(f, /^Current Website$/i), domain: pick(f, /what is that domain/i),
    certifications: [pick(f, /select any relevant shop affiliations/i), pick(f, /list any other affiliations/i)].filter(Boolean).join(", "),
    vehiclesNotServiced: pick(f, /vehicles not serviced/i), instructions: pick(f, /^Instructions$/i),
  };
}

// ---------- load / save ----------

export type ProjectRow = {
  id: number; name: string; preview_url: string; editor_url: string | null; duda_site_id: string | null; jira_key: string | null;
  project_type: string | null; template: string | null; jira_json: string | null; collection_json: string | null; research_json: string | null;
};

export async function loadProject(id: number) {
  const r = await one<ProjectRow>("SELECT id, name, preview_url, editor_url, duda_site_id, jira_key, project_type, template, jira_json, collection_json, research_json FROM sites WHERE id = ?", [id]);
  if (!r) throw new HttpError(404, "Project not found");
  const jira = r.jira_json ? (JSON.parse(r.jira_json) as { fields: JiraFields; project: JiraProject }) : null;
  return {
    row: r, jira,
    collection: normalizeCollection(r.collection_json ? JSON.parse(r.collection_json) : null),
    evidence: (r.research_json ? JSON.parse(r.research_json) : {}) as Evidence,
  };
}

/** Saves the Data Collection and keeps the QA audit's "truth" facts in sync with it. */
export async function saveProject(id: number, c: Collection, ev?: Evidence) {
  applyRules(c);
  const facts = toFacts(c);
  await run(
    `UPDATE sites SET collection_json = ?, research_json = COALESCE(?, research_json), facts_json = ?, facts_source = 'Data Collection',
       editor_url = COALESCE(NULLIF(?, ''), editor_url), updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(c), ev ? JSON.stringify(ev).slice(0, 900_000) : null, JSON.stringify(facts), c.fields.editorUrl.value, id]
  );
}

/** Create (or refresh) a project from a Jira XLSX export. Re-importing keeps your own edits. */
export async function importJira(buf: Uint8Array, userId: number) {
  const { fields, activity } = parseJiraXlsx(buf);
  const project = toProject(fields, activity);
  if (!project.shopName) throw new HttpError(400, "Couldn't find the shop name in that export — is it a Website Build work item?");
  const rules = await getTemplateRules();
  const draft = fromJira(project, fields, { minAmenities: amenitiesFor(project.template, rules) });
  draft.minServices = rules.defaultServices;

  const existing = project.key ? await one<{ id: number; collection_json: string | null; editor_url: string | null; preview_url: string }>(
    "SELECT id, collection_json, editor_url, preview_url FROM sites WHERE jira_key = ?", [project.key]) : null;
  const jiraJson = JSON.stringify({ fields, project });

  if (existing) {
    const old = normalizeCollection(existing.collection_json ? JSON.parse(existing.collection_json) : null);
    for (const f of FIELDS) if (old.fields[f.key].manual || (old.fields[f.key].source && old.fields[f.key].source !== "jira" && old.fields[f.key].value)) draft.fields[f.key] = old.fields[f.key];
    draft.research = old.research;
    if (existing.editor_url && !draft.fields.editorUrl.value) draft.fields.editorUrl = old.fields.editorUrl;
    await run(`UPDATE sites SET name = ?, project_type = ?, template = ?, jira_json = ?, tekmetric_id = ?,
                 preview_url = CASE WHEN preview_url = '' THEN ? ELSE preview_url END, updated_at = datetime('now') WHERE id = ?`,
      [project.shopName, project.type, project.template, jiraJson, project.tekmetricId || null, project.previewUrl || "", existing.id]);
    await saveProject(existing.id, draft);
    return { id: existing.id, created: false, project };
  }
  const { lastId } = await run(
    `INSERT INTO sites (name, preview_url, jira_key, project_type, template, jira_json, tekmetric_id, duda_site_id, created_by, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'not_started')`,
    [project.shopName, project.previewUrl || "", project.key || null, project.type, project.template, jiraJson, project.tekmetricId || null,
      project.previewUrl.match(/\/preview\/([a-z0-9]+)/i)?.[1] || null, userId]
  );
  await saveProject(lastId, draft);
  return { id: lastId, created: true, project };
}
