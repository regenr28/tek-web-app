"use client";
import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { CREDIT } from "@/lib/credit";

type Step = "loading" | "setup" | "login" | "mfa";

export default function Login() {
  const [step, setStep] = useState<Step>("loading");
  const [missing, setMissing] = useState<string[]>([]);
  const [f, setF] = useState({ setupToken: "", name: "", email: "", password: "", code: "" });
  const [remember, setRemember] = useState(true);
  useEffect(() => { try { if (localStorage.getItem("keep-signed-in") === "0") setRemember(false); } catch { /* ignore */ } }, []);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ setupNeeded: boolean; missingConfig: string[] }>("/api/status")
      .then((s) => { setStep(s.setupNeeded ? "setup" : "login"); setMissing(s.missingConfig || []); })
      .catch((e) => { setErr(e.message); setStep("login"); });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      if (step === "setup") {
        await api("/api/auth/setup", { body: { setupToken: f.setupToken, name: f.name, email: f.email, password: f.password } });
        window.location.href = "/account";
        return;
      }
      if (step === "login") {
        try { localStorage.setItem("keep-signed-in", remember ? "1" : "0"); } catch { /* ignore */ }
        const r = await api<{ mfa?: boolean }>("/api/auth/login", { body: { email: f.email, password: f.password, remember } });
        setF((x) => ({ ...x, password: "" }));
        if (r.mfa) { setStep("mfa"); setBusy(false); return; }
      }
      if (step === "mfa") await api("/api/auth/mfa", { body: { code: f.code } });
      window.location.href = "/";
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit} autoComplete="on">
        <div className="brand"><span className="brand-dot" /> Duda Preview Audit</div>
        {step === "loading" && <p className="muted">Loading…</p>}

        {step === "setup" && (
          <>
            <h1>Create the Super Admin</h1>
            {missing.length > 0 ? (
              <div className="alert error">
                Add these in Vercel → Settings → Environment Variables, then redeploy:
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
              </div>
            ) : <p className="muted small">First run. Enter the <code>SETUP_TOKEN</code> from your Vercel environment variables — this proves you own the deployment.</p>}
            <label className="field"><span>Setup token</span><input type="password" required autoComplete="off" value={f.setupToken} onChange={(e) => setF({ ...f, setupToken: e.target.value })} /></label>
            <label className="field"><span>Your name</span><input required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          </>
        )}

        {(step === "setup" || step === "login") && (
          <>
            {step === "login" && <h1>Sign in</h1>}
            <label className="field"><span>Email</span><input type="email" required autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label className="field"><span>Password</span>
              <input type="password" required minLength={step === "setup" ? 12 : 1} maxLength={128} autoComplete={step === "setup" ? "new-password" : "current-password"} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </label>
            {step === "login" && (
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Keep me signed in for 30 days on this device <span className="muted">(not on shared computers)</span>
              </label>
            )}
            {step === "setup" && <p className="muted small">12+ characters. A long passphrase is best. You&apos;ll set up two-factor login next.</p>}
          </>
        )}

        {step === "mfa" && (
          <>
            <h1>Two-factor code</h1>
            <p className="muted small">Open your authenticator app and enter the 6-digit code. Lost your phone? Enter one of your recovery codes instead.</p>
            <label className="field"><span>Code</span>
              <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={11} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="123456" />
            </label>
          </>
        )}

        {err && <div className="alert error" role="alert">{err}</div>}
        {step !== "loading" && (
          <button className="primary" disabled={busy || (step === "setup" && missing.length > 0)}>
            {busy ? "…" : step === "setup" ? "Create account" : step === "mfa" ? "Verify" : "Sign in"}
          </button>
        )}
        {step === "mfa" && <button type="button" className="ghost small" onClick={() => { setStep("login"); setErr(""); }}>Use a different account</button>}
        <div className="muted small app-credit" style={{ textAlign: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>{CREDIT}</div>
      </form>
    </div>
  );
}
