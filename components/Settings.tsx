"use client";
import { useEffect, useState } from "react";
import { api, ago, type Member } from "./api";

type Me = { id: number; name: string; email: string; role: string };
type Prov = { enabled: boolean; model: string; baseUrl: string; accountId?: string; ready?: boolean; coolingUntil?: number | null; hasKey: boolean; keyHint: string; keySource: string; label: string; defaultModel: string; signup: string; note: string };
type Ai = { order: string[]; visionAlt: boolean; providers: Record<string, Prov> };

export default function Settings({ me, dudaApi }: { me: Me; dudaApi: boolean }) {
  const isAdmin = me.role !== "member", isSuper = me.role === "super_admin";
  const [tab, setTab] = useState(isSuper ? "security" : isAdmin ? "members" : "duda");
  return (
    <div className="stack">
      <h1>Settings</h1>
      <div className="card">
        <div className="tabs">
          {isSuper && <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>Security</button>}
          {isSuper && <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI providers</button>}
          {isAdmin && <button className={tab === "research" ? "active" : ""} onClick={() => setTab("research")}>Research</button>}
          {isAdmin && <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>Members</button>}
          <button className={tab === "duda" ? "active" : ""} onClick={() => setTab("duda")}>Duda API</button>
          {isSuper && <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>Security log</button>}
        </div>
        {tab === "ai" && isSuper && <AiSettings />}
        {tab === "research" && isAdmin && <ResearchSettings canEdit={isSuper} />}
        {tab === "members" && isAdmin && <Members me={me} />}
        {tab === "duda" && <DudaInfo enabled={dudaApi} />}
        {tab === "security" && isSuper && <SecuritySettings />}
        {tab === "log" && isSuper && <SecurityLog />}
      </div>
    </div>
  );
}

