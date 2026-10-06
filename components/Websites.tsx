"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ago } from "./api";

type Row = {
  id: number; alias: string; site_name: string; domain: string; duda_status: string; created_at: string | null; first_publish: string | null; last_publish: string | null;
  subscription: string | null; labels: string; health: string; health_detail: string; health_flags: string; checked_at: string | null; health_changed_at: string | null; prev_health: string | null;
  domain_expires: string | null; ssl_expires: string | null; missing: number;
};
type Run = { id: number; status: string; scope: string; total: number; done: number; started_by: string | null; started_at: string; finished_at: string | null };
type Data = {
  rows: Row[]; canManage: boolean; run: Run | null; settings: { schedule: string };
  import: { at: string; total: number; added: number; skipped: number; refreshed: number; missing: number } | null;
  healthLabels: Record<string, string>; healthOrder: string[]; flagLabels: Record<string, string>;
};

const TONE: Record<string, string> = { ok: "ok", redirect: "warning", moved: "warning", ssl: "warning", taken: "error", parked: "error", not_found: "error", error: "error", dns: "error", down: "error", unchecked: "", skipped: "" };
const STAGING = /\.(tekmetric\.site|shopgenie\.site|multiscreensite\.com|dudaone\.com)$/i;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const PAGE = 50;
type Filters = { q: string; status: string; health: string; flag: string; labels: string[]; labelMode: "any" | "all"; domainType: string; createdFrom: string; createdTo: string; firstFrom: string; firstTo: string; lastFrom: string; lastTo: string };
const EMPTY: Filters = { q: "", status: "", health: "", flag: "", labels: [], labelMode: "any", domainType: "", createdFrom: "", createdTo: "", firstFrom: "", firstTo: "", lastFrom: "", lastTo: "" };

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

  const allLabels = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of d?.rows || []) for (const l of r.labels.split(",").filter(Boolean)) c.set(l, (c.get(l) || 0) + 1);
    return [...c.entries()].sort((a, b) => (/^\d+$/.test(a[0]) ? 1 : 0) - (/^\d+$/.test(b[0]) ? 1 : 0) || b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [d]);

  // every filter except health/warning (so the tiles show counts for the current selection)
  const base = useMemo(() => (d?.rows || []).filter((r) => {
    if (f.q) { const q = f.q.toLowerCase(); if (!`${r.site_name} ${r.domain} ${r.alias} ${r.health_detail}`.toLowerCase().includes(q)) return false; }
    if (f.status && r.duda_status !== f.status) return false;
    if (f.domainType === "custom" && STAGING.test(r.domain)) return false;
    if (f.domainType === "staging" && !STAGING.test(r.domain)) return false;
    if (f.labels.length) { const ls = r.labels.split(","); if (f.labelMode === "all" ? !f.labels.every((l) => ls.includes(l)) : !f.labels.some((l) => ls.includes(l))) return false; }
    const inRange = (v: string | null, from: string, to: string) => (!from || (!!v && day(v) >= from)) && (!to || (!!v && day(v) <= to));
    return inRange(r.created_at, f.createdFrom, f.createdTo) && inRange(r.first_publish, f.firstFrom, f.firstTo) && inRange(r.last_publish, f.lastFrom, f.lastTo);
  }), [d, f]);
  const flagsOf = (r: Row) => { try { return JSON.parse(r.health_flags || "[]") as string[]; } catch { return []; } };
  const shown = useMemo(() => base.filter((r) => (!f.health || r.health === f.health) && (!f.flag || (f.flag === "missing" ? r.missing : f.flag === "changed" ? !!r.health_changed_at : flagsOf(r).includes(f.flag)))), [base, f.health, f.flag]);

  const counts = useMemo(() => {
    const h: Record<string, number> = {}, fl: Record<string, number> = {};
    let changed = 0, missing = 0;
    for (const r of base) { h[r.health] = (h[r.health] || 0) + 1; for (const x of flagsOf(r)) fl[x] = (fl[x] || 0) + 1; if (r.health_changed_at) changed++; if (r.missing) missing++; }
    return { h, fl, changed, missing };
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
  async function loadDetail(id: number) { try { const r = await api<{ info: unknown }>(`/api/websites/${id}`); setDetail((x) => ({ ...x, [id]: r.info })); } catch { /* ignore */ } }
  async function exportCsv() {
    const r = await fetch("/api/websites/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: shown.map((x) => x.id) }) });
    if (!r.ok) { setErr("Export failed"); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = `website-health-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  if (!d) return <p className="muted">{err || "Loading…"}</p>;
  const L = d.healthLabels;
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE);
  const tile = (key: string, label: string, n: number, tone = "", kind: "health" | "flag" = "health") => {
    const active = kind === "health" ? f.health === key : f.flag === key;
    return (
      <button key={kind + key} className={`stat ${active ? "active" : ""}`} style={{ border: active ? "2px solid var(--accent)" : "2px solid transparent", textAlign: "left", cursor: "pointer" }}
        onClick={() => setF((x) => kind === "health" ? { ...x, health: x.health === key ? "" : key, flag: "" } : { ...x, flag: x.flag === key ? "" : key, health: "" })}>
        <b style={{ color: tone === "error" ? "var(--error)" : tone === "warning" ? "var(--warning)" : tone === "ok" ? "var(--ok)" : undefined }}>{n.toLocaleString()}</b><span>{label}</span>
      </button>
    );
  };
  const live = (counts.h.ok || 0);
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
            <select value={d.settings.schedule} onChange={(e) => api<{ schedule: string }>("/api/websites/settings", { method: "PUT", body: { schedule: e.target.value } }).then((s) => setD((x) => x && { ...x, settings: s })).catch((er) => setErr(er.message))}>
              <option value="off">Off</option><option value="weekly">Weekly</option><option value="daily">Daily</option>
            </select>
          </label>
        )}
      </div>

      {/* At a glance */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="stat"><b>{base.length.toLocaleString()}</b><span>Websites</span></div>
        <div className="stat"><b>{base.filter((r) => r.duda_status === "PUBLISHED").length.toLocaleString()}</b><span>Published in Duda</span></div>
        {tile("ok", L.ok, live, "ok")}
        {d.healthOrder.filter((h) => h !== "ok").map((h) => tile(h, L[h], counts.h[h] || 0, TONE[h]))}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {Object.keys(d.flagLabels).map((k) => tile(k, d.flagLabels[k], counts.fl[k] || 0, k === "staging_domain" ? "" : "warning", "flag"))}
        {tile("changed", "Health changed since a previous check", counts.changed, "warning", "flag")}
        {tile("missing", "Not in the latest import (deleted in Duda?)", counts.missing, "warning", "flag")}
      </div>

      {/* Filters */}
      <div className="card stack" style={{ boxShadow: "none" }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input style={{ maxWidth: 260 }} placeholder="Search name, domain, alias…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select style={{ maxWidth: 170 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Any Duda status</option><option value="PUBLISHED">Published</option><option value="UNPUBLISHED">Unpublished</option><option value="IN PLANNING">In planning</option>
          </select>
          <select style={{ maxWidth: 220 }} value={f.health} onChange={(e) => setF({ ...f, health: e.target.value })}>
            <option value="">Any domain health</option>{d.healthOrder.map((h) => <option key={h} value={h}>{L[h]}</option>)}
          </select>
          <select style={{ maxWidth: 170 }} value={f.domainType} onChange={(e) => setF({ ...f, domainType: e.target.value })}>
            <option value="">Any domain</option><option value="custom">Custom domain</option><option value="staging">Staging (tekmetric.site…)</option>
          </select>
          <span className="spacer" />
          <button className="sm ghost" onClick={() => setF(EMPTY)}>Clear filters</button>
        </div>
        <div className="row small" style={{ flexWrap: "wrap", gap: 12 }}>
          <DateRange label="Created" from={f.createdFrom} to={f.createdTo} set={(a, b) => setF({ ...f, createdFrom: a, createdTo: b })} />
          <DateRange label="First published" from={f.firstFrom} to={f.firstTo} set={(a, b) => setF({ ...f, firstFrom: a, firstTo: b })} />
          <DateRange label="Last published" from={f.lastFrom} to={f.lastTo} set={(a, b) => setF({ ...f, lastFrom: a, lastTo: b })} />
        </div>
        <div className="row small" style={{ flexWrap: "wrap", gap: 4 }}>
          <span className="muted">Labels</span>
          <select className="sm" value={f.labelMode} onChange={(e) => setF({ ...f, labelMode: e.target.value as "any" | "all" })} style={{ width: "auto" }}>
            <option value="any">match any</option><option value="all">match all</option>
          </select>
          {allLabels.map(([l, n]) => (
            <button key={l} className={`sm ${f.labels.includes(l) ? "primary" : "ghost"}`} onClick={() => setF({ ...f, labels: f.labels.includes(l) ? f.labels.filter((x) => x !== l) : [...f.labels, l] })}>{l} <span className="muted">{n}</span></button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="card">
        <div className="row between small" style={{ marginBottom: 8 }}>
          <span className="muted">{shown.length.toLocaleString()} website(s){f.health || f.flag ? " (tile filter on — click it again to clear)" : ""}</span>
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
                      {fl.map((x) => <div key={x}><span className="badge warning">{d.flagLabels[x] || x}</span></div>)}
                      {r.health_changed_at && r.prev_health && <div className="muted">Was “{L[r.prev_health] || r.prev_health}” — changed {ago(r.health_changed_at)}</div>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{ago(r.checked_at)}<div><button className="sm" disabled={busy[r.id]} onClick={(e) => { e.stopPropagation(); checkOne(r.id); }}>{busy[r.id] ? "Checking…" : "Check now"}</button></div></td>
                  </tr>,
                  open === r.id && <tr key={`d${r.id}`}><td colSpan={8}><Detail info={detail[r.id]} row={r} /></td></tr>,
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

type Info = { url: string; finalUrl?: string; status?: number; ms?: number; chain: { status: number; from: string; to: string }[]; dns?: { a: string[]; cname: string[]; error?: string }; platform?: string; dudaAlias?: string; title?: string; ssl?: { validTo?: string; issuer?: string; error?: string }; rdap?: { expires?: string; status?: string[]; registrar?: string; error?: string }; error?: string };
function Detail({ info, row }: { info: unknown; row: Row }) {
  const i = info as Info | null | undefined;
  if (info === undefined) return <p className="muted small">Loading…</p>;
  if (!i) return <p className="muted small">Not checked yet — click “Check now”.</p>;
  const line = (k: string, v: React.ReactNode) => <div><span className="muted" style={{ display: "inline-block", width: 150 }}>{k}</span>{v}</div>;
  return (
    <div className="small stack" style={{ gap: 2 }}>
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
  );
}
