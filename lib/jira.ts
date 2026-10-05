import { readXlsx } from "./xlsx";
import { assertSafeZip, isZip } from "./parse";
import { HttpError } from "./security";

/** All values per Jira field (multi-select fields repeat the same column name). Keys have "Custom field (…)" removed. */
export type JiraFields = Record<string, string[]>;
export type ProjectType = "basic" | "advanced" | "mso";

export type JiraProject = {
  key: string;
  summary: string;
  url: string;
  shopName: string;
  type: ProjectType | null;
  typeLabel: string;
  templateNumber: string;
  template: string;           // e.g. "Single Location Template 31"
  pages: string[];            // requested pages (incl. "other pages")
  previewUrl: string;
  liveUrl: string;
  tekmetricId: string;
  created: string;
  activity: { type: string; author: string; date: string; details: string }[];
};

export const TYPE_LABEL: Record<ProjectType, string> = {
  basic: "Basic Site (Single Page Site)",
  advanced: "Advanced Site (Multi-Page Site)",
  mso: "MSO Site (Multiple Shops, 1 Site)",
};
// Same wording as the team's sheet: "HP Only - Single Location 28", "Single Location Template 31", "MSO Design 14"
const TEMPLATE_PREFIX: Record<ProjectType, string> = { basic: "HP Only - Single Location", advanced: "Single Location Template", mso: "MSO Design" };

const clean = (k: string) => k.replace(/^Custom field \((.*)\)$/i, "$1").replace(/\)Id$/, " Id").trim();

export function parseJiraXlsx(buf: Uint8Array): { fields: JiraFields; activity: JiraProject["activity"] } {
  if (!isZip(buf)) throw new HttpError(400, "That isn't an XLSX file. In Jira, use Export → Export Excel.");
  assertSafeZip(buf);
  const sheets = readXlsx(buf);
  const main = sheets.find((s) => s.rows.length >= 2 && s.rows[0].length > 5) || sheets[0];
  if (!main || main.rows.length < 2) throw new HttpError(400, "No work item found in that export");
  const [head, vals] = main.rows;
  const fields: JiraFields = {};
  head.forEach((h, i) => {
    const v = (vals[i] || "").trim();
    if (!h || !v) return;
    const k = clean(h);
    (fields[k] ||= []).push(v);
  });
  const act = sheets.find((s) => /activity/i.test(s.name));
  const activity = (act?.rows.slice(1) || []).map((r) => ({ type: r[0] || "", author: r[1] || "", date: r[2] || "", details: (r[3] || "").slice(0, 4000) }));
  return { fields, activity };
}

/** First field whose name matches, all values joined. */
export function pick(f: JiraFields, ...patterns: RegExp[]): string {
  for (const re of patterns) {
    const k = Object.keys(f).find((x) => re.test(x));
    if (k) return f[k].join("\n").trim();
  }
  return "";
}
export function pickAll(f: JiraFields, re: RegExp): string[] {
  return Object.keys(f).filter((k) => re.test(k)).flatMap((k) => f[k]).map((s) => s.trim()).filter(Boolean);
}

export function detectType(f: JiraFields): { type: ProjectType | null; templateNumber: string; template: string } {
  const designKey = Object.keys(f).find((k) => /preferred.*design|design selection|template/i.test(k));
  const designVal = designKey ? f[designKey][0] : "";
  const hay = [pick(f, /^Website Type$/i), pick(f, /^Summary$/i), designKey || "", designVal].join(" | ");
  let type: ProjectType | null = null;
  if (/\bMSO\b|multiple shops/i.test(hay)) type = "mso";
  else if (/\bbasic\b|single page|\bHP only\b|home ?page only/i.test(hay)) type = "basic";
  else if (/advanced|multi-page|single location/i.test(hay)) type = "advanced";
  const num = designVal.match(/(\d+)(?:\.0+)?/)?.[1] || "";
  const template = type && num ? `${TEMPLATE_PREFIX[type]} ${num}` : designVal;
  return { type, templateNumber: num, template };
}

const httpOnly = (u: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : "");
const splitList = (s: string) => s.split(/[\n,;•|]+/).map((x) => x.trim()).filter((x) => x && !/^other$/i.test(x));

export function toProject(fields: JiraFields, activity: JiraProject["activity"]): JiraProject {
  const key = pick(fields, /^Issue key$/i);
  const t = detectType(fields);
  const pages = [
    ...pickAll(fields, /what pages do you want/i).filter((p) => !/^other$/i.test(p)),
    ...splitList(pick(fields, /what other pages/i)),
  ];
  return {
    key,
    summary: pick(fields, /^Summary$/i),
    url: key ? `https://tekmetric.atlassian.net/browse/${key}` : "",
    shopName: pick(fields, /^Name of Shop$/i, /^Shop Name$/i) || pick(fields, /^Summary$/i).split(" - ")[0],
    type: t.type,
    typeLabel: t.type ? TYPE_LABEL[t.type] : pick(fields, /^Website Type$/i),
    templateNumber: t.templateNumber,
    template: t.template,
    pages: [...new Set(pages)],
    previewUrl: httpOnly(pick(fields, /^Site Preview Link$/i)),
    liveUrl: httpOnly(pick(fields, /^Live Site URL$/i)),
    tekmetricId: pick(fields, /^Tekmetric ID$/i),
    created: pick(fields, /^Created$/i),
    activity,
  };
}
