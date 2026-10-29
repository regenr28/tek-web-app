/**
 * The QA audit as a background job on the server — it keeps going when you switch tabs, open another page or close
 * the browser. Several workers run at once (each page is its own task, every device of a page loads in parallel),
 * so a 60-page site takes minutes, not hours.
 *
 *   start → a "discover" task finds the pages → one "page" task per page (+ "ai-copy" / "ai-alt" tasks when AI is on)
 *   → when nothing is left, one worker runs the site-wide checks (finish) and marks the run done.
 *
 * Workers claim tasks one at a time (an atomic UPDATE), so any number can run safely. Each worker call stops taking
 * new tasks after ~4 minutes and hands off to a fresh call (Vercel limits a call to 5 minutes). If a hand-off is
 * lost, the status check (the open page asks every few seconds) starts new workers.
 */
import { all, one, run } from "./db";
import { sha256, randomToken } from "./secrets";
import { HttpError } from "./security";
import { auditOne, aiPage, finishRun, discoverPages, resetForRun, loadSite } from "./audit";
import { AiError } from "./ai";

export type AuditOpts = { aiCopy: boolean; aiAlt: boolean; aiGlobal: boolean; maxPages: number };
const WORKERS = () => Math.max(1, Math.min(12, Number(process.env.AUDIT_WORKERS) || 6));
const AI_PARALLEL = () => Math.max(1, Math.min(6, Number(process.env.AUDIT_AI_PARALLEL) || 3));
const BUDGET_MS = () => Number(process.env.AUDIT_BUDGET_MS) || 230_000;
const CLAIM_MS = 150_000; // a task not finished in this time is given to another worker
const STALE_MS = 75_000;  // no worker has reported for this long → start new ones

type RunRow = { id: number; site_id: number; status: string; phase: string; opts: string | null; skipped: string | null; note: string | null; started_ms: number | null; finished_ms: number | null; heartbeat: number; started_at: string; ai_enabled: number; token_hash: string | null };
type TaskRow = { id: number; run_id: number; site_id: number; kind: string; url: string | null; path: string | null; from_url: string | null; page_id: number | null; status: string; attempts: number; result: string | null; started_ms: number | null; finished_ms: number | null };

const ACTIVE = ["discovering", "pages", "finishing"];

/** The run going on for a site right now (if any). */
export async function activeRun(siteId: number): Promise<RunRow | null> {
  return one<RunRow>(`SELECT * FROM runs WHERE site_id = ? AND phase IN ('discovering','pages','finishing') AND status = 'running' ORDER BY id DESC LIMIT 1`, [siteId]);
}

/** Starts an audit (or returns the one already running). Returns the run and a hand-off token for the first worker. */
export async function startAuditJob(siteId: number, userId: number, o: AuditOpts): Promise<{ runId: number; token: string; existing: boolean }> {
  const cur = await activeRun(siteId);
  if (cur) return { runId: cur.id, token: "", existing: true };
  const site = await loadSite(siteId);
  if (!site.preview_url) throw new HttpError(400, "No preview link yet — paste the Duda Editor URL in Data Collection (or the preview link under Details).");
  const token = randomToken(32);
  const ai = o.aiCopy || o.aiAlt;
  const { lastId: runId } = await run("INSERT INTO runs (site_id, started_by, ai_enabled, phase, opts, token_hash, started_ms, heartbeat) VALUES (?,?,?,?,?,?,?,?)",
    [siteId, userId, ai ? 1 : 0, "discovering", JSON.stringify(o), sha256(token), Date.now(), Date.now()]);
  await run("INSERT INTO audit_tasks (run_id, site_id, kind) VALUES (?, ?, 'discover')", [runId, siteId]);
  return { runId, token, existing: false };
}

export async function checkRunToken(runId: number, token: string) {
  const r = await one<{ token_hash: string | null }>("SELECT token_hash FROM runs WHERE id = ?", [runId]);
  return !!r?.token_hash && !!token && r.token_hash === sha256(token);
}
async function rotate(runId: number) { const t = randomToken(32); await run("UPDATE runs SET token_hash = ? WHERE id = ?", [sha256(t), runId]); return t; }

