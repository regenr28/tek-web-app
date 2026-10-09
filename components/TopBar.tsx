"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "./api";

export default function TopBar({ me, appName, limited, projects = true, websites = true }: { me: { name: string; role: string }; appName: string; limited?: boolean; projects?: boolean; websites?: boolean }) {
  const path = usePathname();
  // unread "What changed" alerts — shown as a badge on All Websites
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (limited || !websites) return;
    const get = () => api<{ unread: number }>("/api/websites/alerts?count=1").then((r) => setUnread(r.unread)).catch(() => {});
    get();
    window.addEventListener("alerts-seen", get);
    return () => window.removeEventListener("alerts-seen", get);
  }, [limited, websites, path]);
  const logout = async () => { await api("/api/auth/logout", { body: {} }).catch(() => {}); window.location.href = "/login"; };
  return (
    <header className="topbar">
      <Link href={projects ? "/" : "/websites"} className="brand"><span className="brand-dot" /> <span>{appName}</span></Link>
      <nav>
        {!limited && projects && <Link href="/" className={path === "/" ? "active" : ""}>Projects</Link>}
        {!limited && websites && <Link href="/websites" className={path.startsWith("/websites") ? "active" : ""}>All Websites{unread > 0 && <span className="badge error" style={{ marginLeft: 6 }} title={`${unread} new alert(s)`}>{unread}</span>}</Link>}
        {!limited && <Link href="/settings" className={path.startsWith("/settings") ? "active" : ""}>Settings</Link>}
        <Link href="/account" className={path.startsWith("/account") ? "active" : ""}>My account</Link>
      </nav>
      <span className="muted small hide-sm">{me.name}</span>
      <button className="sm" onClick={logout}>Sign out</button>
    </header>
  );
}
