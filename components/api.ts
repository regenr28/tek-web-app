"use client";
export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const r = await fetch(url, {
    credentials: "same-origin",
    method: opts.method || (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.form ? undefined : { "Content-Type": "application/json" },
    body: opts.form ? opts.form : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (typeof window !== "undefined" && !url.includes("/auth/")) {
    if (r.status === 401) window.location.href = "/login";
    if (r.status === 403 && (j as { code?: string }).code === "setup_required") window.location.href = "/account";
  }
  if (!r.ok) throw new Error((j as { error?: string }).error || `Request failed (${r.status})`);
  return j as T;
}
export type Member = { id: number; name: string; email: string; role: string; active: number; access?: string; can_history?: number };
export const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started", in_progress: "In progress", needs_fixes: "Needs fixes", fixed: "Fixed – recheck", passed: "Passed QA", published: "Published",
};
export const STATUS_TONE: Record<string, string> = { not_started: "", in_progress: "accent", needs_fixes: "error", fixed: "warning", passed: "ok", published: "ok" };
export function ago(ts?: string | null) {
  if (!ts) return "—";
  const d = new Date(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z"));
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString();
}
