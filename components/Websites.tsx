"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ago } from "./api";
import SitesHistory from "./SitesHistory";

type Row = {
  id: number; alias: string; site_name: string; domain: string; duda_status: string; created_at: string | null; first_publish: string | null; last_publish: string | null;
  subscription: string | null; labels: string; health: string; health_detail: string; health_flags: string; checked_at: string | null; health_changed_at: string | null; prev_health: string | null;
  domain_expires: string | null; ssl_expires: string | null; missing: number;
  uptime_pct: number | null; uptime_checks: number; recent: string[]; launch_flags: string[]; launch_days: number | null;
  gbp_status: string | null; gbp_website: string | null; gbp_checked_at: string | null; open_incident: string | null;
  unpublished_at: string | null; removed_at: string | null;
};
type Run = { id: number; status: string; scope: string; total: number; done: number; started_by: string | null; started_at: string; finished_at: string | null };
type Data = {
  rows: Row[]; canManage: boolean; run: Run | null; settings: { schedule: string; notLiveDays: number; tempDomainDays: number; gbpPerDay: number };
  import: { at: string; total: number; added: number; skipped: number; refreshed: number; missing: number } | null;
  healthLabels: Record<string, string>; healthOrder: string[]; flagLabels: Record<string, string>;
};

const TONE: Record<string, string> = { ok: "ok", redirect: "warning", moved: "warning", ssl: "warning", taken: "error", parked: "error", not_found: "error", error: "error", dns: "error", down: "error", unchecked: "", skipped: "" };
const STAGING = /\.(tekmetric\.site|shopgenie\.site|multiscreensite\.com|dudaone\.com)$/i;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const PAGE = 50;
/** Overview groups: one tile each; "unhealthy" and "attention" have a second filter for the specific problem. */
type Group = "" | "ok" | "unhealthy" | "attention" | "unchecked" | "launch";
const UNHEALTHY = ["redirect", "moved", "taken", "parked", "not_found", "error", "dns", "ssl", "down"];
const WARNINGS = ["domain_expiring", "domain_hold", "ssl_expiring", "gbp_other", "gbp_none", "slow", "other_duda_site", "changed", "missing"];
const LAUNCH: Record<string, string> = { not_launched: "Not published yet", temp_domain: "Live only on the temporary domain", billing_failed: "Duda billing failed" };
/** colour of one check result in the uptime strip */
const DOT: Record<string, string> = { ok: "var(--ok)", down: "var(--error)", dns: "var(--error)", ssl: "var(--error)", error: "var(--error)", not_found: "var(--error)", parked: "var(--error)" };
function Strip({ list, size = 8, title }: { list: string[]; size?: number; title?: string }) {
  return <span title={title} style={{ display: "inline-flex", gap: 2, verticalAlign: "middle" }}>{list.map((h, i) => <span key={i} title={h} style={{ width: size, height: size * 1.6, borderRadius: 2, background: DOT[h] || "var(--warning)", opacity: DOT[h] ? 1 : 0.7 }} />)}</span>;
}
type Filters = { q: string; status: string; group: Group; problem: string; warning: string; launch?: string; labels: string[]; labelMode: "any" | "all"; template: string; domainType: string; createdFrom: string; createdTo: string; firstFrom: string; firstTo: string; lastFrom: string; lastTo: string };
const EMPTY: Filters = { q: "", status: "", group: "", problem: "", warning: "", labels: [], labelMode: "any", template: "", domainType: "", createdFrom: "", createdTo: "", firstFrom: "", firstTo: "", lastFrom: "", lastTo: "" };
const isTemplate = (l: string) => /^\d{1,3}$/.test(l);

