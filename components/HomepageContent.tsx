"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ago } from "./api";

type Item = { id: string; label: string; text: string; min: number; max: number; len: number; issue: string; edited?: boolean };
type Section = { title: string; items: Item[] };
type Version = { at: string; promptName: string; provider: string; sections: Section[]; issues: string[]; fixRounds: number; text: string };
type View = { template: string | null; prompts: { id: string; name: string }[]; suggested: string | null; selected: string | null; versions: Version[]; current: number };
type Job = { id: number; status: string; steps: string[]; idx: number; log: { step: string; ok: boolean; summary: string }[] };

/** Homepage content written from the team's template prompt + this project's Data Collection. */
export default function HomepageContent({ siteId, canManage }: { siteId: number; canManage: boolean }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [copied, setCopied] = useState("");
  const seen = useRef(-1);

  const load = useCallback(() => api<View>(`/api/sites/${siteId}/homepage`).then(setV).catch((e) => setErr(e.message)), [siteId]);
  useEffect(() => { load(); }, [load]);

  // generation runs on the server (same background runner as research) — follow it
  const active = !!job && ["queued", "running", "stopping"].includes(job.status) && job.steps.includes("homepage");
  useEffect(() => {
    let alive = true, t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<{ job: Job | null }>(`/api/sites/${siteId}/collection/job`);
        if (!alive) return;
        setJob(r.job);
        if (r.job && r.job.log.length !== seen.current) { if (seen.current >= 0) load(); seen.current = r.job.log.length; }
        if (r.job && ["queued", "running", "stopping"].includes(r.job.status)) t = setTimeout(poll, 2500);
      } catch { if (alive) t = setTimeout(poll, 5000); }
    };
    poll();
    return () => { alive = false; clearTimeout(t); };
  }, [siteId, active, load]);

  async function generate() {
    setErr("");
    try { const r = await api<{ job: Job; existing: boolean }>(`/api/sites/${siteId}/collection/job`, { body: { steps: ["homepage"] } }); if (r.existing && !r.job.steps.includes("homepage")) setErr("Research is still running for this project — try again when it finishes."); seen.current = r.job.log.length; setJob(r.job); }
    catch (e) { setErr((e as Error).message); }
  }
  const put = (body: Record<string, unknown>) => api<View>(`/api/sites/${siteId}/homepage`, { method: "PUT", body }).then(setV).catch((e) => setErr(e.message));
  const copy = async (text: string, key: string) => { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); };

  if (!v) return <p className="muted">{err || "Loading…"}</p>;
  const ver = v.versions[v.current];
  const lastLog = job?.log.filter((l) => l.step === "homepage").slice(-1)[0];

  return (
    <div className="stack">
      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}
      <div className="card stack" style={{ boxShadow: "none", background: "var(--panel-2)" }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>Homepage content</h3>
            <div className="muted small">Written by free AI from your template prompt + this project&apos;s Data Collection, then every line is checked against its character limit.</div>
          </div>
          <button className="primary" disabled={active || !v.prompts.length} onClick={generate}>{active ? "Writing…" : ver ? "Write a new version" : "Write homepage content"}</button>
        </div>
        {!v.prompts.length ? (
          <div className="alert warning small">No homepage prompts yet. {canManage ? <>Import them in <b>Settings → Homepage prompts</b> (the &quot;My homepage prompt&quot; sheet).</> : "Ask an admin to import them in Settings → Homepage prompts."}</div>
        ) : (
          <label className="row small" style={{ gap: 6 }}>Template prompt
            <select value={v.selected || ""} onChange={(e) => put({ selected: e.target.value })} style={{ maxWidth: 360 }}>
              {!v.selected && <option value="">— pick a prompt —</option>}
              {v.prompts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === v.suggested ? " (matches this project)" : ""}</option>)}
            </select>
            {!v.suggested && <span className="muted">No prompt matches “{v.template || "this template"}” — pick the closest one.</span>}
          </label>
        )}
        {active && <div className="small">Writing the homepage… usually under a minute. It runs on the server — you can leave this page.</div>}
        {!active && lastLog && !lastLog.ok && <div className="alert error small">{lastLog.summary}</div>}
      </div>

      {ver && (
        <>
          <div className="row between">
            <div className="small">
              <b>{ver.promptName}</b> <span className="muted">· written {ago(ver.at)} · {ver.provider.split(":")[0]}{ver.fixRounds ? ` · ${ver.fixRounds} fix round(s)` : ""}</span>
              {v.versions.length > 1 && (
                <select className="sm" style={{ width: "auto", marginLeft: 8 }} value={v.current} onChange={(e) => put({ current: Number(e.target.value) })}>
                  {v.versions.map((x, i) => <option key={i} value={i}>Version {i + 1} — {ago(x.at)}</option>)}
                </select>
              )}
            </div>
            <div className="row">
              <span className={`badge ${ver.issues.length ? "warning" : "ok"}`}>{ver.issues.length ? `${ver.issues.length} line(s) to check` : "All character limits met"}</span>
              <button className="primary sm" onClick={() => copy(ver.text, "all")}>{copied === "all" ? "✓ Copied" : "Copy all"}</button>
            </div>
          </div>
          {ver.issues.length > 0 && <details className="small"><summary>What to check</summary><ul style={{ margin: "4px 0", paddingLeft: 18 }}>{ver.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}

          {ver.sections.map((s, si) => (
            <div key={si} className="card" style={{ boxShadow: "none", padding: 12 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <b>{s.title}</b>
                <button className="sm ghost" onClick={() => copy([s.title, ...s.items.map((it) => `${it.label}: ${it.text}`)].join("\n"), `s${si}`)}>{copied === `s${si}` ? "✓" : "Copy section"}</button>
              </div>
              <table className="t small">
                <tbody>{s.items.map((it) => (
                  <tr key={it.id} className={it.issue ? "dc-review" : "dc-ok"}>
                    <td style={{ width: 170 }}><b>{it.label}</b>{it.edited && <div className="muted">edited</div>}</td>
                    <td><LineEditor text={it.text} onSave={(text) => put({ edit: { version: v.current, item: it.id, text } })} /></td>
                    <td style={{ width: 150, whiteSpace: "nowrap" }}>
                      <span className={`badge ${it.issue ? "warning" : "ok"}`}>{it.len}{it.min || it.max ? ` / ${it.min ? `${it.min}` : "0"}–${it.max || "∞"}` : ""}</span>
                      {it.issue && <div className="muted">{it.issue}</div>}
                    </td>
                    <td style={{ width: 60 }}><button className="sm ghost" onClick={() => copy(it.text, it.id)}>{copied === it.id ? "✓" : "Copy"}</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function LineEditor({ text, onSave }: { text: string; onSave: (t: string) => void }) {
  const [t, setT] = useState(text);
  useEffect(() => setT(text), [text]);
  const rows = Math.min(10, Math.max(1, Math.ceil(t.length / 90)));
  return (
    <div>
      <textarea value={t} rows={rows} onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== text) onSave(t); }} />
      {t !== text && <div className="muted small">{t.length} characters — click outside to save</div>}
    </div>
  );
}
