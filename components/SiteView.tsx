"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ago, STATUS_LABEL, STATUS_TONE, type Member } from "./api";
import FactsEditor from "./FactsEditor";
import DataCollection from "./DataCollection";
import Prompts from "./Prompts";
import PhotoSorter from "./PhotoSorter";
import { emptyFacts, normalizeFacts, type Facts } from "@/lib/facts";

type Site = {
  id: number; name: string; preview_url: string; live_url: string | null; jira_key: string | null; duda_site_id: string | null; editor_url?: string | null;
  status: string; assignee_id: number | null; notes: string | null; facts: Facts | null; facts_source: string | null; facts_raw_text: string | null; last_run_id: number | null; has_project?: boolean; template?: string | null; project_type?: string | null;
};
type Run = { id: number; started_at: string; finished_at: string | null; status: string; page_count: number; finding_count: number; ai_enabled: number; started_by_name: string };
type PageRow = { id: number; url: string; path: string; title: string; status_code: number; error: string | null };
type Finding = {
  id: number; page_path: string; page_url: string | null; selector: string | null; category: string; severity: string; rule: string; message: string;
  expected: string | null; found: string | null; source: string; status: string; assignee_id: number | null; assignee_name: string | null; note: string | null;
  done_by_name: string | null; done_at: string | null;
};
type Me = { id: number; role: string };

export default function SiteView({ id, me }: { id: number; me: Me }) {
  const [data, setData] = useState<{ site: Site; lastRun: Run | null; pages: PageRow[]; dudaApi: boolean; ai: boolean } | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [tab, setTab] = useState<"collection" | "prompts" | "photos" | "findings" | "facts" | "pages" | "details" | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<typeof data>(`/api/sites/${id}`);
      setData(d);
      setFindings(await api<Finding[]>(`/api/sites/${id}/findings`));
    } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); api<Member[]>("/api/users").then((m) => setMembers(m.filter((x) => x.active))); }, [load]);
  useEffect(() => {
    if (!data || tab) return;
    const q = new URLSearchParams(window.location.search).get("tab");
    setTab(q === "homepage" || q === "prompts" ? "prompts" : q === "collection" || q === "photos" || q === "findings" || q === "facts" || q === "pages" || q === "details" ? q : data.site.has_project ? "collection" : "findings");
  }, [data]); // eslint-disable-line

  if (!data) return <p className="muted">{err || "Loading…"}</p>;
  const { site } = data;
  const patch = async (b: Record<string, unknown>) => { await api(`/api/sites/${id}`, { method: "PATCH", body: b }).catch((e) => setErr(e.message)); load(); };
  const open = findings.filter((f) => f.status === "open");

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <div className="small"><Link href="/">← Projects</Link></div>
          <h1 style={{ marginTop: 4 }}>{site.name} {site.jira_key && <span className="badge">{site.jira_key}</span>}</h1>
          {site.template && <span className="badge accent" style={{ marginRight: 6 }}>{site.template}</span>}
          {site.preview_url ? <a href={site.preview_url} target="_blank" rel="noreferrer" className="small">{site.preview_url} ↗</a> : <span className="muted small">No preview link yet</span>}
        </div>
        <div className="row">
          <select value={site.status} onChange={(e) => patch({ status: e.target.value })} style={{ width: 170 }} className={`badge ${STATUS_TONE[site.status]}`}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={site.assignee_id || ""} onChange={(e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null })} style={{ width: 170 }}>
            <option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      </div>

      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}

      {tab === "findings" && <AuditPanel site={site} lastRun={data.lastRun} aiAvailable={data.ai} onDone={load} onError={setErr} canManage={me.role !== "member"} />}

      {tab === "findings" && <div className="row">
        <div className="stat"><b style={{ color: "var(--error)" }}>{open.filter((f) => f.severity === "error").length}</b><span>Errors</span></div>
        <div className="stat"><b style={{ color: "var(--warning)" }}>{open.filter((f) => f.severity === "warning").length}</b><span>Warnings</span></div>
        <div className="stat"><b style={{ color: "var(--info)" }}>{open.filter((f) => f.severity === "info").length}</b><span>Info</span></div>
        <div className="stat"><b style={{ color: "var(--ok)" }}>{findings.filter((f) => f.status === "done").length}</b><span>Done</span></div>
        <div className="stat"><b>{findings.filter((f) => f.status === "resolved").length}</b><span>Auto-resolved</span></div>
      </div>}

      <div className="card">
        <div className="tabs">
          {(["collection", "prompts", "photos", "findings", "facts", "pages", "details"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "collection" ? "Data Collection" : t === "prompts" ? "Prompts" : t === "photos" ? "Photos" : t === "findings" ? `QA Audit (${open.length})` : t === "facts" ? <>QA facts {!site.facts && <span className="badge warning">missing</span>}</> : t === "pages" ? `Pages (${data.pages.length})` : "Details"}
            </button>
          ))}
        </div>
        {tab === "collection" && <DataCollection siteId={id} onChanged={load} />}
        {tab === "photos" && <PhotoSorter siteId={id} />}
        {tab === "prompts" && <Prompts siteId={id} canManage={me.role !== "member"} />}
        {tab === "findings" && <FindingsTable siteId={id} site={site} findings={findings} members={members} me={me} reload={load} onError={setErr} />}
        {tab === "facts" && <FactsTab site={site} dudaApi={data.dudaApi} ai={data.ai} onSaved={load} onError={setErr} />}
        {tab === "pages" && <PagesTab pages={data.pages} findings={findings} />}
        {tab === "details" && <DetailsTab site={site} me={me} onSave={patch} />}
      </div>
    </div>
  );
}