export default function Websites() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<number, unknown>>({});
  const [run, setRun] = useState<Run | null>(null);

  const load = useCallback(() => api<Data>("/api/websites").then((x) => { setD(x); setRun(x.run); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); try { const s = sessionStorage.getItem("ws-filters"); if (s) setF({ ...EMPTY, ...JSON.parse(s) }); } catch { /* ignore */ } }, [load]);
  useEffect(() => { try { sessionStorage.setItem("ws-filters", JSON.stringify(f)); } catch { /* ignore */ } setPage(0); }, [f]);

  // follow a running "check all" (it runs on the server — leaving the page doesn't stop it)
  const running = !!run && ["queued", "running", "stopping"].includes(run.status);
  useEffect(() => {
    if (!running) return;
    let n = 0;
    const t = setInterval(async () => {
      try {
        const r = await api<{ run: Run | null }>("/api/websites/run");
        setRun(r.run);
        if (++n % 6 === 0 || (r.run && !["queued", "running", "stopping"].includes(r.run.status))) load();
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  // labels split in two: plan/type labels (PPW, SL, PRO, Lite, MSO…) and template numbers (01–31)
  const { tagLabels, templates } = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of d?.rows || []) for (const l of r.labels.split(",").filter(Boolean)) c.set(l, (c.get(l) || 0) + 1);
    const all = [...c.entries()];
    return {
      tagLabels: all.filter(([l]) => !isTemplate(l)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      templates: all.filter(([l]) => isTemplate(l)).sort((a, b) => Number(a[0]) - Number(b[0])),
    };
  }, [d]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(() => { try { return localStorage.getItem("ws-history") === "1"; } catch { return false; } });
  const flipHistory = () => setShowHistory((v) => { try { localStorage.setItem("ws-history", v ? "0" : "1"); } catch { /* ignore */ } return !v; });

  // every filter except health/warning (so the tiles show counts for the current selection)
  const base = useMemo(() => (d?.rows || []).filter((r) => {
    if (f.q) { const q = f.q.toLowerCase(); if (!`${r.site_name} ${r.domain} ${r.alias} ${r.health_detail}`.toLowerCase().includes(q)) return false; }
    if (f.status && r.duda_status !== f.status) return false;
    if (f.domainType === "custom" && STAGING.test(r.domain)) return false;
    if (f.domainType === "staging" && !STAGING.test(r.domain)) return false;
    if (f.labels.length) { const ls = r.labels.split(","); if (f.labelMode === "all" ? !f.labels.every((l) => ls.includes(l)) : !f.labels.some((l) => ls.includes(l))) return false; }
    if (f.template && !r.labels.split(",").some((l) => isTemplate(l) && Number(l) === Number(f.template))) return false;
    const inRange = (v: string | null, from: string, to: string) => (!from || (!!v && day(v) >= from)) && (!to || (!!v && day(v) <= to));
    return inRange(r.created_at, f.createdFrom, f.createdTo) && inRange(r.first_publish, f.firstFrom, f.firstTo) && inRange(r.last_publish, f.lastFrom, f.lastTo);
  }), [d, f]);
  const flagsOf = (r: Row) => { try { return JSON.parse(r.health_flags || "[]") as string[]; } catch { return []; } };
  /** warnings of a row (incl. "health changed" and "not in latest import"); the staging address is shown by the Domain filter instead */
  const warningsOf = (r: Row) => [...flagsOf(r).filter((x) => x !== "staging_domain"), ...(r.health_changed_at ? ["changed"] : []), ...(r.missing ? ["missing"] : [])];
  const groupOf = (r: Row): Group => (r.health === "ok" ? "ok" : UNHEALTHY.includes(r.health) ? "unhealthy" : "unchecked");
  const shown = useMemo(() => base.filter((r) => {
    if (f.group === "launch") return r.launch_flags.length > 0 && (!f.launch || r.launch_flags.includes(f.launch));
    if (f.group === "attention") { const w = warningsOf(r); return w.length > 0 && (!f.warning || w.includes(f.warning)); }
    if (f.group && groupOf(r) !== f.group) return false;
    if (f.group === "unhealthy" && f.problem && r.health !== f.problem) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [base, f.group, f.problem, f.warning, f.launch]);

  const counts = useMemo(() => {
    const h: Record<string, number> = {}, w: Record<string, number> = {}, lf: Record<string, number> = {};
    let attention = 0, launch = 0, upSum = 0, upN = 0;
    for (const r of base) {
      if (r.launch_flags.length) { launch++; for (const x of r.launch_flags) lf[x] = (lf[x] || 0) + 1; }
      if (r.uptime_pct !== null) { upSum += r.uptime_pct; upN++; }
      h[r.health] = (h[r.health] || 0) + 1;
      const ws = warningsOf(r);
      if (ws.length) attention++;
      for (const x of ws) w[x] = (w[x] || 0) + 1;
    }
    const unhealthy = UNHEALTHY.reduce((n, k) => n + (h[k] || 0), 0);
    return { h, w, attention, unhealthy, unchecked: (h.unchecked || 0) + (h.skipped || 0), launch, lf, avgUptime: upN ? Math.round((upSum / upN) * 10) / 10 : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function importFile(file: File, refresh: boolean) {
    setErr(""); setMsg(`Importing ${file.name}…`);
    try {
      const fd = new FormData(); fd.append("file", file); if (refresh) fd.append("refresh", "1");
      const r = await api<{ total: number; added: number; skipped: number; refreshed: number; invalid: string[]; missing: number }>("/api/websites/import", { form: fd });
      setMsg(`Imported ${r.total.toLocaleString()} rows: ${r.added.toLocaleString()} new site(s) added · ${r.skipped.toLocaleString()} already in the list (not added again${r.refreshed ? `, ${r.refreshed.toLocaleString()} details refreshed` : ""})${r.missing ? ` · ${r.missing.toLocaleString()} site(s) in the list are no longer in this export` : ""}${r.invalid.length ? ` · ${r.invalid.length} invalid row(s) skipped` : ""}.`);
      setShowImport(false); load();
    } catch (e) { setErr((e as Error).message); setMsg(""); }
  }
  async function checkAll(scope: "published" | "all") {
    setErr("");
    try { const r = await api<{ run: Run }>("/api/websites/run", { body: { scope } }); setRun(r.run); } catch (e) { setErr((e as Error).message); }
  }
  async function checkOne(id: number) {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await api("/api/websites/check", { body: { id } }); await load(); if (open === id) loadDetail(id); } catch (e) { setErr((e as Error).message); }
    setBusy((b) => ({ ...b, [id]: false }));
  }
  async function loadDetail(id: number) { try { const r = await api<DetailData>(`/api/websites/${id}`); setDetail((x) => ({ ...x, [id]: r })); } catch { /* ignore */ } }
  async function exportCsv() {
    const r = await fetch("/api/websites/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: shown.map((x) => x.id) }) });
    if (!r.ok) { setErr("Export failed"); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = `website-health-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  if (!d) return <p className="muted">{err || "Loading…"}</p>;
  const L = d.healthLabels;
  const ordered = f.group === "launch" ? [...shown].sort((a, b) => (b.launch_days ?? -1) - (a.launch_days ?? -1)) : shown;
  const pageRows = ordered.slice(page * PAGE, page * PAGE + PAGE);
  const wLabel = (k: string) => (k === "changed" ? "Health changed since a previous check" : k === "missing" ? "Not in the latest import (deleted in Duda?)" : d.flagLabels[k] || k);
  const tile = (g: Group, label: string, n: number, tone: string, hint: string) => {
    const active = f.group === g;
    return (
      <button key={g || "all"} className="stat" title={hint}
        style={{ border: active ? "2px solid var(--accent)" : "2px solid transparent", textAlign: "left", cursor: "pointer", minWidth: 170 }}
        onClick={() => setF((x) => ({ ...x, group: x.group === g ? "" : g, problem: "", warning: "", launch: "" }))}>
        <b style={{ color: tone === "error" ? "var(--error)" : tone === "warning" ? "var(--warning)" : tone === "ok" ? "var(--ok)" : undefined }}>{n.toLocaleString()}</b><span>{label}</span>
      </button>
    );
  };
  const checked = base.filter((r) => !["unchecked", "skipped"].includes(r.health)).length;

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1 style={{ margin: 0 }}>All Websites</h1>
          <div className="muted small">Every site from Duda&apos;s site list, with a domain health check so you can see who&apos;s still with us.</div>
        </div>
        <div className="row">
          {d.canManage && <button onClick={() => setShowImport((x) => !x)}>Import site list (CSV)</button>}
          <button onClick={exportCsv} disabled={!shown.length}>Export report ({shown.length.toLocaleString()})</button>
          {d.canManage && (running
            ? <button onClick={() => api("/api/websites/run", { body: { action: "stop" } }).then(() => setRun((r) => r && { ...r, status: "stopping" }))}>Stop checking</button>
            : <button className="primary" onClick={() => checkAll("published")} disabled={!d.rows.length}>Check all domains</button>)}
        </div>
      </div>

      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}
      {msg && <div className="alert" onClick={() => setMsg("")}>{msg}</div>}

      {showImport && <ImportBox onFile={importFile} onCancel={() => setShowImport(false)} last={d.import} />}

      {/* Last full check */}
      <div className="card row between small" style={{ boxShadow: "none", padding: "10px 14px" }}>
        <div>
          {run ? (
            running ? <><b>Checking all domains…</b> {run.done.toLocaleString()} of {run.total.toLocaleString()} done — runs on the server, you can leave this page.</>
              : <><b>Last full check:</b> {run.status === "done" ? "finished" : run.status} {ago(run.finished_at || run.started_at)} · {run.done.toLocaleString()} of {run.total.toLocaleString()} domain(s) · started by {run.started_by || "—"}</>
          ) : <b>No full check yet.</b>}
          {" "}<span className="muted">· {checked.toLocaleString()} of {base.length.toLocaleString()} shown site(s) have been checked{d.import ? ` · list imported ${ago(d.import.at)}` : ""}</span>
          {running && <div style={{ height: 6, background: "var(--panel-2)", borderRadius: 4, marginTop: 6, overflow: "hidden" }}><div style={{ width: `${run!.total ? Math.round((run!.done / run!.total) * 100) : 0}%`, height: "100%", background: "var(--accent)" }} /></div>}
        </div>
        {d.canManage && (
          <label className="row" style={{ gap: 6 }}>Automatic check
            <select value={d.settings.schedule} onChange={(e) => api<Data["settings"]>("/api/websites/settings", { method: "PUT", body: { schedule: e.target.value } }).then((s) => setD((x) => x && { ...x, settings: s })).catch((er) => setErr(er.message))}>
              <option value="off">Off</option><option value="weekly">Weekly</option><option value="daily">Daily</option>
            </select>
          </label>
        )}
      </div>

      <AlertsPanel onOpenSite={(domain) => setF({ ...EMPTY, q: domain })} />
      {d.canManage && <MonitoringSettings s={d.settings} onSaved={(s) => setD((x) => x && { ...x, settings: s })} onError={setErr} />}

      {/* At a glance — click a tile to filter; pick the specific problem underneath */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {tile("", "Websites", base.length, "", "Show all")}
        {tile("ok", "Live on Duda", counts.h.ok || 0, "ok", "Domain loads and is still on Duda")}
        {tile("unhealthy", "Unhealthy domains", counts.unhealthy, "error", "Redirects, moved off Duda, new owner, parked, 404, server error, DNS, SSL, down")}
        {tile("attention", "Needs attention", counts.attention, "warning", "Live, but with a warning (renewal overdue, different Duda site, slow, changed, not in latest import)")}
        {tile("unchecked", "Not checked", counts.unchecked, "", "Not checked yet, or not published in Duda")}
        {tile("launch", "Launch tracker", counts.launch, counts.launch ? "warning" : "", `Paid for but maybe not really live: not published ${d.settings.notLiveDays}+ days after creation, or published but only on the temporary tekmetric.site address for ${d.settings.tempDomainDays}+ days, or Duda billing failed`)}
        <button className="stat" onClick={flipHistory} title="Sites created, first published and unpublished for good — per week, month or year" style={{ textAlign: "left", cursor: "pointer", minWidth: 150, border: showHistory ? "2px solid var(--accent)" : "2px solid transparent" }}><b>📈</b><span>{showHistory ? "Hide history" : "History chart"}</span></button>
        {counts.avgUptime !== null && <div className="stat" title="Average uptime of the checked sites over the last 30 days (from the scheduled checks)" style={{ minWidth: 150 }}><b style={{ color: counts.avgUptime >= 99 ? "var(--ok)" : "var(--warning)" }}>{counts.avgUptime}%</b><span>Avg uptime (30 days)</span></div>}
      </div>
      {showHistory && <SitesHistory rows={base} />}
      {f.group === "launch" && (
        <div className="row small" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="muted">Why:</span>
          <button className={`sm ${!f.launch ? "primary" : "ghost"}`} onClick={() => setF({ ...f, launch: "" })}>All {counts.launch}</button>
          {Object.keys(LAUNCH).filter((k) => counts.lf[k]).map((k) => <button key={k} className={`sm ${f.launch === k ? "primary" : "ghost"}`} onClick={() => setF({ ...f, launch: k })}>{LAUNCH[k]} {counts.lf[k]}</button>)}
          <span className="muted">— sorted by how long they&apos;ve waited; reach out before the customer has to.</span>
        </div>
      )}
      {f.group === "unhealthy" && (
        <div className="row small" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="muted">Problem:</span>
          <button className={`sm ${!f.problem ? "primary" : "ghost"}`} onClick={() => setF({ ...f, problem: "" })}>All {counts.unhealthy}</button>
          {UNHEALTHY.filter((k) => counts.h[k]).map((k) => <button key={k} className={`sm ${f.problem === k ? "primary" : "ghost"}`} onClick={() => setF({ ...f, problem: k })}>{L[k]} {counts.h[k]}</button>)}
        </div>
      )}
      {f.group === "attention" && (
        <div className="row small" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="muted">Warning:</span>
          <button className={`sm ${!f.warning ? "primary" : "ghost"}`} onClick={() => setF({ ...f, warning: "" })}>All {counts.attention}</button>
          {WARNINGS.filter((k) => counts.w[k]).map((k) => <button key={k} className={`sm ${f.warning === k ? "primary" : "ghost"}`} onClick={() => setF({ ...f, warning: k })}>{wLabel(k)} {counts.w[k]}</button>)}
        </div>
      )}

      {/* Filters */}
      <div className="card stack" style={{ boxShadow: "none" }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input style={{ maxWidth: 240 }} placeholder="Search name, domain, alias…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select style={{ maxWidth: 160 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Any Duda status</option><option value="PUBLISHED">Published</option><option value="UNPUBLISHED">Unpublished</option><option value="IN PLANNING">In planning</option>
          </select>
          <LabelPicker labels={tagLabels} value={f.labels} mode={f.labelMode} onChange={(labels, labelMode) => setF({ ...f, labels, labelMode })} />
          <select style={{ maxWidth: 150 }} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>
            <option value="">Any template #</option>{templates.map(([t, n]) => <option key={t} value={t}>Template {t} ({n})</option>)}
          </select>
          <select style={{ maxWidth: 170 }} value={f.domainType} onChange={(e) => setF({ ...f, domainType: e.target.value })}>
            <option value="">Any domain</option><option value="custom">Custom domain</option><option value="staging">Staging (tekmetric.site…)</option>
          </select>
          <button className="sm ghost" onClick={() => setMoreOpen((x) => !x)}>{moreOpen ? "Hide dates ▴" : "Dates ▾"}{!moreOpen && (f.createdFrom || f.createdTo || f.firstFrom || f.firstTo || f.lastFrom || f.lastTo) ? " •" : ""}</button>
          <span className="spacer" />
          <button className="sm ghost" onClick={() => setF(EMPTY)}>Clear filters</button>
        </div>
        {moreOpen && (
          <div className="row small" style={{ flexWrap: "wrap", gap: 12 }}>
            <DateRange label="Created" from={f.createdFrom} to={f.createdTo} set={(a, b) => setF({ ...f, createdFrom: a, createdTo: b })} />
            <DateRange label="First published" from={f.firstFrom} to={f.firstTo} set={(a, b) => setF({ ...f, firstFrom: a, firstTo: b })} />
            <DateRange label="Last published" from={f.lastFrom} to={f.lastTo} set={(a, b) => setF({ ...f, lastFrom: a, lastTo: b })} />
          </div>
        )}
      </div>

      {/* List */}
      <div className="card">
        <div className="row between small" style={{ marginBottom: 8 }}>
          <span className="muted">{shown.length.toLocaleString()} website(s)</span>
          <Pager page={page} total={shown.length} set={setPage} />
        </div>
        {!d.rows.length ? <p className="muted">No websites yet. {d.canManage ? <>Click <b>Import site list (CSV)</b> and drop Duda&apos;s export.</> : "Ask an admin to import Duda's site list."}</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="t small">
              <thead><tr><th>Website</th><th>Duda</th><th>Labels</th><th>Created</th><th>First published</th><th>Last published</th><th style={{ minWidth: 260 }}>Domain health</th><th>Last checked</th></tr></thead>
              <tbody>{pageRows.map((r) => {
                const fl = flagsOf(r);
                return [
                  <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { const o = open === r.id ? null : r.id; setOpen(o); if (o) loadDetail(o); }}>
                    <td><b>{r.site_name}</b><div><a href={`https://${r.domain}/`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{r.domain}</a></div><div className="muted">{r.alias}</div></td>
                    <td><span className={`badge ${r.duda_status === "PUBLISHED" ? "ok" : ""}`}>{r.duda_status.toLowerCase()}</span>{r.missing ? <div><span className="badge warning">not in last import</span></div> : null}</td>
                    <td>{r.labels.split(",").filter(Boolean).map((l) => <span key={l} className="badge" style={{ marginRight: 2 }}>{l}</span>)}</td>
                    <td>{day(r.created_at)}</td><td>{day(r.first_publish) || "—"}</td><td>{day(r.last_publish) || "—"}</td>
                    <td>
                      <span className={`badge ${TONE[r.health] || ""}`}>{L[r.health] || r.health}</span>
                      {r.health_detail && <div className="muted" style={{ maxWidth: 380 }}>{r.health_detail}</div>}
                      {fl.filter((x) => x !== "staging_domain").map((x) => <div key={x}><span className="badge warning">{d.flagLabels[x] || x}</span></div>)}
                      {r.health_changed_at && r.prev_health && <div className="muted">Was “{L[r.prev_health] || r.prev_health}” — changed {ago(r.health_changed_at)}</div>}
                      {r.recent.length > 0 && <div style={{ marginTop: 4 }}><Strip list={r.recent} title="Last checks (oldest → newest)" /> <span className="muted">{r.uptime_pct !== null ? `${r.uptime_pct}% up · 30 days` : ""}</span>{r.open_incident && <span className="badge error" style={{ marginLeft: 4 }}>down since {day(r.open_incident)}</span>}</div>}
                      {r.launch_flags.map((x) => <div key={x}><span className="badge warning">{LAUNCH[x] || x}{x !== "billing_failed" && r.launch_days !== null ? ` · ${r.launch_days} days` : ""}</span></div>)}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{ago(r.checked_at)}<div><button className="sm" disabled={busy[r.id]} onClick={(e) => { e.stopPropagation(); checkOne(r.id); }}>{busy[r.id] ? "Checking…" : "Check now"}</button></div></td>
                  </tr>,
                  open === r.id && <tr key={`d${r.id}`}><td colSpan={8}><Detail data={detail[r.id]} row={r} onGbp={async () => { try { await api("/api/websites/gbp", { body: { id: r.id } }); await load(); loadDetail(r.id); } catch (e) { setErr((e as Error).message); } }} /></td></tr>,
                ];
              })}</tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}><Pager page={page} total={shown.length} set={setPage} /></div>
      </div>
    </div>
  );
}

/** Compact label filter: a button that opens a checklist (instead of 50 chips on the page). */
function LabelPicker({ labels, value, mode, onChange }: { labels: [string, number][]; value: string[]; mode: "any" | "all"; onChange: (v: string[], m: "any" | "all") => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".label-picker")) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const list = labels.filter(([l]) => !q || l.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="label-picker" style={{ position: "relative" }}>
      <button onClick={() => setOpen((x) => !x)} style={{ minWidth: 150, textAlign: "left" }}>
        {value.length ? `Labels: ${value.slice(0, 3).join(", ")}${value.length > 3 ? ` +${value.length - 3}` : ""}` : "Any label"} ▾
      </button>
      {open && (
        <div className="card stack small" style={{ position: "absolute", zIndex: 20, top: "110%", left: 0, width: 260, maxHeight: 360, overflowY: "auto", padding: 10 }}>
          <input placeholder="Find a label…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="row" style={{ gap: 6 }}>
            <span className="muted">Show sites with</span>
            <select value={mode} onChange={(e) => onChange(value, e.target.value as "any" | "all")} style={{ width: "auto" }}><option value="any">any of these</option><option value="all">all of these</option></select>
          </div>
          {list.map(([l, n]) => (
            <label key={l} className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={value.includes(l)} onChange={() => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l], mode)} />
              <span style={{ flex: 1 }}>{l}</span><span className="muted">{n}</span>
            </label>
          ))}
          {value.length > 0 && <button className="sm ghost" onClick={() => onChange([], mode)}>Clear labels</button>}
        </div>
      )}
    </div>
  );
}

function Pager({ page, total, set }: { page: number; total: number; set: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return <div className="row small" style={{ gap: 6 }}><button className="sm" disabled={page === 0} onClick={() => set(page - 1)}>‹ Prev</button><span className="muted">Page {page + 1} of {pages}</span><button className="sm" disabled={page >= pages - 1} onClick={() => set(page + 1)}>Next ›</button></div>;
}

function DateRange({ label, from, to, set }: { label: string; from: string; to: string; set: (a: string, b: string) => void }) {
  return <span className="row" style={{ gap: 4 }}><span className="muted">{label}</span><input type="date" value={from} onChange={(e) => set(e.target.value, to)} style={{ width: 150 }} /><span className="muted">to</span><input type="date" value={to} onChange={(e) => set(from, e.target.value)} style={{ width: 150 }} /></span>;
}

function ImportBox({ onFile, onCancel, last }: { onFile: (f: File, refresh: boolean) => void; onCancel: () => void; last: Data["import"] }) {
  const [over, setOver] = useState(false);
  const [refresh, setRefresh] = useState(false);
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Import Duda site list</h2>
      <p className="muted small" style={{ margin: 0 }}>In Duda: <b>Sites → Export site list</b>, then drop the .csv here. New Site Aliases are added; aliases already in this list are <b>not</b> added again (their health history is kept).{last ? ` Last import ${ago(last.at)}: ${last.added} added, ${last.skipped} already there.` : ""}</p>
      <label className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const file = e.dataTransfer.files[0]; if (file) onFile(file, refresh); }}>
        <b>Drop the site list .csv</b><div className="small">or click to choose</div>
        <input type="file" hidden accept=".csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file, refresh); e.target.value = ""; }} />
      </label>
      <label className="row small"><input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} /> Also update the details of sites already in the list (Duda status, publish dates, labels, domain)</label>
      <div><button className="sm ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

