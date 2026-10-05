"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "./api";

export default function TopBar({ me, limited }: { me: { name: string; role: string }; limited?: boolean }) {
  const path = usePathname();
  const logout = async () => { await api("/api/auth/logout", { body: {} }).catch(() => {}); window.location.href = "/login"; };
  return (
    <header className="topbar">
      <Link href="/" className="brand"><span className="brand-dot" /> <span>Duda Preview Audit</span></Link>
      <nav>
        {!limited && <Link href="/" className={path === "/" ? "active" : ""}>Projects</Link>}
        {!limited && <Link href="/settings" className={path.startsWith("/settings") ? "active" : ""}>Settings</Link>}
        <Link href="/account" className={path.startsWith("/account") ? "active" : ""}>My account</Link>
      </nav>
      <span className="muted small hide-sm">{me.name} · {me.role.replace("_", " ")}</span>
      <button className="sm" onClick={logout}>Sign out</button>
    </header>
  );
}