/** Starts `n` workers (server-to-server calls with the run's token). */
export async function kick(base: string, siteId: number, runId: number, token: string, n = 1) {
  await Promise.all(Array.from({ length: n }, () =>
    fetch(`${base}/api/sites/${siteId}/audit/work`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "x-run-token": token }, body: JSON.stringify({ runId }), signal: AbortSignal.timeout(10_000) }).catch(() => {})));
}

/** Takes the next task (pages first come first; AI tasks are limited to a few at once for the free AI limits). */
async function claim(runId: number): Promise<TaskRow | null> {
  const now = Date.now();
  return one<TaskRow>(`UPDATE audit_tasks SET status = 'working', claimed_until = ?, attempts = attempts + 1, started_ms = COALESCE(started_ms, ?)
    WHERE id = (
      SELECT id FROM audit_tasks t WHERE run_id = ? AND not_before <= ?
        AND (status = 'pending' OR (status = 'working' AND claimed_until < ?))
        AND (kind NOT LIKE 'ai-%' OR (SELECT COUNT(*) FROM audit_tasks w WHERE w.run_id = t.run_id AND w.kind LIKE 'ai-%' AND w.status = 'working' AND w.claimed_until >= ?) < ?)
      ORDER BY CASE kind WHEN 'discover' THEN 0 WHEN 'page' THEN 1 ELSE 2 END, id LIMIT 1)
    AND (status = 'pending' OR claimed_until < ?)
    RETURNING *`, [now + CLAIM_MS, now, runId, now, now, now, AI_PARALLEL(), now]);
}
const done = (id: number, result: string, status = "done") => run("UPDATE audit_tasks SET status = ?, result = ?, finished_ms = ?, claimed_until = 0 WHERE id = ?", [status, result.slice(0, 500), Date.now(), id]);