type Info = { url: string; finalUrl?: string; status?: number; ms?: number; chain: { status: number; from: string; to: string }[]; dns?: { a: string[]; cname: string[]; error?: string }; platform?: string; dudaAlias?: string; title?: string; ssl?: { validTo?: string; issuer?: string; error?: string }; rdap?: { expires?: string; status?: string[]; registrar?: string; error?: string }; error?: string;
  page?: { phone?: string; address?: string; gbp?: { cid: string; placeId: string; title: string } } };
type Uptime = { checks: number; up: number; down: number; pct: number | null };
type DetailData = {
  info: Info | null;
  uptime: { points: { t: string; h: string; ms?: number }[]; d30: Uptime; d90: Uptime };
  incidents: { start: string; end?: string; h: string; detail: string }[];
  gbp: { status: string; website?: string; title?: string; address?: string; phone?: string; cid?: string; matchedBy?: string; error?: string; checkedAt?: string | null; provider?: string } | null;
  alerts: { id: number; at: string; kind: string; title: string; detail: string }[];
};
const GBP_TEXT: Record<string, string> = { ok: "✓ Links to this website", other: "Links to a different website", none: "Has no website link", not_found: "Couldn't find the GBP", error: "Check failed" };
const dur = (a: string, b?: string) => { const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a); const h = ms / 3_600_000; return h < 48 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} days`; };
const fmtPhone = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);

function Detail({ data, row, onGbp }: { data: unknown; row: Row; onGbp: () => Promise<void> }) {
  const [gbpBusy, setGbpBusy] = useState(false);
  if (data === undefined) return <p className="muted small">Loading…</p>;
  const d = data as DetailData;
  const i = d.info;
  const line = (k: string, v: React.ReactNode) => <div><span className="muted" style={{ display: "inline-block", width: 150 }}>{k}</span>{v}</div>;
  const pct = (u: Uptime) => (u.pct === null ? "—" : `${u.pct}%`);
  return (
    <div className="small stack" style={{ gap: 10 }}>
      {/* Uptime */}
      <div className="stack" style={{ gap: 4 }}>
        <b>Uptime</b>
        {d.uptime.points.length ? <>
          <div><Strip list={d.uptime.points.map((p) => p.h)} size={7} title="Each bar is one check (oldest → newest): green = live, red = down, amber = other" /></div>
          <div className="muted">Last 30 days: <b style={{ color: "var(--text)" }}>{pct(d.uptime.d30)}</b> ({d.uptime.d30.checks} checks, down {d.uptime.d30.down}×) · last 90 days: <b style={{ color: "var(--text)" }}>{pct(d.uptime.d90)}</b> · based on the scheduled checks</div>
        </> : <span className="muted">No history yet — it builds up with every check (set Automatic check to Daily).</span>}
        {d.incidents.length > 0 && (
          <table className="t small" style={{ maxWidth: 760 }}><tbody>{d.incidents.slice(0, 8).map((x, k) => (
            <tr key={k}><td style={{ whiteSpace: "nowrap" }}>{x.end ? <span className="badge">resolved</span> : <span className="badge error">ongoing</span>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{day(x.start)}{x.end ? ` → ${day(x.end)}` : ""}</td><td style={{ whiteSpace: "nowrap" }}>{dur(x.start, x.end)}</td><td className="muted">{x.detail}</td></tr>
          ))}</tbody></table>
        )}
      </div>

      {/* Google Business Profile */}
      <div className="stack" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 8 }}><b>Google Business Profile</b>
          <button className="sm" disabled={gbpBusy} onClick={async () => { setGbpBusy(true); await onGbp(); setGbpBusy(false); }}>{gbpBusy ? "Checking…" : d.gbp ? "Check again" : "Check GBP"}</button>
          <span className="muted">uses 1 Maps search credit</span></div>
        {d.gbp ? <>
          <div><span className={`badge ${d.gbp.status === "ok" ? "ok" : d.gbp.status === "error" || d.gbp.status === "not_found" ? "" : "warning"}`}>{GBP_TEXT[d.gbp.status] || d.gbp.status}</span> <span className="muted">{d.gbp.checkedAt ? `checked ${ago(d.gbp.checkedAt)}` : ""}{d.gbp.provider ? ` via ${d.gbp.provider}` : ""}</span></div>
          {d.gbp.title && line("GBP", `${d.gbp.title}${d.gbp.address ? ` — ${d.gbp.address}` : ""}`)}
          {d.gbp.status !== "not_found" && d.gbp.status !== "error" && line("GBP website", d.gbp.website || "(none)")}
          {d.gbp.cid && line("Maps link", <a href={`https://www.google.com/maps?cid=${d.gbp.cid}`} target="_blank" rel="noreferrer noopener">open the GBP</a>)}
          {d.gbp.matchedBy && line("Matched by", d.gbp.matchedBy)}
          {d.gbp.error && line("Error", d.gbp.error)}
        </> : <span className="muted">Not checked yet.</span>}
        {i?.page && (i.page.phone || i.page.address || i.page.gbp) && <div className="muted">Their homepage shows: {[i.page.phone && fmtPhone(i.page.phone), i.page.address, i.page.gbp && "a Google Maps link"].filter(Boolean).join(" · ")}</div>}
      </div>

      {/* Last check */}
      {i ? (
        <div className="stack" style={{ gap: 2 }}>
          <b>Last check</b>
          {line("Checked", `${i.url} ${i.status ? `→ HTTP ${i.status}` : ""}${i.ms ? ` in ${(i.ms / 1000).toFixed(1)} s` : ""}`)}
          {i.chain?.length > 0 && line("Redirects", i.chain.map((c) => `${c.status} ${c.to}`).join("  →  "))}
          {i.finalUrl && i.finalUrl !== i.url && line("Ends at", i.finalUrl)}
          {i.title && line("Page title", i.title)}
          {i.platform && line("Platform", `${i.platform}${i.dudaAlias ? ` (Duda site ${i.dudaAlias}${i.dudaAlias !== row.alias ? ` — this list says ${row.alias}` : " ✓"})` : ""}`)}
          {i.dns && line("DNS", i.dns.error ? i.dns.error : `${[...i.dns.cname.map((c) => `CNAME ${c}`), ...i.dns.a].join(", ") || "none"}`)}
          {i.ssl && line("SSL certificate", i.ssl.error ? `problem: ${i.ssl.error}` : `${i.ssl.issuer || ""} · expires ${i.ssl.validTo?.slice(0, 10) || "?"}`)}
          {i.rdap && line("Domain registration", i.rdap.error ? i.rdap.error : `${i.rdap.registrar || ""} · expires ${i.rdap.expires?.slice(0, 10) || "?"}${i.rdap.status?.length ? ` · ${i.rdap.status.join(", ")}` : ""}`)}
          {!i.rdap && row.domain_expires && line("Domain registration", `expires ${row.domain_expires.slice(0, 10)} (checked earlier this week)`)}
          {i.error && line("Error", i.error)}
        </div>
      ) : <p className="muted">Not checked yet — click “Check now”.</p>}

      {d.alerts.length > 0 && (
        <div className="stack" style={{ gap: 2 }}><b>Alerts for this site</b>
          {d.alerts.slice(0, 6).map((a) => <div key={a.id}><span className="muted">{ago(a.at)}</span> · {a.title}</div>)}
        </div>
      )}
    </div>
  );
}

