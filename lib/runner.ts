import { timingSafeEqual } from "crypto";
import { one, run } from "./db";
import { sha256, randomToken } from "./secrets";
import { loadProject, saveProject, jiraRaw } from "./projects";
import { STEPS, stepGbp, stepWebsite, stepSearch, stepCrossCheck, stepAi, stepReview, type StepId } from "./research";
import { HttpError } from "./security";
import { generateHomepage } from "./homepage";

/**
 * Research runs on the server as a "job", so it keeps going when the person leaves the page or closes the tab.
 * Each server call runs steps for up to ~2 minutes, then hands the rest to a fresh call (Vercel limits one call
 * to 5 minutes). If a hand-off is ever lost, the next time anyone opens the project the job resumes.
 */

export const STEP_IDS = STEPS.map((s) => s.id) as StepId[];
/** Everything a background job can run: the research steps + writing the homepage content. */
export type JobStep = StepId | "homepage";
export const JOB_STEPS = [...STEP_IDS, "homepage"] as JobStep[];
export type JobLine = { step: JobStep; ok: boolean; summary: string; at: string };
export type Job = { id: number; site_id: number; steps: JobStep[]; idx: number; status: "queued" | "running" | "stopping" | "stopped" | "done" | "failed"; log: JobLine[]; updated_at: string };

const BUDGET_MS = Number(process.env.RESEARCH_BUDGET_MS) || 120_000; // start no new step after this (a single step can take ~2.5 min with Apify)
const LEASE_MS = 330_000;    // a run that stopped answering for this long is considered dead and can be resumed

type Row = { id: number; site_id: number; steps: string; idx: number; status: string; log: string; updated_at: string; lease_until: number; token_hash: string };
const parse = (r: Row): Job => ({ id: r.id, site_id: r.site_id, steps: JSON.parse(r.steps), idx: r.idx, status: r.status as Job["status"], log: JSON.parse(r.log), updated_at: r.updated_at });

/** Runs one research step on a project and saves it — keeping any edits the person made while it ran. */
export async function runStep(siteId: number, step: JobStep): Promise<{ ok: boolean; summary: string }> {
  if (step === "homepage") {
    try { return await generateHomepage(siteId); } catch (e) { return { ok: false, summary: (e as Error).message.slice(0, 300) }; }
  }
  const p = await loadProject(siteId);
  if (!p.jira) throw new HttpError(400, "Import the Jira export first");
  const c = p.collection, ev = p.evidence;
  const startFields = JSON.stringify(c.fields), startLocs = c.locations.map((L) => JSON.stringify(L.fields));
  const snapshot = JSON.parse(startFields) as typeof c.fields;
  const snapLocs = c.locations.map((L) => JSON.parse(JSON.stringify(L.fields)) as typeof L.fields);
  const raw = jiraRaw(p.jira.fields);
  let summary = "", ok = true;
  try {
    if (step === "gbp") summary = await stepGbp(c, ev);
    else if (step === "website") summary = await stepWebsite(c, ev);
    else if (step === "search") summary = await stepSearch(c, ev);
    else if (step === "check") summary = await stepCrossCheck(c, ev, raw);
    else if (step === "ai") summary = await stepAi(c, ev, raw);
    else summary = await stepReview(c, raw);
  } catch (e) { ok = false; summary = (e as Error).message.slice(0, 300); }
  // Did the person edit something while the step was running? Their edit wins.
  const latest = await loadProject(siteId);
  if (JSON.stringify(latest.collection.fields) !== startFields) {
    for (const k of Object.keys(c.fields) as (keyof typeof c.fields)[]) {
      if (JSON.stringify(latest.collection.fields[k]) !== JSON.stringify(snapshot[k])) c.fields[k] = latest.collection.fields[k];
    }
  }
  if (latest.collection.locations.length === c.locations.length) latest.collection.locations.forEach((L, i) => {
    if (JSON.stringify(L.fields) === startLocs[i]) return;
    for (const k of Object.keys(L.fields) as (keyof typeof L.fields)[]) if (JSON.stringify(L.fields[k]) !== JSON.stringify(snapLocs[i][k])) c.locations[i].fields[k] = L.fields[k];
  });
  if (latest.collection.pages.join("|") !== p.collection.pages.join("|")) c.pages = latest.collection.pages;
  c.research[step] = { at: new Date().toISOString(), ok, summary };
  await saveProject(siteId, c, ev);
  return { ok, summary };
}