// ---------------- Audit runner ----------------

function AuditPanel({ site, lastRun, aiAvailable, onDone, onError, canManage }: { site: Site; lastRun: Run | null; aiAvailable: boolean; onDone: () => void; onError: (s: string) => void; canManage: boolean }) {
  const [skip, setSkip] = useState<string[] | null>(null);
  const [editSkip, setEditSkip] = useState<string | null>(null);
  useEffect(() => { api<{ ignorePaths: string[] }>("/api/settings/audit").then((r) => setSkip(r.ignorePaths)).catch(() => setSkip([])); }, []);
  const saveSkip = async () => {
    try { const r = await api<{ ignorePaths: string[] }>("/api/settings/audit", { method: "PUT", body: { ignorePaths: (editSkip || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) } }); setSkip(r.ignorePaths); setEditSkip(null); }
    catch (e) { onError((e as Error).message); }
  };
  const [opts, setOpts] = useState({ aiCopy: aiAvailable, aiAlt: aiAvailable, aiGlobal: true, maxPages: 60 });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: "" });
  const [log, setLog] = useState<string[]>([]);
  const cancel = useRef(false);
  const add = (s: string) => setLog((l) => [...l, s]);
  useEffect(() => setOpts((o) => ({ ...o, aiCopy: aiAvailable, aiAlt: aiAvailable })), [aiAvailable]);

  async function start() {
    if (!site.facts && !confirm("No Jira facts loaded yet — the audit can't check contact info against Jira. Run anyway?")) return;
    cancel.current = false; setRunning(true); setLog([]);
    const ai = opts.aiCopy || opts.aiAlt;
    try {
      setProgress({ done: 0, total: 1, phase: "Discovering pages" });
      add("Discovering pages from the preview link…");
      const s = await api<{ runId: number; pages: { url: string; path: string; from?: string }[]; errors: string[]; skipped?: string[] }>(`/api/sites/${site.id}/audit/start`, { body: { ai, maxPages: opts.maxPages } });
      s.errors.forEach((e) => add("⚠ " + e));
      add(`Found ${s.pages.length} page(s)${s.skipped?.length ? ` · skipped ${s.skipped.join(", ")}` : ""}. Each page is opened in real Chrome on desktop, tablet and mobile.`);
      const aiSteps = (opts.aiCopy ? 1 : 0) + (opts.aiAlt ? 1 : 0);
      const total = s.pages.length * (1 + aiSteps) + 1;
      let done = 0;
      const tick = (phase: string) => setProgress({ done: ++done, total, phase });

      const pageIds: { id: number; path: string }[] = [];
      const queue = [...s.pages];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length && !cancel.current) {
          const p = queue.shift()!;
          try {
            const r = await api<{ pageId?: number; findings: number; error?: string; note?: string }>(`/api/sites/${site.id}/audit/page`, { body: { runId: s.runId, url: p.url, from: p.from } });
            if (r.pageId) pageIds.push({ id: r.pageId, path: p.path });
            add(`${p.path} — ${r.error ? "✗ " + r.error : r.findings + " finding(s)"}${r.note ? ` · ⚠ ${r.note}` : ""}`);
          } catch (e) { add(`${p.path} — ✗ ${(e as Error).message}`); }
          tick("Checking pages");
        }
      }));

      if (ai && !cancel.current) {
        pageIds.sort((a, b) => a.path.length - b.path.length);
        for (const [i, p] of pageIds.entries()) {
          for (const kind of (["copy", "alt"] as const).filter((k) => (k === "copy" ? opts.aiCopy : opts.aiAlt))) {
            if (cancel.current) break;
            let attempt = 0;
            while (true) {
              try {
                const r = await api<{ findings: number; models: string[] }>(`/api/sites/${site.id}/audit/ai`, { body: { runId: s.runId, pageId: p.id, kind, includeGlobal: opts.aiGlobal && i === 0 } });
                add(`AI ${kind === "copy" ? "copy" : "alt text"} ${p.path} — ${r.findings} finding(s)${r.models.length ? ` via ${r.models.join(", ")}` : ""}`);
                break;
              } catch (e) {
                const msg = (e as Error).message;
                if (/429|rate/i.test(msg) && attempt < 2) { attempt++; add(`AI rate-limited, waiting 30s…`); await sleep(30000); continue; }
                add(`AI ${kind} ${p.path} — ✗ ${msg.slice(0, 200)}`); break;
              }
            }
            tick(`AI review (${kind === "copy" ? "body copy" : "alt text"})`);
            await sleep(2500); // be gentle with free-tier rate limits
          }
        }
      }
      setProgress((pr) => ({ ...pr, phase: "Site-wide checks & broken links" }));
      add("Running site-wide checks and broken-link scan…");
      const f = await api<{ pages: number; open: number; settings?: string }>(`/api/sites/${site.id}/audit/finish`, { body: { runId: s.runId, skipped: (s as { skipped?: string[] }).skipped || [] } });
      if (f.settings) add(f.settings);
      setProgress({ done: total, total, phase: "Done" });
      add(`✓ Done — ${f.pages} pages, ${f.open} open finding(s).${cancel.current ? " (cancelled early)" : ""}`);
    } catch (e) { onError((e as Error).message); add("✗ " + (e as Error).message); }
    setRunning(false); onDone();
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <h2 style={{ margin: 0 }}>Audit</h2>
          <div className="muted small">
            {lastRun ? <>Last run {ago(lastRun.started_at)} by {lastRun.started_by_name || "?"} · {lastRun.page_count} pages · {lastRun.status}</> : "Not audited yet"}
          </div>
        </div>
        <div className="row">
          <label className="row small" style={{ gap: 4 }} title={aiAvailable ? "" : "Ask a Super Admin to add a free AI key in Settings"}>
            <input type="checkbox" checked={opts.aiCopy} disabled={!aiAvailable || running} onChange={(e) => setOpts({ ...opts, aiCopy: e.target.checked })} /> AI body copy
          </label>
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={opts.aiAlt} disabled={!aiAvailable || running} onChange={(e) => setOpts({ ...opts, aiAlt: e.target.checked })} /> AI alt text
          </label>
          <label className="row small" style={{ gap: 4 }}>
            Max pages <input type="number" min={1} max={150} value={opts.maxPages} style={{ width: 70 }} disabled={running} onChange={(e) => setOpts({ ...opts, maxPages: Number(e.target.value) })} />
          </label>
          {running ? <button onClick={() => { cancel.current = true; }}>Stop</button> : <button className="primary" onClick={start}>Run audit</button>}
        </div>
      </div>
      {!aiAvailable && <div className="muted small">AI checks are off — a Super Admin can add a free Gemini / Groq / OpenRouter key in Settings.</div>}
      <div className="row small" style={{ gap: 6 }}>
        <span className="muted">Pages every audit skips:</span>
        {editSkip === null ? <>
          <b>{skip === null ? "…" : skip.length ? skip.join(", ") : "none"}</b>
          {canManage && <button className="sm ghost" onClick={() => setEditSkip((skip || []).join(", "))}>Edit</button>}
        </> : <>
          <input value={editSkip} onChange={(e) => setEditSkip(e.target.value)} placeholder="/image-credits, /privacy-policy" style={{ width: 320 }} />
          <button className="sm primary" onClick={saveSkip}>Save</button><button className="sm ghost" onClick={() => setEditSkip(null)}>Cancel</button>
        </>}
      </div>
      {(running || log.length > 0) && (
        <>
          <div className="row small"><b>{progress.phase}</b><span className="muted">{pct}%</span></div>
          <div className="progress"><div style={{ width: pct + "%" }} /></div>
          <div className="log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>{log.join("\n")}</div>
        </>
      )}
    </div>
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- Findings ----------------