/* ---------------- "What changed" + browser alerts ---------------- */

type AlertRow = { id: number; website_id: number; at: string; kind: string; health: string; title: string; detail: string; site_name: string; domain: string };
const KIND: Record<string, [string, string]> = { down: ["Down", "error"], recovered: ["Back up", "ok"], changed: ["Changed", "warning"], warning: ["Warning", "warning"] };
const toKey = (b64: string) => { const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

function AlertsPanel({ onOpenSite }: { onOpenSite: (domain: string) => void }) {
  const [a, setA] = useState<{ events: AlertRow[]; seen: number; unread: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [push, setPush] = useState<"unsupported" | "off" | "on" | "busy" | "denied">("off");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api<{ events: AlertRow[]; seen: number; unread: number }>("/api/websites/alerts").then(setA).catch(() => {}), []);
  useEffect(() => {
    load();
    try { if (new URLSearchParams(window.location.search).get("alerts")) setOpen(true); } catch { /* ignore */ }
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setPush("unsupported"); return; }
      if (Notification.permission === "denied") { setPush("denied"); return; }
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      setPush(sub ? "on" : "off");
    })().catch(() => setPush("unsupported"));
  }, [load]);
  const turnOn = async () => {
    setMsg(""); setPush("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPush(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>("/api/websites/push");
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
      const j = sub.toJSON();
      await api("/api/websites/push", { body: { subscription: { endpoint: j.endpoint, keys: j.keys }, label: navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || "browser" } });
      setPush("on"); setMsg("Alerts are on for this browser. Use “Send test” to try it.");
    } catch (e) { setPush("off"); setMsg(`Couldn't turn alerts on: ${(e as Error).message}`); }
  };
  const turnOff = async () => {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api("/api/websites/push", { body: { remove: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    setPush("off"); setMsg("Alerts are off for this browser.");
  };
  const test = () => api("/api/websites/push", { body: { test: true } }).then(() => setMsg("Test sent — it should pop up in a few seconds.")).catch((e) => setMsg((e as Error).message));
  const seenAll = async () => { if (!a?.events.length) return; await api("/api/websites/alerts", { body: { seen: a.events[0].id } }).catch(() => {}); load(); window.dispatchEvent(new Event("alerts-seen")); };
  const list = (a?.events || []).slice(0, all ? 200 : 8);
  return (
    <div className="card stack small" style={{ boxShadow: "none", padding: "10px 14px", gap: 8 }}>
      <div className="row between">
        <button className="ghost" style={{ padding: 0, fontWeight: 600 }} onClick={() => setOpen((x) => !x)}>
          {open ? "▾" : "▸"} What changed {a?.unread ? <span className="badge error" style={{ marginLeft: 4 }}>{a.unread} new</span> : <span className="muted" style={{ fontWeight: 400 }}> · no new alerts</span>}
        </button>
        <div className="row" style={{ gap: 6 }}>
          {push === "on" ? <><span className="badge ok">🔔 Alerts on (this browser)</span><button className="sm ghost" onClick={test}>Send test</button><button className="sm ghost" onClick={turnOff}>Turn off</button></>
            : push === "unsupported" ? <span className="muted" title="On iPhone/iPad: Share → Add to Home Screen, open it from there, then turn alerts on.">Browser alerts not available here</span>
            : push === "denied" ? <span className="muted">Notifications are blocked for this site in your browser settings</span>
            : <button className="sm" disabled={push === "busy"} onClick={turnOn} title="Get a notification on this computer when the scheduled check finds a site down — no email or Slack needed">🔔 Turn on alerts</button>}
        </div>
      </div>
      {msg && <div className="muted">{msg}</div>}
      {open && (
        !list.length ? <div className="muted">Nothing yet. Alerts appear when a check finds a site went down, came back, changed, or got a new warning.</div> : <>
          <table className="t small"><tbody>{list.map((e) => (
            <tr key={e.id} style={{ fontWeight: a && e.id > a.seen ? 600 : 400 }}>
              <td style={{ whiteSpace: "nowrap" }}>{ago(e.at)}</td>
              <td><span className={`badge ${KIND[e.kind]?.[1] || ""}`}>{KIND[e.kind]?.[0] || e.kind}</span></td>
              <td><a href="#" onClick={(ev) => { ev.preventDefault(); onOpenSite(e.domain); }}>{e.site_name || e.domain}</a><div className="muted">{e.domain}</div></td>
              <td>{e.title}<div className="muted" style={{ fontWeight: 400 }}>{e.detail}</div></td>
            </tr>
          ))}</tbody></table>
          <div className="row" style={{ gap: 6 }}>
            {(a?.events.length || 0) > 8 && <button className="sm ghost" onClick={() => setAll((x) => !x)}>{all ? "Show fewer" : `Show all ${a!.events.length}`}</button>}
            {!!a?.unread && <button className="sm" onClick={seenAll}>Mark all as seen</button>}
          </div>
        </>
      )}
    </div>
  );
}

function MonitoringSettings({ s, onSaved, onError }: { s: Data["settings"]; onSaved: (s: Data["settings"]) => void; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(s);
  const [batch, setBatch] = useState("");
  useEffect(() => setV(s), [s]);
  const save = (patch: Partial<Data["settings"]>) => api<Data["settings"]>("/api/websites/settings", { method: "PUT", body: patch }).then(onSaved).catch((e) => onError(e.message));
  const runBatch = async () => {
    setBatch("Checking 10 sites…");
    try { const r = await api<{ done: number; remaining: number; stoppedBy?: string }>("/api/websites/gbp", { body: { batch: 10 } }); setBatch(`Checked ${r.done} · ${r.remaining.toLocaleString()} live site(s) still to check${r.stoppedBy && r.stoppedBy !== "time" ? ` · stopped: ${r.stoppedBy}` : ""}`); }
    catch (e) { setBatch(""); onError((e as Error).message); }
  };
  if (!open) return <div className="small"><button className="sm ghost" onClick={() => setOpen(true)}>⚙ Monitoring settings</button></div>;
  const num = (k: "notLiveDays" | "tempDomainDays" | "gbpPerDay", label: string, min: number, max: number, hint: string) => (
    <label className="field" style={{ maxWidth: 260 }}><span>{label}</span>
      <input type="number" min={min} max={max} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} onBlur={() => { if (v[k] !== s[k]) save({ [k]: v[k] } as Partial<Data["settings"]>); }} />
      <span className="muted small">{hint}</span></label>
  );
  return (
    <div className="card stack small" style={{ boxShadow: "none" }}>
      <div className="row between"><b>Monitoring settings</b><button className="sm ghost" onClick={() => setOpen(false)}>Close</button></div>
      <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {num("notLiveDays", "Launch tracker: not published after (days)", 1, 365, "Created in Duda but still unpublished")}
        {num("tempDomainDays", "…or only on tekmetric.site after (days)", 1, 365, "Published but the custom domain never connected")}
        {num("gbpPerDay", "GBP website checks per day", 0, 200, "Uses Maps search credits (free plans: a few hundred a month). 0 = only when you click.")}
      </div>
      <div className="row" style={{ gap: 8 }}><button className="sm" onClick={runBatch} disabled={batch.startsWith("Checking")}>Check GBP for 10 sites now</button><span className="muted">{batch || "Live sites never checked go first."}</span></div>
      <div className="muted">Uptime is measured by the automatic check — set it to <b>Daily</b> for a useful history.</div>
    </div>
  );
}