export async function latestJob(siteId: number): Promise<(Job & { stale: boolean }) | null> {
  const r = await one<Row>("SELECT * FROM jobs WHERE site_id = ? ORDER BY id DESC LIMIT 1", [siteId]);
  if (!r) return null;
  const j = parse(r);
  return { ...j, stale: ["queued", "running", "stopping"].includes(j.status) && r.lease_until < Date.now() };
}

/** Starts a run (or returns the one already going for this project). Returns the job and its hand-off token. */
export async function createJob(siteId: number, steps: JobStep[], userId: number): Promise<{ job: Job; token: string; existing: boolean }> {
  const cur = await latestJob(siteId);
  if (cur && ["queued", "running", "stopping"].includes(cur.status) && !cur.stale) return { job: cur, token: "", existing: true };
  if (cur && cur.stale) await run("UPDATE jobs SET status = 'stopped', updated_at = datetime('now') WHERE id = ?", [cur.id]);
  const token = randomToken(32);
  const r = await run("INSERT INTO jobs (site_id, steps, status, token_hash, user_id) VALUES (?, ?, 'queued', ?, ?)", [siteId, JSON.stringify(steps), sha256(token), userId]);
  const job = (await latestJob(siteId))!;
  return { job: { ...job, id: r.lastId || job.id }, token, existing: false };
}

export async function stopJob(siteId: number) {
  await run("UPDATE jobs SET status = CASE WHEN status = 'queued' THEN 'stopped' ELSE 'stopping' END, updated_at = datetime('now') WHERE site_id = ? AND status IN ('queued','running')", [siteId]);
}

export async function checkToken(jobId: number, token: string) {
  const r = await one<{ token_hash: string }>("SELECT token_hash FROM jobs WHERE id = ?", [jobId]);
  if (!r || !token) return false;
  const a = Buffer.from(r.token_hash), b = Buffer.from(sha256(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** New hand-off token for a job (used when resuming a job whose hand-off was lost). */
export async function rotateToken(jobId: number) {
  const token = randomToken(32);
  await run("UPDATE jobs SET token_hash = ? WHERE id = ?", [sha256(token), jobId]);
  return token;
}

/**
 * Runs the job's remaining steps for up to BUDGET_MS, then asks `handOff` to continue in a fresh server call.
 * A lease makes sure two calls never run the same job at once.
 */
export async function runJob(jobId: number, token: string, handOff: (jobId: number, token: string) => Promise<void>) {
  const started = Date.now();
  const claim = await run("UPDATE jobs SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END, lease_until = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','running','stopping') AND lease_until < ?", [Date.now() + LEASE_MS, jobId, Date.now()]);
  if (!claim.changes) return; // someone else is running it, or it's finished
  for (;;) {
    const r = await one<Row>("SELECT * FROM jobs WHERE id = ?", [jobId]);
    if (!r) return;
    const j = parse(r);
    if (j.status === "stopping") { await run("UPDATE jobs SET status = 'stopped', lease_until = 0, updated_at = datetime('now') WHERE id = ?", [jobId]); return; }
    if (j.idx >= j.steps.length) { await run("UPDATE jobs SET status = 'done', lease_until = 0, updated_at = datetime('now') WHERE id = ?", [jobId]); return; }
    if (Date.now() - started > BUDGET_MS) {
      await run("UPDATE jobs SET lease_until = 0, updated_at = datetime('now') WHERE id = ?", [jobId]);
      await handOff(jobId, token).catch(() => { /* the next visit resumes it */ });
      return;
    }
    const step = j.steps[j.idx];
    let res: { ok: boolean; summary: string };
    try { res = await runStep(j.site_id, step); } catch (e) { res = { ok: false, summary: (e as Error).message.slice(0, 300) }; }
    const log = [...j.log, { step, ok: res.ok, summary: res.summary, at: new Date().toISOString() }];
    await run("UPDATE jobs SET idx = idx + 1, log = ?, lease_until = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(log), Date.now() + LEASE_MS, jobId]);
  }
}

/** Where a server call can reach this same app to continue a job. */
export function selfBase(req: Request) {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(req.url).origin;
}

export function makeHandOff(base: string, path = "/api/jobs/{id}/continue") {
  return async (jobId: number, token: string) => {
    await fetch(`${base}${path.replace("{id}", String(jobId))}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "x-job-token": token }, body: "{}", signal: AbortSignal.timeout(10_000) });
  };
}
