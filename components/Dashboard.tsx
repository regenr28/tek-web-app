"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, ago, STATUS_LABEL, STATUS_TONE, type Member } from "./api";

const TYPE_SHORT: Record<string, string> = { basic: "Basic", advanced: "Advanced", mso: "MSO" };

type SiteRow = {
  id: number; name: string; preview_url: string; jira_key: string | null; project_type: string | null; template: string | null; editor_url: string | null; status: string; assignee_id: number | null; assignee_name: string | null;
  has_facts: number; last_run_at: string | null; job_status: string | null; page_count: number | null; open_count: number; error_count: number; done_count: number; updated_at: string;
};

export default function Dashboard() {
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [who, setWho] = useState("");
  const [adding, setAdding] = useState<"" | "jira" | "one" | "bulk">("");
  const [importing, setImporting] = useState("");
  const [over, setOver] = useState(false);
  const [form, setForm] = useState({ name: "", preview_url: "", jira_key: "", assignee_id: "" });
  const [bulk, setBulk] = useState("");
  const [err, setErr] = useState("");

  const load = () => api<SiteRow[]>("/api/sites").then(setSites).catch((e) => setErr(e.message));
  useEffect(() => { load(); api<Member[]>("/api/users").then((m) => setMembers(m.filter((x) => x.active))); }, []);
  const busy = (sites || []).some((s) => s.job_status && ["queued", "running", "stopping"].includes(s.job_status));
  useEffect(() => { if (!busy) return; const t = setInterval(load, 10_000); return () => clearInterval(t); }, [busy]);

  const shown = useMemo(() => (sites || []).filter((s) =>
    (!q || (s.name + " " + s.preview_url + " " + (s.jira_key || "")).toLowerCase().includes(q.toLowerCase())) &&
    (!status || s.status === status) && (!who || String(s.assignee_id || "") === who)), [sites, q, status, who]);

  const stats = useMemo(() => {
    const s = sites || [];
    return { total: s.length, needs: s.filter((x) => x.status === "needs_fixes").length, passed: s.filter((x) => ["passed", "published"].includes(x.status)).length, errors: s.reduce((a, x) => a + x.error_count, 0) };
  }, [sites]);

  async function importJira(file: File) {
    setErr(""); setImporting(`Reading ${file.name}…`);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await api<{ id: number; created: boolean; name: string }>("/api/projects/import", { form: fd });
      window.location.href = `/sites/${r.id}?tab=collection${r.created ? "" : "&reimported=1"}`;
    } catch (e) { setErr((e as Error).message); setImporting(""); }
  }

  async function addOne(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try {
      const r = await api<{ id: number }>("/api/sites", { body: { ...form, assignee_id: form.assignee_id ? Number(form.assignee_id) : null } });
      window.location.href = `/sites/${r.id}`;
    } catch (e) { setErr((e as Error).message); }
  }
  async function addBulk() {
    setErr("");
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    let ok = 0; const bad: string[] = [];
    for (const l of lines) {
      const parts = l.split(/\s*[|\t]\s*/);
      const url = parts.find((p) => /^https?:\/\//.test(p)) || "";
      const name = parts.find((p) => p && p !== url && !/^[A-Z]+-\d+$/.test(p)) || url;
      const jira = parts.find((p) => /^[A-Z]+-\d+$/.test(p)) || "";
      try { await api("/api/sites", { body: { name, preview_url: url, jira_key: jira } }); ok++; } catch (e) { bad.push(`${l} → ${(e as Error).message}`); }
    }
    setBulk(bad.join("\n")); if (!bad.length) setAdding("");
    if (bad.length) setErr(`Added ${ok}. ${bad.length} line(s) failed — left in the box.`);
    load();
  }
  async function patch(id: number, b: Record<string, unknown>) {
    await api(`/api/sites/${id}`, { method: "PATCH", body: b }).catch((e) => setErr(e.message));
    load();
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Projects</h1>
        <div className="row">
          <button onClick={() => setAdding(adding === "bulk" ? "" : "bulk")}>Bulk add</button>
          <button className="primary" onClick={() => setAdding(adding === "jira" ? "" : "jira")}>+ Add Project</button>
        </div>
      </div>

      <div className="row">
        <div className="stat"><b>{stats.total}</b><span>Projects</span></div>
        <div className="stat"><b style={{ color: "var(--error)" }}>{stats.needs}</b><span>Need fixes</span></div>
        <div className="stat"><b style={{ color: "var(--ok)" }}>{stats.passed}</b><span>Passed / published</span></div>
        <div className="stat"><b>{stats.errors}</b><span>Open errors</span></div>
      </div>

      {err && <div className="alert error">{err}</div>}

      {adding === "jira" && (
        <div className="card stack">
          <h2>Add Project from Jira</h2>
          <p className="muted small">In Jira open the Website Build work item → <b>⋯ → Export → Export Excel</b>, then drop the .xlsx here. The website type, template, requested pages and a first Data Collection draft are filled in for you.</p>
          <label className={`dropzone ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) importJira(f); }}>
            <b>{importing || "Drop the Jira .xlsx export"}</b>
            {!importing && <div className="small">or click to choose</div>}
            <input type="file" hidden accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJira(f); e.target.value = ""; }} />
          </label>
          <div className="row small"><span className="muted">No Jira export?</span><button className="sm" onClick={() => setAdding("one")}>Add manually</button><button className="sm ghost" onClick={() => setAdding("")}>Cancel</button></div>
        </div>
      )}
      {adding === "one" && (
        <form className="card stack" onSubmit={addOne}>
          <h2>Add a project manually</h2>
          <div className="grid2">
            <label className="field"><span>Shop / project name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Joe's Auto Repair" /></label>
            <label className="field"><span>Duda preview link (optional)</span><input type="url" value={form.preview_url} onChange={(e) => setForm({ ...form, preview_url: e.target.value })} placeholder="https://…/preview/…" /></label>
            <label className="field"><span>Jira key (optional)</span><input value={form.jira_key} onChange={(e) => setForm({ ...form, jira_key: e.target.value })} placeholder="WEB-1234" /></label>
            <label className="field"><span>Assignee</span>
              <select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          </div>
          <div className="row"><button className="primary">Create & open</button><button type="button" onClick={() => setAdding("")}>Cancel</button></div>
        </form>
      )}
      {adding === "bulk" && (
        <div className="card stack">
          <h2>Bulk add</h2>
          <p className="muted small">One site per line: <code>Name | preview link | JIRA-123</code> (Jira key optional, tabs from a spreadsheet work too).</p>
          <textarea rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"Joe's Auto | https://example.multiscreensite.com/preview/abc123 | WEB-101"} />
          <div className="row"><button className="primary" onClick={addBulk} disabled={!bulk.trim()}>Add sites</button><button onClick={() => setAdding("")}>Cancel</button></div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input style={{ maxWidth: 280 }} placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select style={{ maxWidth: 180 }} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Anyone</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <span className="spacer" /><span className="muted small">{shown.length} shown</span>
        </div>
        {!sites ? <p className="muted">Loading…</p> : !sites.length ? <p className="muted">No projects yet. Click <b>+ Add Project</b> and drop a Jira export.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="t">
              <thead><tr><th>Project</th><th>Status</th><th>Assignee</th><th>QA facts</th><th>Last audit</th><th>Open</th><th>Done</th></tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/sites/${s.id}`}><b>{s.name}</b></Link>
                      {s.jira_key && <span className="badge" style={{ marginLeft: 6 }}>{s.jira_key}</span>}
                      {s.project_type && <span className={`badge ${s.project_type === "mso" ? "warning" : s.project_type === "advanced" ? "accent" : ""}`} style={{ marginLeft: 6 }}>{TYPE_SHORT[s.project_type] || s.project_type}</span>}
                      {s.job_status && ["queued", "running", "stopping"].includes(s.job_status) && <span className="badge accent" style={{ marginLeft: 6 }}>Researching…</span>}
                      <div className="muted small" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.template ? `${s.template} · ` : ""}{s.preview_url || (s.editor_url ? "Editor linked" : "No Duda site yet")}</div>
                    </td>
                    <td>
                      <select value={s.status} onChange={(e) => patch(s.id, { status: e.target.value })} className={`badge ${STATUS_TONE[s.status]}`} style={{ border: "none" }}>
                        {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={s.assignee_id || ""} onChange={(e) => patch(s.id, { assignee_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td>{s.has_facts ? <span className="badge ok">Loaded</span> : <span className="badge warning">Missing</span>}</td>
                    <td className="small">{ago(s.last_run_at)}{s.page_count ? <div className="muted">{s.page_count} pages</div> : null}</td>
                    <td>{s.open_count ? <><span className="badge error">{s.error_count} err</span> <span className="muted small">{s.open_count} total</span></> : s.last_run_at ? <span className="badge ok">0</span> : "—"}</td>
                    <td className="small">{s.done_count || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