function textFragmentUrl(url: string | null, found: string | null) {
  if (!url) return null;
  if (!found) return url;
  const clean = found.replace(/…/g, "").replace(/\s+/g, " ").trim().split(" — alt:")[0];
  const words = clean.split(" ").filter((w) => w.length).slice(0, 6).join(" ");
  if (!words || /^https?:|\.(jpe?g|png|webp)$/i.test(words)) return url;
  return `${url}#:~:text=${encodeURIComponent(words)}`;
}

/**
 * The Duda editor address for a finding's page: https://my.duda.co/home/site/<site id>/<page> (the home page is "home").
 * The site id comes from the Editor URL in Data Collection, the Duda site ID, or the preview link (…/site/<id>/…).
 */
export function editorUrlFor(site: Pick<Site, "editor_url" | "duda_site_id" | "preview_url">, pageUrl: string | null, pagePath: string) {
  const idOf = (u?: string | null) => (u || "").match(/\/site\/([a-z0-9]+)/i)?.[1] || "";
  const sid = idOf(site.editor_url) || (site.duda_site_id || "").trim() || idOf(site.preview_url) || idOf(pageUrl);
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) return "";
  // only Duda's own editor hosts (white-label editors on duda.co / dudaone.com too)
  const origin = (site.editor_url || "").match(/^https:\/\/(?:[a-z0-9-]+\.)*(?:duda\.co|dudaone\.com)(?=\/)/i)?.[0] || "https://my.duda.co";
  let page = "";
  try { page = (new URL(pageUrl || "").pathname.match(/\/site\/[a-z0-9]+\/(.+)$/i)?.[1] || "").replace(/\/+$/, ""); } catch { /* none */ }
  if (!page && pagePath.startsWith("/")) page = pagePath.replace(/^\/+|\/+$/g, "");
  return `${origin}/home/site/${sid}/${page && !/[^\w\-/.%]/.test(page) ? page : "home"}`;
}