function AiSettings() {
  const [ai, setAi] = useState<Ai | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [err, setErr] = useState("");
  useEffect(() => { api<Ai>("/api/settings/ai").then(setAi).catch((e) => setErr(e.message)); }, []);
  if (!ai) return <p className="muted">{err || "Loading…"}</p>;

  const save = async (patch: Record<string, unknown>) => {
    try { setAi(await api<Ai>("/api/settings/ai", { method: "PUT", body: patch })); setErr(""); } catch (e) { setErr((e as Error).message); }
  };
  const setP = (id: string, p: Partial<Prov> & { apiKey?: string; clearKey?: boolean }) => save({ providers: { [id]: p } });
  const move = (id: string, dir: -1 | 1) => {
    const o = [...ai.order]; const i = o.indexOf(id); const j = i + dir;
    if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; save({ order: o });
  };
  const test = async (id: string) => {
    setMsg((m) => ({ ...m, [id]: "Testing…" }));
    try { const r = await api<{ ms: number; model: string }>("/api/settings/ai/test", { body: { provider: id } }); setMsg((m) => ({ ...m, [id]: `✓ Works — ${r.model} answered in ${r.ms} ms` })); }
    catch (e) { setMsg((m) => ({ ...m, [id]: "✗ " + (e as Error).message })); }
  };
  const loadModels = async (id: string) => {
    try { const r = await api<{ models: string[] }>(`/api/settings/ai/models?provider=${id}`); setModels((m) => ({ ...m, [id]: r.models })); }
    catch (e) { setMsg((m) => ({ ...m, [id]: "✗ " + (e as Error).message })); }
  };

  return (
    <div className="stack">
      <p className="muted">Free AI fills and reviews Data Collection, body copy and alt text. Providers are used top to bottom: when one hits its free limit it rests automatically and the next one takes over, so a job never stops halfway. Keys are encrypted in the database; Vercel env vars (CEREBRAS_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, OPENROUTER_API_KEY) work too.</p>
      {err && <div className="alert error">{err}</div>}
      <label className="row"><input type="checkbox" checked={ai.visionAlt} onChange={(e) => save({ visionAlt: e.target.checked })} /> Let Gemini look at the actual images when checking alt text</label>
      <p className="muted small" style={{ marginTop: -6 }}>Only Gemini can see pictures. When Gemini is off, has no key or is resting, alt text is still checked by the other AIs using the file name, the alt text and the words around the image.</p>
      {ai.order.map((id, i) => {
        const p = ai.providers[id];
        return (
          <div key={id} className="card" style={{ boxShadow: "none" }}>
            <div className="row between">
              <div className="row">
                <b>{i + 1}. {p.label}</b>
                {p.hasKey ? <span className="badge ok">key {p.keySource === "env" ? "from env" : "saved"} · {p.keyHint}</span> : <span className="badge">no key</span>}
                {p.coolingUntil && <span className="badge warning" title="Hit its free limit — skipped until then">resting until {new Date(p.coolingUntil).toLocaleTimeString()}</span>}
                <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={p.enabled} onChange={(e) => setP(id, { enabled: e.target.checked })} /> enabled</label>
              </div>
              <div className="row">
                <button className="sm" onClick={() => move(id, -1)} disabled={i === 0}>↑</button>
                <button className="sm" onClick={() => move(id, 1)} disabled={i === ai.order.length - 1}>↓</button>
              </div>
            </div>
            <div className="muted small" style={{ margin: "4px 0 10px" }}>{p.note} {p.signup && <a href={p.signup} target="_blank" rel="noreferrer">Get a free key ↗</a>}</div>
            <div className="grid2">
              <label className="field"><span>API key</span>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input type="password" autoComplete="off" placeholder={p.hasKey ? "•••••• (leave blank to keep)" : "Paste key"} value={keys[id] || ""} onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} />
                  <button className="sm" disabled={!keys[id]} onClick={async () => { await setP(id, { apiKey: keys[id] }); setKeys({ ...keys, [id]: "" }); }}>Save</button>
                  {p.keySource === "settings" && <button className="sm ghost" onClick={() => setP(id, { clearKey: true })}>Remove</button>}
                </div>
              </label>
              <label className="field"><span>Model</span>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input list={`models-${id}`} defaultValue={p.model} placeholder={p.defaultModel} onBlur={(e) => e.target.value !== p.model && setP(id, { model: e.target.value })} />
                  <datalist id={`models-${id}`}>{(models[id] || []).map((m) => <option key={m} value={m} />)}</datalist>
                  <button className="sm" disabled={!p.hasKey} onClick={() => loadModels(id)} title="Load available models">List</button>
                </div>
              </label>
              {id === "cloudflare" && (
                <label className="field"><span>Cloudflare Account ID</span>
                  <input defaultValue={p.accountId === "(from env)" ? "" : p.accountId} placeholder={p.accountId === "(from env)" ? "Using CLOUDFLARE_ACCOUNT_ID from env" : "32-character Account ID"} onBlur={(e) => e.target.value && e.target.value !== p.accountId && setP(id, { accountId: e.target.value } as Partial<Prov>)} />
                </label>
              )}
              {id === "custom" && (
                <label className="field"><span>Base URL (OpenAI-compatible)</span>
                  <input defaultValue={p.baseUrl} placeholder="https://api.cerebras.ai/v1" onBlur={(e) => e.target.value !== p.baseUrl && setP(id, { baseUrl: e.target.value })} />
                </label>
              )}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="sm" disabled={!p.hasKey} onClick={() => test(id)}>Test connection</button>
              {msg[id] && <span className="small">{msg[id]}</span>}
              {models[id] && <span className="muted small">{models[id].length} models loaded — pick one in the Model box</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Members({ me }: { me: Me }) {
  const [list, setList] = useState<(Member & { created_at: string; mfa_enabled?: number; last_login_at?: string | null })[]>([]);
  const [f, setF] = useState({ name: "", email: "", password: "", role: "member" });
  const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const load = () => api<(Member & { created_at: string })[]>("/api/users").then(setList);
  useEffect(() => { load(); }, []);
  const isSuper = me.role === "super_admin";

  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setOk("");
    try { await api("/api/users", { body: f }); setOk(`Created ${f.email}. Share the temporary password privately — on first sign-in they must choose their own password and set up 2FA.`); setF({ name: "", email: "", password: "", role: "member" }); load(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function patch(id: number, b: Record<string, unknown>) {
    setErr(""); try { await api(`/api/users/${id}`, { method: "PATCH", body: b }); load(); } catch (e) { setErr((e as Error).message); }
  }
  // 18 chars from a 54-symbol alphabet ≈ 103 bits; the user must replace it on first sign-in anyway.
  const genPw = () => Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"[b % 54]).join("");

  return (
    <div className="stack">
      <form className="card stack" style={{ boxShadow: "none" }} onSubmit={add}>
        <h3>Add a member</h3>
        <div className="grid2">
          <label className="field"><span>Name</span><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Email</span><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field"><span>Temporary password</span>
            <div className="row" style={{ flexWrap: "nowrap" }}><input required minLength={12} autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><button type="button" className="sm" onClick={() => setF({ ...f, password: genPw() })}>Generate</button></div>
          </label>
          <label className="field"><span>Role</span>
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="member">Member — audit, assign, check off</option>
              {isSuper && <option value="admin">Admin — + manage members, delete sites</option>}
              {isSuper && <option value="super_admin">Super Admin — + AI keys & settings</option>}
            </select>
          </label>
        </div>
        <div><button className="primary">Add member</button></div>
        {err && <div className="alert error">{err}</div>}
        {ok && <div className="alert">{ok}</div>}
      </form>
      <table className="t">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
        <tbody>{list.map((u) => (
          <tr key={u.id} className={u.active ? "" : "done"}>
            <td>{u.name}{u.id === me.id && <span className="muted small"> (you)</span>}</td>
            <td className="small">{u.email}</td>
            <td>
              <select value={u.role} disabled={!isSuper || u.id === me.id} onChange={(e) => patch(u.id, { role: e.target.value })} style={{ width: 140 }}>
                <option value="member">Member</option><option value="admin">Admin</option><option value="super_admin">Super Admin</option>
              </select>
            </td>
            <td>{u.mfa_enabled ? <span className="badge ok">On</span> : <span className="badge warning">Off</span>}</td>
            <td className="small">{ago(u.last_login_at)}</td>
            <td>{u.active ? <span className="badge ok">Active</span> : <span className="badge">Deactivated</span>}</td>
            <td className="row">
              {u.id !== me.id && (isSuper || u.role === "member") && <>
                <button className="sm" onClick={() => patch(u.id, { active: !u.active })}>{u.active ? "Deactivate" : "Reactivate"}</button>
                <button className="sm" onClick={() => { const pw = genPw(); if (confirm(`Reset ${u.name}'s password? They'll be signed out and must choose a new one.`)) patch(u.id, { password: pw }).then(() => setOk(`Temporary password for ${u.email}: ${pw} — share it privately; they must change it on sign-in.`)); }}>Reset password</button>
                <button className="sm" onClick={() => patch(u.id, { unlock: true }).then(() => setOk(`${u.email} unlocked.`))}>Unlock</button>
                {isSuper && !!u.mfa_enabled && <button className="sm danger" onClick={() => { if (confirm(`Reset ${u.name}'s two-factor login? Use this only if they lost their phone and recovery codes.`)) patch(u.id, { resetMfa: true }); }}>Reset 2FA</button>}
              </>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function DudaInfo({ enabled }: { enabled: boolean }) {
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className={`alert ${enabled ? "" : "warning"}`}>
        Duda API is <b>{enabled ? "connected" : "not configured"}</b>.
      </div>
      <p>Audits always work from the <b>preview link</b> alone — the API is optional. If the client later shares API access, add these in <b>Vercel → Project → Settings → Environment Variables</b> and redeploy:</p>
      <pre className="log">{`DUDA_API_USERNAME=…\nDUDA_API_PASSWORD=…`}</pre>
      <p className="muted small">When set, each site&apos;s Jira facts tab gets a “Compare with Duda Business Info” button that pulls the site&apos;s Business Info (content library) and highlights anything that differs from Jira. Credentials are never stored in the database or shown in the UI.</p>
    </div>
  );
}

type Policy = { mfaRequired: "all" | "admins" | "off"; sessionIdleHours: number; sessionMaxDays: number; crawlHosts: string[] };

function SecuritySettings() {
  const [p, setP] = useState<Policy | null>(null);
  const [hosts, setHosts] = useState("");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { api<Policy>("/api/settings/security").then((x) => { setP(x); setHosts(x.crawlHosts.join("\n")); }).catch((e) => setErr(e.message)); }, []);
  if (!p) return <p className="muted">{err || "Loading…"}</p>;
  const save = async () => {
    setMsg(""); setErr("");
    try {
      const x = await api<Policy>("/api/settings/security", { method: "PUT", body: { ...p, crawlHosts: hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean) } });
      setP(x); setHosts(x.crawlHosts.join("\n")); setMsg("Saved.");
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <label className="field"><span>Require two-factor login for</span>
        <select value={p.mfaRequired} onChange={(e) => setP({ ...p, mfaRequired: e.target.value as Policy["mfaRequired"] })}>
          <option value="all">Everyone (recommended)</option><option value="admins">Admins and Super Admins only</option><option value="off">Nobody (not recommended)</option>
        </select>
      </label>
      <div className="grid2">
        <label className="field"><span>Sign out after inactivity (hours)</span><input type="number" min={1} max={24} value={p.sessionIdleHours} onChange={(e) => setP({ ...p, sessionIdleHours: Number(e.target.value) })} /></label>
        <label className="field"><span>Always sign out after (days)</span><input type="number" min={1} max={30} value={p.sessionMaxDays} onChange={(e) => setP({ ...p, sessionMaxDays: Number(e.target.value) })} /></label>
      </div>
      <label className="field"><span>Domains the crawler may open (one per line)</span>
        <textarea rows={7} value={hosts} onChange={(e) => setHosts(e.target.value)} className="mono" />
      </label>
      <p className="muted small">Use <code>*.example.com</code> for a domain and all its subdomains. Add a client&apos;s live domain here if you want to audit it after publishing. The crawler can never reach private/internal network addresses, whatever is listed.</p>
      <div><button className="primary" onClick={save}>Save security settings</button></div>
      {msg && <div className="alert">{msg}</div>}{err && <div className="alert error">{err}</div>}
    </div>
  );
}

type Ev = { id: number; at: string; event: string; ip: string; detail: string | null; user_name: string | null; user_email: string | null };
const BAD = /bad|locked|unknown|inactive|reset|disabled|deactivated|blocked/;

function SecurityLog() {
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { api<Ev[]>("/api/settings/security-log").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">Loading…</p>;
  const shown = rows.filter((r) => !q || [r.event, r.ip, r.user_email, r.detail].join(" ").toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <div className="row"><input style={{ maxWidth: 280 }} placeholder="Filter (event, email, IP)…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="muted small">Last 300 events · kept 90 days</span></div>
      <div style={{ overflowX: "auto" }}>
        <table className="t">
          <thead><tr><th>When</th><th>Event</th><th>User</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id}>
              <td className="small">{new Date(r.at.replace(" ", "T") + "Z").toLocaleString()}</td>
              <td><span className={`badge ${BAD.test(r.event) ? "warning" : ""}`}>{r.event}</span></td>
              <td className="small">{r.user_name || "—"}<div className="muted">{r.user_email}</div></td>
              <td className="small mono">{r.ip}</td>
              <td className="small mono" style={{ maxWidth: 320, wordBreak: "break-all" }}>{r.detail}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

type SProv = { enabled: boolean; hasKey: boolean; keyHint: string; keySource: string; usedThisMonth: number; label: string; signup: string; note: string; maps: boolean; web: boolean };
type Rules = { defaultAmenities: number; defaultServices: number; rules: { match: string; amenities: number }[] };

function ResearchSettings({ canEdit }: { canEdit: boolean }) {
  const [d, setD] = useState<{ search: { order: string[]; aiFirst: boolean; providers: Record<string, SProv> }; templates: Rules } | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, string>>({});
  const [rulesText, setRulesText] = useState("");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const apply = (x: NonNullable<typeof d>) => { setD(x); setRulesText(x.templates.rules.map((r) => `${r.match} = ${r.amenities}`).join("\n")); };
  useEffect(() => { api<NonNullable<typeof d>>("/api/settings/research").then(apply).catch((e) => setErr(e.message)); }, []);
  if (!d) return <p className="muted">{err || "Loading…"}</p>;
  const save = async (body: Record<string, unknown>) => {
    setErr(""); setMsg("");
    try { apply(await api("/api/settings/research", { method: "PUT", body })); setMsg("Saved."); } catch (e) { setErr((e as Error).message); }
  };
  const saveRules = () => {
    const rules = rulesText.split("\n").map((l) => l.match(/^(.+?)\s*[=:]\s*(\d+)\s*$/)).filter(Boolean).map((m) => ({ match: m![1].trim(), amenities: Number(m![2]) }));
    save({ templates: { ...d.templates, rules } });
  };
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h3 style={{ margin: 0 }}>Search keys (free, no credit card)</h3>
      <p className="muted small">Used by Data Collection to find the Google Business Profile (Place ID + CID), social accounts, listings and coupons. All free with no credit card. The GBP is first looked for on the shop&apos;s own website (map embed / review links — costs nothing); a Maps search is only used when that fails. Providers are tried top to bottom; one that runs out of free searches rests and the next is used. Results are cached per project, so re-running doesn&apos;t spend credits twice.</p>
      <label className="row small"><input type="checkbox" disabled={!canEdit} checked={d.search.aiFirst} onChange={(e) => save({ search: { aiFirst: e.target.checked } })} /> Use Groq AI search first for web &amp; social searches (saves the search credits for Maps; anything it finds is marked &quot;Review&quot;)</label>
      {d.search.order.map((id, idx) => {
        const p = d.search.providers[id];
        const move = (dir: number) => { const o = [...d.search.order]; const j = idx + dir; if (j < 0 || j >= o.length) return; [o[idx], o[j]] = [o[j], o[idx]]; save({ search: { order: o } }); };
        return (
          <div key={id} className="card" style={{ boxShadow: "none" }}>
            <div className="row between">
              <div className="row"><b>{idx + 1}. {p.label}</b><span className={`badge ${p.maps ? "accent" : ""}`}>{p.maps && p.web ? "Maps + web" : p.maps ? "Maps" : "Web"}</span>
                {p.hasKey ? <span className="badge ok">key {p.keySource === "env" ? "from env" : "saved"} · {p.keyHint}</span> : <span className="badge">no key</span>}
                <span className="muted small">{p.usedThisMonth} used this month</span></div>
              {canEdit && <div className="row small" style={{ gap: 6 }}>
                <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={p.enabled} onChange={(e) => save({ search: { providers: { [id]: { enabled: e.target.checked } } } })} /> enabled</label>
                <button className="sm" disabled={idx === 0} onClick={() => move(-1)} aria-label="Move up">↑</button>
                <button className="sm" disabled={idx === d.search.order.length - 1} onClick={() => move(1)} aria-label="Move down">↓</button>
              </div>}
            </div>
            <div className="muted small" style={{ margin: "4px 0 8px" }}>{p.note} <a href={p.signup} target="_blank" rel="noreferrer">Get a free key ↗</a></div>
            {canEdit && (
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input type="password" autoComplete="off" placeholder={p.hasKey ? "•••••• (leave blank to keep)" : "Paste API key"} value={keys[id] || ""} onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} />
                <button className="sm" disabled={!keys[id]} onClick={async () => { await save({ search: { providers: { [id]: { apiKey: keys[id] } } } }); setKeys({ ...keys, [id]: "" }); }}>Save</button>
                {p.keySource === "settings" && <button className="sm ghost" onClick={() => save({ search: { providers: { [id]: { clearKey: true } } } })}>Remove</button>}
                <button className="sm" disabled={!p.hasKey || tests[id] === "Testing…"} title="Runs one real search (uses 1 free credit)" onClick={async () => {
                  setTests((t) => ({ ...t, [id]: "Testing…" }));
                  try { const r = await api<{ ok: boolean; message: string }>("/api/settings/research/test", { body: { id } }); setTests((t) => ({ ...t, [id]: `${r.ok ? "✓" : "✕"} ${r.message}` })); }
                  catch (e) { setTests((t) => ({ ...t, [id]: `✕ ${(e as Error).message}` })); }
                }}>Test</button>
              </div>
            )}
            {tests[id] && <div className="small" style={{ marginTop: 6 }}>{tests[id]}</div>}
          </div>
        );
      })}
      <h3 style={{ margin: "12px 0 0" }}>Template requirements</h3>
      <p className="muted small">How many Benefits/Amenities each template needs. One rule per line: <code>Single Location Template 31 = 16</code>. Anything not listed uses the default.</p>
      <div className="row">
        <label className="field" style={{ width: 180 }}><span>Default amenities</span><input type="number" min={0} max={40} defaultValue={d.templates.defaultAmenities} disabled={!canEdit} onBlur={(e) => canEdit && save({ templates: { ...d.templates, defaultAmenities: Number(e.target.value) } })} /></label>
        <label className="field" style={{ width: 180 }}><span>Minimum services</span><input type="number" min={0} max={40} defaultValue={d.templates.defaultServices} disabled={!canEdit} onBlur={(e) => canEdit && save({ templates: { ...d.templates, defaultServices: Number(e.target.value) } })} /></label>
      </div>
      <textarea rows={6} className="mono" value={rulesText} disabled={!canEdit} onChange={(e) => setRulesText(e.target.value)} placeholder={"Single Location Template 31 = 16\nHP Only Template 5 = 8"} />
      {canEdit && <div><button className="primary" onClick={saveRules}>Save template rules</button></div>}
      {msg && <div className="alert">{msg}</div>}{err && <div className="alert error">{err}</div>}
    </div>
  );
}