/** One worker call: takes tasks until the time budget is used, then hands off if work is left. */
export async function runWorker(runId: number, base: string, token: string) {
  const t0 = Date.now();
  for (;;) {
    const r = await one<RunRow>("SELECT * FROM runs WHERE id = ?", [runId]);
    if (!r || r.status !== "running" || !ACTIVE.includes(r.phase)) return;
    await run("UPDATE runs SET heartbeat = ? WHERE id = ?", [Date.now(), runId]);
    if (Date.now() - t0 > BUDGET_MS()) { await kick(base, r.site_id, runId, token, 1); return; }
    const o: AuditOpts = r.opts ? JSON.parse(r.opts) : { aiCopy: false, aiAlt: false, aiGlobal: true, maxPages: 60 };
    const task = await claim(runId);
    if (!task) {
      const left = await one<{ n: number; soon: number | null }>("SELECT COUNT(*) AS n, MIN(CASE WHEN status = 'pending' THEN not_before END) AS soon FROM audit_tasks WHERE run_id = ? AND status IN ('pending','working')", [runId]);
      if (left?.n) {
        // only AI tasks waiting for a free slot / a rate-limit pause, or tasks other workers are on
        if (left.soon != null && left.soon - Date.now() < 40_000) { await new Promise((res) => setTimeout(res, Math.max(1500, Math.min(15_000, left.soon! - Date.now())))); continue; }
        const working = await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_tasks WHERE run_id = ? AND status = 'working'", [runId]);
        await new Promise((res) => setTimeout(res, working?.n ? 4000 : 2000));
        continue;
      }
      // nothing left: one worker runs the site-wide checks
      const mine = await run("UPDATE runs SET phase = 'finishing', heartbeat = ? WHERE id = ? AND phase = 'pages'", [Date.now(), runId]);
      if (!mine.changes) return;
      try {
        const f = await finishRun(r.site_id, runId, r.skipped ? JSON.parse(r.skipped) : []);
        await run("UPDATE runs SET phase = 'done', finished_ms = ?, note = ? WHERE id = ?", [Date.now(), f.settings || "", runId]);
      } catch (e) {
        await run("UPDATE runs SET phase = 'done', status = 'failed', finished_ms = ?, note = ? WHERE id = ?", [Date.now(), `Site-wide checks failed: ${(e as Error).message.slice(0, 200)}`, runId]);
      }
      return;
    }
    try {
      if (task.kind === "discover") {
        const site = await loadSite(r.site_id);
        const d = await discoverPages(site.preview_url, o.maxPages);
        await resetForRun(r.site_id, runId, o.aiCopy || o.aiAlt);
        for (let i = 0; i < d.pages.length; i += 50) {
          const part = d.pages.slice(i, i + 50);
          await run(`INSERT INTO audit_tasks (run_id, site_id, kind, url, path, from_url) VALUES ${part.map(() => "(?, ?, 'page', ?, ?, ?)").join(",")}`, part.flatMap((p) => [runId, r.site_id, p.url, p.path, p.from ?? null]));
        }
        await run("UPDATE runs SET phase = 'pages', skipped = ?, note = ? WHERE id = ?", [JSON.stringify(d.skipped || []), d.errors.join(" · ").slice(0, 500), runId]);
        await done(task.id, `Found ${d.pages.length} page(s)${d.skipped?.length ? ` · skipped ${d.skipped.join(", ")}` : ""}`);
        await kick(base, r.site_id, runId, token, Math.min(WORKERS(), Math.max(1, d.pages.length)) - 1);
      } else if (task.kind === "page") {
        const res = await auditOne(r.site_id, runId, task.url || "", task.from_url || undefined);
        const pageId = "pageId" in res ? res.pageId : undefined;
        if (pageId) {
          const kinds = [o.aiCopy ? "ai-copy" : "", o.aiAlt ? "ai-alt" : ""].filter(Boolean);
          for (const k of kinds) await run("INSERT INTO audit_tasks (run_id, site_id, kind, url, path, page_id) VALUES (?,?,?,?,?,?)", [runId, r.site_id, k, task.url, task.path, pageId]);
        }
        await done(task.id, res.error ? `✗ ${res.error}` : `${res.findings} finding(s)${"note" in res && res.note ? ` · ⚠ ${res.note}` : ""}`, res.error ? "failed" : "done");
      } else {
        const kind = task.kind === "ai-copy" ? "copy" : "alt";
        // the site's header/footer text is reviewed once, with the homepage
        const includeGlobal = o.aiGlobal && (task.path === "/" || !(await one("SELECT 1 FROM audit_tasks WHERE run_id = ? AND path = '/' AND kind = ?", [runId, task.kind])));
        try {
          const res = await aiPage(r.site_id, runId, task.page_id || 0, kind, !!includeGlobal);
          await done(task.id, `${res.findings} finding(s)${res.models.length ? ` · ${res.models.join(", ")}` : ""}`);
        } catch (e) {
          const msg = (e as Error).message;
          if ((e instanceof AiError || /429|rate|limit|timeout|temporar/i.test(msg)) && task.attempts < 4) {
            await run("UPDATE audit_tasks SET status = 'pending', claimed_until = 0, not_before = ?, result = ? WHERE id = ?", [Date.now() + 20_000 * task.attempts, `waiting — AI busy (${msg.slice(0, 80)})`, task.id]);
          } else await done(task.id, `✗ ${msg}`, "failed");
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (task.kind === "discover") {
        await done(task.id, `✗ ${msg}`, "failed");
        await run("UPDATE runs SET phase = 'done', status = 'failed', finished_ms = ?, note = ? WHERE id = ?", [Date.now(), `Couldn't find the pages: ${msg.slice(0, 200)}`, runId]);
        return;
      }
      if (task.attempts < 2) await run("UPDATE audit_tasks SET status = 'pending', claimed_until = 0, not_before = ? WHERE id = ?", [Date.now() + 5000, task.id]);
      else await done(task.id, `✗ ${msg}`, "failed");
    }
  }
}

/** Stop: tasks not started are cancelled; the site-wide checks still run on what was checked. */
export async function stopAuditJob(siteId: number) {
  const r = await activeRun(siteId);
  if (!r) return null;
  await run("UPDATE audit_tasks SET status = 'cancelled', finished_ms = ? WHERE run_id = ? AND status = 'pending'", [Date.now(), r.id]);
  if (r.phase === "discovering") await run("UPDATE runs SET phase = 'done', status = 'stopped', finished_ms = ? WHERE id = ?", [Date.now(), r.id]);
  return r.id;
}

const fmtPath = (t: TaskRow) => t.path || (t.kind === "discover" ? "Finding pages" : "?");

/** Everything the page shows while an audit runs (and after): progress, what's being checked, time left. */
export async function auditStatus(siteId: number, base: string, runId?: number) {
  const r = runId ? await one<RunRow>("SELECT * FROM runs WHERE id = ? AND site_id = ?", [runId, siteId]) : await one<RunRow>("SELECT * FROM runs WHERE site_id = ? AND started_ms IS NOT NULL ORDER BY id DESC LIMIT 1", [siteId]);
  if (!r) return { run: null };
  const tasks = await all<TaskRow>("SELECT id, kind, path, status, attempts, result, started_ms, finished_ms FROM audit_tasks WHERE run_id = ? ORDER BY id", [r.id]);
  const now = Date.now();
  const active = r.status === "running" && ACTIVE.includes(r.phase);
  // workers stopped answering (a lost hand-off): start new ones
  if (active && now - (r.heartbeat || 0) > STALE_MS) {
    const token = await rotate(r.id);
    const left = tasks.filter((t) => t.status === "pending" || t.status === "working").length;
    await run("UPDATE runs SET heartbeat = ? WHERE id = ?", [now, r.id]);
    await kick(base, siteId, r.id, token, Math.max(1, Math.min(WORKERS(), left)));
  }
  const count = (pred: (t: TaskRow) => boolean) => tasks.filter(pred).length;
  const isPage = (t: TaskRow) => t.kind === "page", isAi = (t: TaskRow) => t.kind.startsWith("ai-");
  const fin = (t: TaskRow) => ["done", "failed", "cancelled"].includes(t.status);
  const pageTimes = tasks.filter((t) => isPage(t) && t.status === "done" && t.started_ms && t.finished_ms).map((t) => t.finished_ms! - t.started_ms!);
  const aiTimes = tasks.filter((t) => isAi(t) && t.status === "done" && t.started_ms && t.finished_ms).map((t) => t.finished_ms! - t.started_ms!);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const o: AuditOpts | null = r.opts ? JSON.parse(r.opts) : null;
  const pagesLeft = count((t) => isPage(t) && !fin(t));
  const aiPerPage = (o?.aiCopy ? 1 : 0) + (o?.aiAlt ? 1 : 0);
  const aiLeft = count((t) => isAi(t) && !fin(t)) + pagesLeft * aiPerPage;
  const workers = Math.max(1, Math.min(WORKERS(), count((t) => t.status === "working") || WORKERS()));
  let etaMs: number | null = null;
  if (active && r.phase === "pages" && pageTimes.length) {
    const pageMs = (pagesLeft * avg(pageTimes)) / workers;
    const aiMs = (aiLeft * (avg(aiTimes) || 8000)) / AI_PARALLEL();
    etaMs = Math.round(Math.max(pageMs, aiMs) + 45_000); // + site-wide checks
  }
  const elapsedMs = (r.finished_ms || now) - (r.started_ms || now);
  const working = tasks.filter((t) => t.status === "working").map((t) => ({ kind: t.kind, path: fmtPath(t), forMs: t.started_ms ? now - t.started_ms : 0 }));
  const recent = tasks.filter((t) => fin(t) && t.finished_ms).sort((a, b) => (b.finished_ms || 0) - (a.finished_ms || 0)).slice(0, 40)
    .map((t) => ({ kind: t.kind, path: fmtPath(t), result: t.result || "", status: t.status, ms: t.started_ms && t.finished_ms ? t.finished_ms - t.started_ms : null }));
  const waiting = tasks.filter((t) => t.status === "pending" && t.result?.startsWith("waiting")).length;
  return {
    run: { id: r.id, phase: r.phase, status: r.status, active, note: r.note || "", startedMs: r.started_ms, finishedMs: r.finished_ms, elapsedMs, etaMs, opts: o },
    pages: { total: count(isPage), done: count((t) => isPage(t) && t.status === "done"), failed: count((t) => isPage(t) && t.status === "failed"), working: count((t) => isPage(t) && t.status === "working") },
    ai: { total: count(isAi), done: count((t) => isAi(t) && t.status === "done"), failed: count((t) => isAi(t) && t.status === "failed"), working: count((t) => isAi(t) && t.status === "working"), waiting },
    avgPageMs: Math.round(avg(pageTimes)), avgAiMs: Math.round(avg(aiTimes)),
    working, recent,
  };
}