function FindingsTable({ siteId, site, findings, members, me, reload, onError }: { siteId: number; site: Site; findings: Finding[]; members: Member[]; me: Me; reload: () => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ status: "open", severity: "", category: "", page: "", source: "", who: "", q: "" });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [local, setLocal] = useState<Record<number, Partial<Finding>>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [shot, setShot] = useState<{ id: number; title: string; url?: string; found?: boolean; err?: string } | null>(null);
  const [edCopied, setEdCopied] = useState<number | null>(null);
  async function showShot(r: Finding) {
    setShot({ id: r.id, title: r.message });
    try {
      const res = await fetch(`/api/findings/${r.id}/shot`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      setShot((x) => (x && x.id === r.id ? { ...x, url, found: res.headers.get("X-Element-Found") === "1" } : x));
    } catch (e) { setShot((x) => (x && x.id === r.id ? { ...x, err: (e as Error).message } : x)); }
  }
  /** Opens the finding's page in the Duda editor; the Tek Finder extension scrolls to it and outlines it. */
  const openInEditor = (r: Finding) => {
    const base = editorUrlFor(site, r.page_url, r.page_path);
    if (!base) { onError("No Duda site ID for this project yet — add the Editor URL in Data Collection (https://my.duda.co/home/site/…)."); return; }
    let device = "desktop";
    try { device = new URL(r.page_url || "").searchParams.get("dm_device") || ""; } catch { /* keep */ }
    const only = r.message.match(/\((desktop|tablet|mobile)(?: \+ (?:desktop|tablet|mobile))* only\)$/)?.[1];
    const f = { s: r.selector || "", t: (r.found || "").split(" — alt:")[0].split(" → ")[0].slice(0, 120), p: r.page_path, d: only || (device && device !== "desktop" ? device : ""), m: r.message.slice(0, 160) };
    navigator.clipboard.writeText("TEKFIND:" + JSON.stringify(f)).catch(() => {});
    window.open(`${base}#tekfind=${encodeURIComponent(JSON.stringify(f))}`, "_blank", "noopener");
  };
  const copyForEditor = (r: Finding) => {
    navigator.clipboard.writeText("TEKFIND:" + JSON.stringify({ s: r.selector || "", t: (r.found || "").split(" — alt:")[0].split(" → ")[0].slice(0, 120), p: r.page_path }));
    setEdCopied(r.id); setTimeout(() => setEdCopied(null), 1500);
  };

  const rows = useMemo(() => findings.map((x) => ({ ...x, ...local[x.id] })), [findings, local]);
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  const pages = [...new Set(rows.map((r) => r.page_path))].sort();
  const shown = rows.filter((r) =>
    (f.status === "all" || r.status === f.status) && (!f.severity || r.severity === f.severity) && (!f.category || r.category === f.category) &&
    (!f.page || r.page_path === f.page) && (!f.source || r.source === f.source) &&
    (!f.who || (f.who === "me" ? r.assignee_id === me.id : f.who === "none" ? !r.assignee_id : String(r.assignee_id) === f.who)) &&
    (!f.q || [r.message, r.found, r.expected, r.selector, r.note].join(" ").toLowerCase().includes(f.q.toLowerCase())));

  useEffect(() => { setLocal({}); }, [findings]);

  async function update(ids: number[], b: Record<string, unknown>) {
    setLocal((l) => { const n = { ...l }; ids.forEach((i) => { n[i] = { ...n[i], ...b } as Partial<Finding>; }); return n; });
    try {
      if (ids.length === 1) await api(`/api/findings/${ids[0]}`, { method: "PATCH", body: b });
      else await api(`/api/findings/bulk`, { body: { ids, ...b } });
    } catch (e) { onError((e as Error).message); reload(); }
  }
  const bulk = (b: Record<string, unknown>) => { update([...sel], b); setSel(new Set()); setTimeout(reload, 300); };
  const allSel = shown.length > 0 && shown.every((r) => sel.has(r.id));

  return (
    <div className="stack">
      <div className="filters">
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="open">Open</option><option value="done">Done</option><option value="ignored">Ignored</option><option value="resolved">Auto-resolved</option><option value="all">All</option>
        </select>
        <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
          <option value="">Any severity</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option>
        </select>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={f.page} onChange={(e) => setF({ ...f, page: e.target.value })}>
          <option value="">All pages</option>{pages.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="">Rules + AI</option><option value="rule">Rules</option><option value="ai">AI</option>
        </select>
        <select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <span className="spacer" />
        <a className="btn sm" href={`/api/sites/${siteId}/export`}>Export open CSV</a>
        <a className="btn sm" href={`/api/sites/${siteId}/export?all=1`}>Export all</a>
      </div>

      <EditorFinder />

      {shot && (
        <div className="modal-back" onClick={() => setShot(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card stack" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "min(1400px, 96vw)", maxHeight: "94vh", overflow: "auto" }}>
            <div className="row between"><b>{shot.title}</b><button className="sm ghost" onClick={() => setShot(null)}>✕</button></div>
            {shot.err ? <div className="alert error">{shot.err}</div>
              : !shot.url ? <p className="muted">Opening the page in Chrome and finding the spot… (about 10 seconds)</p>
              : <>
                {!shot.found && <div className="alert warning small">Couldn&apos;t find the exact element on the page now (it may have been fixed) — showing the page.</div>}
                <img src={shot.url} alt="Page screenshot with the finding outlined in red" style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }} />
              </>}
          </div>
        </div>
      )}

      {sel.size > 0 && (
        <div className="row alert">
          <b>{sel.size} selected</b>
          <button className="sm" onClick={() => bulk({ status: "done" })}>Mark done</button>
          <button className="sm" onClick={() => bulk({ status: "ignored" })}>Ignore (false positive)</button>
          <button className="sm" onClick={() => bulk({ status: "open" })}>Reopen</button>
          <select style={{ width: 160 }} value="" onChange={(e) => bulk({ assignee_id: e.target.value === "none" ? null : Number(e.target.value) })}>
            <option value="">Assign to…</option><option value="none">Unassign</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button className="sm ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {!shown.length ? <p className="muted">{findings.length ? "Nothing matches these filters." : "No findings yet — run an audit."}</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(shown.map((r) => r.id)))} /></th>
                <th>Done</th><th>Page</th><th>Finding</th><th>Category</th><th>Assignee</th><th>Note</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const link = textFragmentUrl(r.page_url, r.found);
                return (
                  <tr key={r.id} className={r.status !== "open" ? "done" : ""}>
                    <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => { const n = new Set(sel); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSel(n); }} /></td>
                    <td>
                      <input type="checkbox" title="Mark done" checked={r.status === "done"} disabled={r.status === "resolved"} onChange={(e) => update([r.id], { status: e.target.checked ? "done" : "open" })} />
                    </td>
                    <td className="small" style={{ minWidth: 110 }}>
                      {link ? <a href={link} target="_blank" rel="noreferrer" title="Open page and jump to the text">{r.page_path} ↗</a> : r.page_path}
                    </td>
                    <td style={{ minWidth: 320 }}>
                      <div><span className={`badge ${r.severity}`}>{r.severity}</span> {r.message}</div>
                      {(r.found || r.expected) && (
                        <div className="diff">
                          {r.found && <><span className="k">Found</span><span className="found">{r.found}</span></>}
                          {r.expected && <><span className="k">Expected</span><span className="expected">{r.expected}</span></>}
                        </div>
                      )}
                      {r.page_url && (
                        <div className="row" style={{ gap: 6, marginTop: 4 }}>
                          <button className="sm" onClick={() => showShot(r)} title="See it on the page — screenshot with the spot outlined">👁 Show on page</button>
                          <button className="sm" onClick={() => openInEditor(r)} title="Opens this page in the Duda editor — with the Tek Finder extension it scrolls to the spot and outlines it">✏️ Open in Duda editor</button>
                          <button className="sm ghost" onClick={() => copyForEditor(r)} title="Copy, then click “Tek: find it” in your bookmarks while the Duda editor or preview is open">{edCopied === r.id ? "✓ Copied — click “Tek: find it”" : "📍 Find in editor"}</button>
                        </div>
                      )}
                      {r.selector && (
                        <div className="selector" title="Click to copy CSS selector" onClick={() => { navigator.clipboard.writeText(r.selector!); setCopied(r.id); setTimeout(() => setCopied(null), 1200); }}>
                          {copied === r.id ? "✓ copied" : r.selector}
                        </div>
                      )}
                      {r.status === "done" && r.done_by_name && <div className="muted small">Done by {r.done_by_name} {ago(r.done_at)}</div>}
                      {r.status === "resolved" && <div className="muted small">Not found on the last run — auto-resolved</div>}
                    </td>
                    <td className="small">{r.category}{r.source === "ai" && <div><span className="badge accent">AI</span></div>}</td>
                    <td>
                      <select value={r.assignee_id || ""} onChange={(e) => update([r.id], { assignee_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 160 }}>
                      <input defaultValue={r.note || ""} placeholder="Add note…" style={{ fontSize: 12, padding: "3px 6px" }}
                        onBlur={(e) => { if ((e.target.value || "") !== (r.note || "")) update([r.id], { note: e.target.value }); }} />
                    </td>
                    <td>
                      {r.status === "open"
                        ? <button className="sm ghost" title="False positive — hide it on future runs too" onClick={() => update([r.id], { status: "ignored" })}>Ignore</button>
                        : r.status !== "resolved" && <button className="sm ghost" onClick={() => update([r.id], { status: "open" })}>Reopen</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * "Tek: find it" bookmarklet. Copy a finding ("📍 Find in editor"), then click the bookmark while the Duda editor or the
 * preview is open: it scrolls to the element and outlines it in red. It only reads what you copied; it sends nothing anywhere.
 */
const FINDER = `(async()=>{let t='';try{t=await navigator.clipboard.readText()}catch(e){}if(!/^TEKFIND:/.test(t))t=prompt('Tek: paste the finding you copied (📍 Find in editor):')||'';if(!/^TEKFIND:/.test(t))return;let f;try{f=JSON.parse(t.slice(8))}catch(e){return alert('Tek: that copy is not a finding.')}const docs=[document];const add=w=>{try{w.document.querySelectorAll('iframe').forEach(i=>{try{if(i.contentDocument){docs.push(i.contentDocument);add(i.contentWindow)}}catch(e){}})}catch(e){}};add(window);const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};let el=null;for(const d of docs){let c=null;try{if(f.s&&f.s!=='head')c=d.querySelector(f.s)}catch(e){}if(c&&vis(c)){el=c;break}if(f.t){const tt=f.t.replace(/…/g,'').trim().slice(0,50).toLowerCase();c=[...d.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,a,span,img,button,div')].find(e=>vis(e)&&((e.textContent||'').toLowerCase().includes(tt)||(e.src||'').toLowerCase().includes(tt))&&![...e.children].some(k=>(k.textContent||'').toLowerCase().includes(tt)));if(c){el=c;break}}}if(!el)return alert('Tek: not on this page. Open '+f.p+' in the editor/preview, then click again.');el.scrollIntoView({block:'center'});const o=el.style.outline,oo=el.style.outlineOffset;el.style.outline='4px solid #e11d48';el.style.outlineOffset='3px';setTimeout(()=>{el.style.outline=o;el.style.outlineOffset=oo},10000)})()`;

function EditorFinder() {
  const ref = useRef<HTMLAnchorElement>(null);
  // React won't render a javascript: link, so set it after mount
  useEffect(() => { ref.current?.setAttribute("href", "javascript:" + encodeURIComponent(FINDER)); }, []);
  return (
    <details className="small">
      <summary>✏️ Open a finding inside the Duda editor (one-time setup)</summary>
      <div className="stack" style={{ gap: 6, marginTop: 6 }}>
        <div><b>Best: the Tek Finder extension</b> (free, Chrome) — then <b>✏️ Open in Duda editor</b> opens the editor on that page, scrolls to the spot and outlines it.</div>
        <div>1. <a className="btn sm" href="/api/tools/tek-finder">Download Tek Finder</a> and unzip it (you get a folder &quot;tek-finder&quot;).</div>
        <div>2. In Chrome open <code>chrome://extensions</code>, turn on <b>Developer mode</b> (top right), click <b>Load unpacked</b> and pick the &quot;tek-finder&quot; folder.</div>
        <div>3. Click <b>✏️ Open in Duda editor</b> on any finding. Mobile/tablet-only findings say so — switch the editor to that view.</div>
        <div className="muted">It only reads the page you open from here; it has no network access and sends nothing anywhere.</div>
        <div style={{ marginTop: 6 }}><b>Or: the bookmark</b> (no extension)</div>
        <div>1. Drag this button to your browser&apos;s bookmarks bar: <a ref={ref} className="btn sm" onClick={(e) => e.preventDefault()} title="Drag me to the bookmarks bar">Tek: find it</a></div>
        <div>2. On a finding, click <b>📍 Find in editor</b> (it copies the spot).</div>
        <div>3. In the Duda editor (or the preview), open that page and click <b>Tek: find it</b> in your bookmarks — it scrolls to the spot and outlines it in red. The first time, Chrome may ask to allow reading the clipboard; if not allowed, just paste when it asks.</div>
      </div>
    </details>
  );
}

// ---------------- Facts ----------------

function FactsTab({ site, dudaApi, ai, onSaved, onError }: { site: Site; dudaApi: boolean; ai: boolean; onSaved: () => void; onError: (s: string) => void }) {
  const [facts, setFacts] = useState<Facts>(normalizeFacts(site.facts || emptyFacts()));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [paste, setPaste] = useState("");
  const [useAi, setUseAi] = useState(ai);
  const [over, setOver] = useState(false);
  const [imported, setImported] = useState<{ source: string; text: string; note?: string } | null>(null);
  const [duda, setDuda] = useState<Facts | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const change = (f: Facts) => { setFacts(f); setDirty(true); };

  async function importFrom(file?: File) {
    setBusy("Reading Jira export…");
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (paste.trim()) fd.append("text", paste);
      if (useAi) fd.append("ai", "1");
      const r = await api<{ facts: Facts; text: string; source: string; aiNote: string }>(`/api/sites/${site.id}/facts/import`, { form: fd });
      setFacts(normalizeFacts(r.facts)); setDirty(true);
      setImported({ source: r.source, text: r.text, note: r.aiNote });
    } catch (e) { onError((e as Error).message); }
    setBusy("");
  }
  async function save() {
    setBusy("Saving…");
    try {
      await api(`/api/sites/${site.id}/facts`, { method: "PUT", body: { facts, source: imported?.source, rawText: imported?.text } });
      setDirty(false); onSaved();
    } catch (e) { onError((e as Error).message); }
    setBusy("");
  }
  async function loadDuda() {
    setBusy("Reading the site's Business Info…");
    try { setDuda((await api<{ facts: Facts }>(`/api/sites/${site.id}/duda`)).facts); } catch (e) { onError((e as Error).message); }
    setBusy("");
  }

  return (
    <div className="stack">
      <div className="card" style={{ background: "var(--panel-2)", boxShadow: "none" }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>Import from Jira</h3>
            <div className="muted small">Upload the Jira export (PDF, XLSX or CSV) or paste the ticket text. It&apos;s parsed into facts below for you to check, then saved. The file itself isn&apos;t stored.</div>
          </div>
          <label className="row small" style={{ gap: 4 }} title={ai ? "" : "No AI key configured"}>
            <input type="checkbox" checked={useAi} disabled={!ai} onChange={(e) => setUseAi(e.target.checked)} /> Use AI to extract
          </label>
        </div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className={`dropzone ${over ? "over" : ""}`} onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) importFrom(f); }}>
            <b>Drop Jira PDF / XLSX / CSV</b><div className="small">or click to choose</div>
            <input ref={fileRef} type="file" hidden accept=".pdf,.xlsx,.xlsm,.csv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFrom(f); e.target.value = ""; }} />
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <textarea rows={4} placeholder="…or paste Jira ticket text here" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <div><button className="sm" disabled={!paste.trim() || !!busy} onClick={() => importFrom()}>Extract from text</button></div>
          </div>
        </div>
        {busy && <div className="muted small" style={{ marginTop: 8 }}>{busy}</div>}
        {imported && (
          <div className="small" style={{ marginTop: 8 }}>
            <span className="badge accent">Imported from {imported.source}</span> — review the fields below, then <b>Save facts</b>.
            {imported.note && <div className="alert warning" style={{ marginTop: 6 }}>{imported.note}</div>}
            <details style={{ marginTop: 6 }}><summary className="muted">Show extracted text</summary><div className="log">{imported.text}</div></details>
          </div>
        )}
        {!imported && site.facts_source && <div className="muted small" style={{ marginTop: 8 }}>Current facts came from <b>{site.facts_source}</b>.</div>}
      </div>

      {dudaApi && (
        <div className="row">
          <button className="sm" onClick={loadDuda} disabled={!!busy}>Compare with the site's Business Info</button>
          {duda && <button className="sm" onClick={() => { change(duda); setDuda(null); }}>Replace with the site's values</button>}
        </div>
      )}
      {duda && <DudaDiff jira={facts} duda={duda} />}

      <FactsEditor facts={facts} onChange={change} />
      <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--panel)", padding: "10px 0", borderTop: "1px solid var(--border)" }}>
        <button className="primary" disabled={!dirty || !!busy} onClick={save}>Save facts</button>
        {dirty && <span className="muted small">Unsaved changes — re-run the audit after saving.</span>}
      </div>
    </div>
  );
}

function DudaDiff({ jira, duda }: { jira: Facts; duda: Facts }) {
  const rows: [string, string, string][] = [
    ["Business name", jira.businessName, duda.businessName],
    ["Phones", jira.phones.join(", "), duda.phones.join(", ")],
    ["Emails", jira.emails.join(", "), duda.emails.join(", ")],
    ["Address", jira.locations.map((l) => `${l.street}, ${l.city}, ${l.state} ${l.zip}`).join(" | "), duda.locations.map((l) => `${l.street}, ${l.city}, ${l.state} ${l.zip}`).join(" | ")],
    ["Hours", jira.hours.map((h) => `${h.day} ${h.value}`).join("; "), duda.hours.map((h) => `${h.day} ${h.value}`).join("; ")],
    ["Socials", jira.socials.map((s) => s.url).join(" "), duda.socials.map((s) => s.url).join(" ")],
  ];
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    <table className="t">
      <thead><tr><th>Field</th><th>Jira (truth)</th><th>Duda Business Info</th></tr></thead>
      <tbody>{rows.map(([k, a, b]) => (
        <tr key={k}><td>{k}</td><td>{a || "—"}</td><td className={n(a) === n(b) ? "" : "found"}>{b || "—"} {n(a) !== n(b) && <span className="badge error">differs</span>}</td></tr>
      ))}</tbody>
    </table>
  );
}

// ---------------- Pages / details ----------------

function PagesTab({ pages, findings }: { pages: PageRow[]; findings: Finding[] }) {
  if (!pages.length) return <p className="muted">Run an audit to crawl the preview.</p>;
  return (
    <table className="t">
      <thead><tr><th>Path</th><th>Title</th><th>HTTP</th><th>Open findings</th></tr></thead>
      <tbody>{pages.map((p) => {
        const open = findings.filter((f) => f.page_path === p.path && f.status === "open");
        return (
          <tr key={p.id}>
            <td><a href={p.url} target="_blank" rel="noreferrer">{p.path}</a></td>
            <td className="small">{p.title || <span className="muted">—</span>}</td>
            <td>{p.error ? <span className="badge error">{p.error}</span> : <span className={`badge ${p.status_code >= 400 ? "error" : "ok"}`}>{p.status_code}</span>}</td>
            <td>{open.length ? <><span className="badge error">{open.filter((f) => f.severity === "error").length}</span> <span className="muted small">{open.length}</span></> : "0"}</td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}

function DetailsTab({ site, me, onSave }: { site: Site; me: Me; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [f, setF] = useState({ name: site.name, preview_url: site.preview_url, live_url: site.live_url || "", jira_key: site.jira_key || "", duda_site_id: site.duda_site_id || "", notes: site.notes || "" });
  const del = async () => {
    if (!confirm(`Delete ${site.name} and all its findings?`)) return;
    await api(`/api/sites/${site.id}`, { method: "DELETE" }); window.location.href = "/";
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Duda preview link</span><input value={f.preview_url} onChange={(e) => setF({ ...f, preview_url: e.target.value })} /></label>
      <label className="field"><span>Live URL (after publish)</span><input value={f.live_url} onChange={(e) => setF({ ...f, live_url: e.target.value })} /></label>
      <div className="grid2">
        <label className="field"><span>Jira key</span><input value={f.jira_key} onChange={(e) => setF({ ...f, jira_key: e.target.value })} /></label>
        <label className="field"><span>Duda site ID (from the Editor URL — used to read site settings)</span><input value={f.duda_site_id} onChange={(e) => setF({ ...f, duda_site_id: e.target.value })} /></label>
      </div>
      <label className="field"><span>Notes</span><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      <div className="row">
        <button className="primary" onClick={() => onSave(f)}>Save</button>
        <span className="spacer" />
        {me.role !== "member" && <button className="danger" onClick={del}>Delete site</button>}
      </div>
    </div>
  );
}
