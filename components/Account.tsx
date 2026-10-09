"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ago } from "./api";

type Me = { id: number; name: string; email: string; role: string; mfa_enabled: number; needsMfa: boolean; mfaRequired: boolean; mustChangePassword: boolean };
type Sess = { ref: string; created_at: string; last_seen: string; ip: string; user_agent: string; current: boolean };

export default function Account({ me: initial }: { me: Me }) {
  const [me, setMe] = useState(initial);
  const refresh = useCallback(async () => {
    const u = await api<Me & { must_change_password: number }>("/api/me");
    setMe({ ...u, mustChangePassword: !!u.must_change_password });
  }, []);
  const ready = !me.mustChangePassword && !me.needsMfa;

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>My account</h1>
      <div className="muted small">{me.email} · {me.role.replace("_", " ")}</div>
      {!ready && (
        <div className="alert warning">
          <b>Finish securing your account to continue:</b>
          <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {me.mustChangePassword && <li>Choose your own password (replace the temporary one).</li>}
            {me.needsMfa && <li>Turn on two-factor login with an authenticator app.</li>}
          </ol>
        </div>
      )}
      {ready && (initial.needsMfa || initial.mustChangePassword) && <div className="alert">All set — your account is secured. <a href="/">Go to Sites →</a></div>}
      <PasswordCard must={me.mustChangePassword} onDone={refresh} />
      <MfaCard enabled={!!me.mfa_enabled} required={me.mfaRequired} onDone={refresh} />
      <SessionsCard />
    </div>
  );
}

function PasswordCard({ must, onDone }: { must: boolean; onDone: () => void }) {
  const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(""); setErr("");
    if (f.newPassword !== f.confirm) return setErr("New passwords don't match");
    try {
      await api("/api/me/password", { body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
      setF({ currentPassword: "", newPassword: "", confirm: "" });
      setMsg("Password changed. Other devices were signed out."); onDone();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>{must ? "Choose your password" : "Change password"}</h2>
      <label className="field"><span>{must ? "Temporary password" : "Current password"}</span><input type="password" required autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></label>
      <div className="grid2">
        <label className="field"><span>New password</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></label>
        <label className="field"><span>Repeat new password</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></label>
      </div>
      <p className="muted small">At least 12 characters. A passphrase of 4+ random words is strong and easy to remember. Use a password manager if you can.</p>
      <div><button className="primary">Save password</button></div>
      {msg && <div className="alert">{msg}</div>}{err && <div className="alert error">{err}</div>}
    </form>
  );
}

function MfaCard({ enabled, required, onDone }: { enabled: boolean; required: boolean; onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState({ password: "", code: "" });
  const [err, setErr] = useState("");

  const start = async () => { setErr(""); try { setSetup(await api("/api/me/mfa", { body: {} })); } catch (e) { setErr((e as Error).message); } };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { const r = await api<{ recoveryCodes: string[] }>("/api/me/mfa", { method: "PUT", body: { code } }); setCodes(r.recoveryCodes); setSetup(null); setCode(""); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  const disable = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { await api("/api/me/mfa", { method: "DELETE", body: off }); setOff({ password: "", code: "" }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  const download = () => {
    const blob = new Blob([`${document.title || "Tek Website Monitoring"} — recovery codes\nEach code works once.\n\n${codes!.join("\n")}\n`], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "duda-audit-recovery-codes.txt"; a.click();
  };

  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Two-factor login</h2>
        {enabled ? <span className="badge ok">On</span> : <span className={`badge ${required ? "error" : ""}`}>{required ? "Required" : "Off"}</span>}
      </div>
      {codes && (
        <div className="alert warning stack">
          <b>Save these recovery codes now — they won&apos;t be shown again.</b>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 4 }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <div className="row"><button type="button" className="sm" onClick={download}>Download .txt</button><button type="button" className="sm" onClick={() => navigator.clipboard.writeText(codes.join("\n"))}>Copy</button><button type="button" className="sm" onClick={() => setCodes(null)}>I saved them</button></div>
        </div>
      )}
      {!enabled && !setup && (
        <>
          <p className="muted">Protects your account even if your password leaks. Use Google Authenticator, Microsoft Authenticator, Authy or 1Password (all free).</p>
          <div><button className="primary" onClick={start}>Set up two-factor login</button></div>
        </>
      )}
      {setup && (
        <form className="stack" onSubmit={confirm}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: "#fff", borderRadius: 8, padding: 6 }} />
            <div className="stack" style={{ flex: 1, minWidth: 220 }}>
              <div>1. Scan the QR code with your authenticator app.</div>
              <div className="small muted">Can&apos;t scan? Enter this key manually: <code style={{ wordBreak: "break-all" }}>{setup.secret}</code></div>
              <label className="field"><span>2. Enter the 6-digit code it shows</span>
                <input required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              </label>
              <div><button className="primary">Turn on</button></div>
            </div>
          </div>
        </form>
      )}
      {enabled && !required && (
        <details>
          <summary className="muted small">Turn off two-factor login</summary>
          <form className="row" style={{ marginTop: 8 }} onSubmit={disable}>
            <input type="password" placeholder="Password" required style={{ maxWidth: 200 }} value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} />
            <input placeholder="6-digit code" required inputMode="numeric" maxLength={6} style={{ maxWidth: 140 }} value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} />
            <button className="danger sm">Turn off</button>
          </form>
        </details>
      )}
      {enabled && required && <p className="muted small">Required by your team&apos;s security policy. Lost your phone? Sign in with a recovery code, or ask a Super Admin to reset it.</p>}
      {err && <div className="alert error">{err}</div>}
    </div>
  );
}

function SessionsCard() {
  const [list, setList] = useState<Sess[] | null>(null);
  const load = () => api<Sess[]>("/api/me/sessions").then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const revoke = async (ref?: string) => { await api("/api/me/sessions", { method: "DELETE", body: ref ? { ref } : {} }); load(); };
  return (
    <div className="card stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Signed-in devices</h2><button className="sm" onClick={() => revoke()}>Sign out all other devices</button></div>
      {!list ? <p className="muted">Loading…</p> : (
        <table className="t">
          <thead><tr><th>Device</th><th>IP</th><th>Last active</th><th></th></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.ref}>
              <td className="small">{describeUa(s.user_agent)} {s.current && <span className="badge ok">This device</span>}</td>
              <td className="small mono">{s.ip}</td>
              <td className="small">{ago(s.last_seen)}</td>
              <td>{!s.current && <button className="sm ghost" onClick={() => revoke(s.ref)}>Sign out</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function describeUa(ua: string) {
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const o = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${b}${o ? " on " + o : ""}`;
}
