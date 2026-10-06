"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ago } from "./api";

type Status = "ok" | "review" | "missing";
type CField = { value: string; note: string; source: string; status: Status; manual?: boolean };
type Loc = { city: string; state: string; tekmetricId: string; fields: Record<string, CField> };
type Collection = { fields: Record<string, CField>; locations: Loc[]; pages: string[]; minServices: number; minAmenities: number; research: Record<string, { at: string; ok: boolean; summary: string }> };
type Project = { key: string; url: string; typeLabel: string; type: string | null; template: string; templateNumber: string; pages: string[]; previewUrl: string; tekmetricId: string; created: string; activity: { type: string; author: string; date: string; details: string }[] };
type GbpEv = { provider: string; title?: string; address?: string; rating?: number | null; reviews?: number | null; hours?: Record<string, string>; at: string };
type Mark = "ok" | "legal" | "minor" | "diff" | undefined;
type CrossCheckEv = { at: string; issues: string[]; rows: { source: string; url: string; name: string; phone: string; address: string; website: string; read: string; marks: { name?: Mark; phone?: Mark; address?: Mark; website?: Mark } }[] };
type Data = {
  collection: Collection; labels: { key: string; label: string }[]; locLabels: { key: string; label: string }[];
  tsv: string; text: string; rows: string[][]; project: Project | null;
  editorUrl: string | null; previewUrl: string; steps: { id: string; label: string }[];
  evidence: {
    gbp: GbpEv | null; gbpLocs: (GbpEv | null)[];
    website: { url: string; pages: { url: string; title: string }[]; signals: Record<string, unknown>; at: string } | null;
    search: { provider: string; queries: string[]; results: { title: string; url: string }[]; at: string } | null;
    crosscheck: CrossCheckEv | null;
  };
  available: { web: boolean; maps: boolean; ai: boolean };
};
type Saved = { collection: Collection; tsv: string; text: string; rows: string[][] };

const SOURCE_LABEL: Record<string, string> = { jira: "Jira", gbp: "GBP", website: "Website", search: "Search", ai: "AI", rule: "Rule", manual: "You" };
const LIST_FIELDS = new Set(["services", "amenities", "certifications", "socials", "hours", "coupons", "about", "faq", "specialNotes", "warranties", "financing"]);

export default function DataCollection({ siteId, onChanged }: { siteId: number; onChanged: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [running, setRunning] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState("");
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [view, setView] = useState<"form" | "sheet">("form");
  const stop = useRef(false);

  const load = useCallback(() => api<Data>(`/api/sites/${siteId}/collection`).then(setD).catch((e) => setErr(e.message)), [siteId]);
  useEffect(() => { load(); try { const v = localStorage.getItem("dc-view"); if (v === "sheet" || v === "form") setView(v); } catch { /* ignore */ } }, [load]);
  const pickView = (v: "form" | "sheet") => { setView(v); try { localStorage.setItem("dc-view", v); } catch { /* ignore */ } };

  const merge = (r: Saved) => setD((x) => (x ? { ...x, collection: r.collection, tsv: r.tsv, text: r.text, rows: r.rows } : x));
  async function put(body: Record<string, unknown>, reload = false) {
    try { merge(await api<Saved>(`/api/sites/${siteId}/collection`, { method: "PUT", body })); if (reload) { load(); onChanged(); } }
    catch (e) { setErr((e as Error).message); }
  }
  const saveField = (key: string, patch: Partial<CField>) => put({ fields: { [key]: patch } }, key === "editorUrl");
  const saveLoc = (index: number, key: string, patch: Partial<CField>) => put({ locations: [{ index, fields: { [key]: patch } }] });
  const savePages = (text: string) => put({ pages: text.split("\n").map((x) => x.trim()).filter(Boolean) });

  async function runSteps(ids: string[]) {
    stop.current = false; setLog([]); setErr("");
    for (const id of ids) {
      if (stop.current) break;
      const label = d?.steps.find((x) => x.id === id)?.label || id;
      setRunning(label);
      try {
        const r = await api<Saved & { ok: boolean; summary: string }>(`/api/sites/${siteId}/collection/run`, { body: { step: id } });
        merge(r);
        setLog((l) => [...l, `${r.ok ? "✓" : "⚠"} ${label}: ${r.summary}`]);
      } catch (e) { setLog((l) => [...l, `⚠ ${label}: ${(e as Error).message}`]); }
    }
    setRunning(""); load(); onChanged();
  }

  const copy = async (text: string, what: string) => { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1500); };

  if (!d) return <p className="muted">{err || "Loading…"}</p>;
  const c = d.collection;
  const mso = c.locations.length > 0;
  const review = d.labels.filter((l) => c.fields[l.key]?.status !== "ok");
  const locReview = c.locations.reduce((n, L) => n + d.locLabels.filter((l) => L.fields[l.key]?.status !== "ok").length, 0);
  const shown = filter === "review" ? review : d.labels;
  const beforeLoc = shown.filter((l) => ["shopName", "cityState"].includes(l.key));
  const afterLoc = shown.filter((l) => !["shopName", "cityState"].includes(l.key));

  const row = (l: { key: string; label: string }, f: CField, onSave: (p: Partial<CField>) => void, copyKey: string, label?: string) => (
    <tr key={copyKey} className={`dc-${f.status}`}>
      <td>
        <b className="small">{label || l.label}</b>
        <div className="row" style={{ gap: 4, marginTop: 4 }}>
          <StatusBadge s={f.status} onClick={() => onSave({ status: f.status === "ok" ? "review" : "ok" })} />
          {f.source && <span className="badge">{SOURCE_LABEL[f.source] || f.source}</span>}
        </div>
      </td>
      <td><AutoText value={f.value} rows={LIST_FIELDS.has(l.key) ? 3 : 1} onSave={(v) => onSave({ value: v })} mono={l.key === "placeId"} /></td>
      <td><AutoText value={f.note} rows={1} small onSave={(v) => onSave({ note: v })} placeholder="—" /></td>
      <td><button className="sm ghost" onClick={() => copy(f.value, copyKey)}>{copied === copyKey ? "✓" : "Copy"}</button></td>
    </tr>
  );
  const head = <thead><tr><th style={{ width: 200 }}>Field</th><th>Value</th><th style={{ width: "30%" }}>Note</th><th style={{ width: 70 }}></th></tr></thead>;

  return (
    <div className="stack">
      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}

      {d.project ? <ProjectCard p={d.project} editorUrl={c.fields.editorUrl?.value || ""} previewUrl={d.previewUrl} onEditor={(v) => saveField("editorUrl", { value: v })} copy={copy} copied={copied} />
        : <div className="alert warning">This project wasn&apos;t created from a Jira export. Use <b>+ Add Project</b> on the Projects page with the Jira .xlsx to get the automatic Data Collection.</div>}

      {/* Research */}
      <div className="card stack" style={{ boxShadow: "none", background: "var(--panel-2)" }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>Research</h3>
            <div className="muted small">Finds the GBP{mso ? " of every location" : ""}, reads their website, searches socials and listings, then free AI fills the gaps and double-checks everything. Jira always wins; anything found elsewhere gets a note.</div>
          </div>
          {running ? <button onClick={() => { stop.current = true; }}>Stop after this step</button>
            : <button className="primary" disabled={!d.project} onClick={() => runSteps(d.steps.map((x) => x.id))}>Run all research</button>}
        </div>
        {(!d.available.maps || !d.available.web || !d.available.ai) && (
          <div className="small alert warning">
            {!d.available.maps && <div>• No Maps search key — the GBP step will look for the shop&apos;s map / review link on their website (free). For shops whose website has none, add a free <b>OpenWeb Ninja</b>, <b>SerpApi</b> or <b>Apify</b> key in Settings → Research.</div>}
            {!d.available.web && <div>• No web search key — social/listing search uses Groq AI search only. A free Tavily, Linkup or Exa key adds a backup when Groq hits its daily limit.</div>}
            {!d.available.ai && <div>• No AI key — add Cerebras, Mistral, Groq or Cloudflare keys in Settings → AI providers.</div>}
          </div>
        )}
        <div className="row small" style={{ gap: 6 }}>
          {d.steps.map((x) => {
            const r = c.research[x.id];
            return (
              <button key={x.id} className="sm" disabled={!!running || !d.project} onClick={() => runSteps([x.id])} title={r ? `${r.summary} (${ago(r.at)})` : "Not run yet"}>
                {r ? (r.ok ? "✓" : "⚠") : "○"} {x.label}
              </button>
            );
          })}
        </div>
        {(running || log.length > 0) && <div className="log">{log.join("\n")}{running && `\n… ${running}`}</div>}
      </div>

      {/* Two ways to use it */}
      <div className="row between">
        <div className="tabs" style={{ margin: 0, border: "none" }}>
          <button className={view === "form" ? "active" : ""} onClick={() => pickView("form")}>Work here</button>
          <button className={view === "sheet" ? "active" : ""} onClick={() => pickView("sheet")}>Sheet layout (copy &amp; paste)</button>
        </div>
        <div className="row">
          <button className="primary sm" onClick={() => copy(d.tsv, "sheet")}>{copied === "sheet" ? "✓ Copied" : "Copy for Google Sheet"}</button>
          <button className="sm" onClick={() => copy(d.text, "text")}>{copied === "text" ? "✓ Copied" : "Copy as text"}</button>
        </div>
      </div>

      {view === "sheet" ? (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Exactly what “Copy for Google Sheet” pastes: click cell A1 of an empty block in your Data Collection tab and paste. Column A labels, B values, C notes, D requested pages. You can also highlight any cells here and copy them — the grey row numbers and column letters are never included.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="t sheet" onCopy={(e) => sheetCopy(e, d.rows)}>
              <thead className="noselect" aria-hidden="true"><tr><th style={{ width: 34 }}></th>{["A", "B", "C", "D"].map((x) => <th key={x} data-col={x} />)}</tr></thead>
              <tbody>{d.rows.map((r, i) => (
                <tr key={i}><td className="muted small noselect rownum" aria-hidden="true" />{[0, 1, 2, 3].map((j) => <td key={j} data-r={i} data-c={j} className={j === 0 ? "small" : j === 2 ? "small muted" : "small"} style={{ whiteSpace: "pre-wrap", fontWeight: j === 0 ? 600 : 400 }}>{r[j]}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            <div className="tabs" style={{ margin: 0, border: "none" }}>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All fields</button>
              <button className={filter === "review" ? "active" : ""} onClick={() => setFilter("review")}>Needs review ({review.length + locReview})</button>
            </div>
            <span className="spacer" />
            {!mso && <button className="sm" onClick={() => { if (confirm("Turn this into a multi-location (MSO) sheet? The current address/GBP/phone/hours become Location 1.")) put({ addLocation: true }); }}>+ Add a location (MSO)</button>}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="t dc">{head}<tbody>{beforeLoc.map((l) => row(l, c.fields[l.key], (p) => saveField(l.key, p), l.key))}</tbody></table>
          </div>

          {mso && (
            <div className="stack">
              {c.locations.map((L, i) => {
                const fl = filter === "review" ? d.locLabels.filter((l) => L.fields[l.key]?.status !== "ok") : d.locLabels;
                const g = d.evidence.gbpLocs?.[i];
                return (
                  <div key={i} className="card" style={{ boxShadow: "none", padding: 12 }}>
                    <div className="row between" style={{ marginBottom: 6 }}>
                      <div className="row">
                        <b>Location {i + 1}</b>
                        <input style={{ width: 160 }} defaultValue={L.city} placeholder="City" onBlur={(e) => e.target.value !== L.city && put({ locations: [{ index: i, city: e.target.value }] })} />
                        <input style={{ width: 56 }} defaultValue={L.state} placeholder="ST" maxLength={2} onBlur={(e) => e.target.value.toUpperCase() !== L.state && put({ locations: [{ index: i, state: e.target.value.toUpperCase() }] })} />
                        {L.tekmetricId && <span className="badge">Tekmetric ID {L.tekmetricId}</span>}
                        {g?.title && <span className="badge ok">GBP: {g.title}{g.rating != null ? ` · ${g.rating}★` : ""}</span>}
                      </div>
                      {c.locations.length > 1 && <button className="sm ghost danger" onClick={() => { if (confirm(`Remove location ${i + 1}?`)) put({ removeLocation: i }); }}>Remove</button>}
                    </div>
                    {fl.length ? (
                      <div style={{ overflowX: "auto" }}>
                        <table className="t dc">{head}<tbody>{fl.map((l) => row(l, L.fields[l.key], (p) => saveLoc(i, l.key, p), `l${i}-${l.key}`, `${l.label} ${i + 1}:`))}</tbody></table>
                      </div>
                    ) : <p className="muted small">Nothing to review here.</p>}
                  </div>
                );
              })}
              <div><button className="sm" onClick={() => put({ addLocation: true })}>+ Add location</button></div>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table className="t dc">{head}<tbody>{afterLoc.map((l) => row(l, c.fields[l.key], (p) => saveField(l.key, p), l.key))}</tbody></table>
          </div>
        </>
      )}

      {d.evidence.crosscheck && <CrossCheckCard x={d.evidence.crosscheck} />}

      <ReviewsCard f={c.fields.reviews} onSave={(p) => saveField("reviews", p)} copy={copy} copied={copied} />

      <div className="grid2">
        <div className="card stack" style={{ boxShadow: "none" }}>
          <h3 style={{ margin: 0 }}>Requested pages <span className="muted small">(column D)</span></h3>
          <AutoText value={c.pages.join("\n")} rows={6} onSave={savePages} />
          <div className="row small">
            <span className="muted">Minimums:</span>
            services <input type="number" min={0} max={40} style={{ width: 64 }} defaultValue={c.minServices} onBlur={(e) => put({ minServices: Number(e.target.value) })} />
            amenities <input type="number" min={0} max={40} style={{ width: 64 }} defaultValue={c.minAmenities} onBlur={(e) => put({ minAmenities: Number(e.target.value) })} />
          </div>
        </div>
        <Evidence ev={d.evidence} locs={c.locations} />
      </div>
    </div>
  );
}

/**
 * Highlight-and-copy in the sheet layout works like Google Sheets: the clipboard gets exactly the highlighted
 * block of cells (no row numbers / column letters), so it pastes into the right columns.
 */
function sheetCopy(e: React.ClipboardEvent<HTMLTableElement>, rows: string[][]) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const cellOf = (n: Node | null) => ((n instanceof Element ? n : n?.parentElement)?.closest("td[data-r]") as HTMLElement | null);
  const pos = (td: HTMLElement) => ({ r: Number(td.dataset.r), c: Number(td.dataset.c) });
  const a = cellOf(sel.anchorNode), f = cellOf(sel.focusNode);
  if (a && f && a === f) return; // text inside one cell: normal copy
  let pts: { r: number; c: number }[];
  if (a && f) pts = [pos(a), pos(f)];
  else pts = [...e.currentTarget.querySelectorAll<HTMLElement>("td[data-r]")].filter((td) => sel.containsNode(td, true)).map(pos);
  if (!pts.length) return;
  const r0 = Math.min(...pts.map((p) => p.r)), r1 = Math.max(...pts.map((p) => p.r));
  const c0 = Math.min(...pts.map((p) => p.c)), c1 = Math.max(...pts.map((p) => p.c));
  const block = rows.slice(r0, r1 + 1).map((r) => [0, 1, 2, 3].slice(c0, c1 + 1).map((j) => r[j] || ""));
  const q = (x: string) => (/[\t\n"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  e.clipboardData.setData("text/plain", block.map((r) => r.map(q).join("\t")).join("\n"));
  e.clipboardData.setData("text/html", `<table>${block.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table>`);
  e.preventDefault();
}

const READ_LABEL: Record<string, string> = { data: "", page: "read from the page", ai: "read by Groq AI — double-check", search: "from the search result", none: "couldn't open — check it yourself" };
function CrossCheckCard({ x }: { x: CrossCheckEv }) {
  const cell = (v: string, m: Mark) => !v ? <span className="muted">—</span>
    : <span style={{ color: m === "diff" ? "var(--error)" : m === "legal" || m === "minor" ? "var(--warning)" : undefined }}>{m === "ok" ? "✓ " : m === "diff" ? "✕ " : m ? "≈ " : ""}{v}</span>;
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <div className="row between">
        <div>
          <h3 style={{ margin: 0 }}>Cross-check listings</h3>
          <div className="muted small">Name, phone, address and website on every listing, compared with Jira. ✓ same · ≈ small difference (e.g. “LLC”) · ✕ different. Checked {ago(x.at)}.</div>
        </div>
        {x.rows.length < 2 ? <span className="badge">Nothing to compare yet — run GBP and search first</span>
          : <span className={`badge ${x.issues.length ? "warning" : "ok"}`}>{x.issues.length ? `${x.issues.length} difference(s)` : "All match"}</span>}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="t small">
          <thead><tr><th>Source</th><th>Name</th><th>Phone</th><th>Address</th><th>Website</th></tr></thead>
          <tbody>{x.rows.map((r, i) => (
            <tr key={i}>
              <td><b>{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.source}</a> : r.source}</b>{READ_LABEL[r.read] && <div className="muted">{READ_LABEL[r.read]}</div>}</td>
              <td>{cell(r.name, r.marks.name)}</td><td>{cell(r.phone, r.marks.phone)}</td><td>{cell(r.address, r.marks.address)}</td><td>{cell(r.website, r.marks.website)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {x.issues.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{x.issues.map((t, i) => <li key={i}>{t}</li>)}</ul>}
    </div>
  );
}

/** Top 5 GBP reviews — kept apart from the sheet so "Copy for Google Sheet" stays exactly like the original layout. */
function ReviewsCard({ f, onSave, copy, copied }: { f: CField | undefined; onSave: (p: Partial<CField>) => void; copy: (t: string, w: string) => void; copied: string }) {
  if (!f) return null;
  const items = f.value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const textOf = (x: string) => x.match(/^"([\s\S]*)"(?:\s*—[^"]*)?$/)?.[1] ?? x;
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <div className="row between">
        <div>
          <h3 style={{ margin: 0 }}>Top 5 GBP Reviews <StatusBadge s={f.status} onClick={() => onSave({ status: f.status === "ok" ? "review" : "ok" })} /></h3>
          <div className="muted small">Positive Google reviews picked for similar length so they look even on the website. Not part of the Google Sheet copy.</div>
        </div>
        <button className="sm" disabled={!f.value} onClick={() => copy(f.value, "reviews")}>{copied === "reviews" ? "✓ Copied" : "Copy reviews"}</button>
      </div>
      {items.length > 0 && (
        <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
          {items.map((x, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              <span style={{ whiteSpace: "pre-wrap" }}>{x}</span> <span className="muted">({textOf(x).length} characters)</span>
              <button className="sm ghost" style={{ marginLeft: 6 }} onClick={() => copy(x, `rev${i}`)}>{copied === `rev${i}` ? "✓" : "Copy"}</button>
            </li>
          ))}
        </ol>
      )}
      <details>
        <summary className="small muted">Edit reviews</summary>
        <AutoText value={f.value} rows={6} onSave={(v) => onSave({ value: v })} placeholder={'"Review text" — Name (blank line between reviews)'} />
      </details>
      {f.note && <div className="muted small" style={{ whiteSpace: "pre-wrap" }}>{f.note}</div>}
    </div>
  );
}

function ProjectCard({ p, editorUrl, previewUrl, onEditor, copy, copied }: { p: Project; editorUrl: string; previewUrl: string; onEditor: (v: string) => void; copy: (t: string, w: string) => void; copied: string }) {
  const [ed, setEd] = useState(editorUrl);
  useEffect(() => setEd(editorUrl), [editorUrl]);
  const tone = p.type === "mso" ? "warning" : p.type === "advanced" ? "accent" : "ok";
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <div className="row between">
        <div className="row">
          <span className={`badge ${tone}`} style={{ fontSize: 13, padding: "3px 10px" }}>{p.typeLabel || "Unknown type"}</span>
          {p.key && <a href={p.url} target="_blank" rel="noreferrer" className="badge">{p.key} ↗</a>}
          {p.tekmetricId && <span className="badge">Tekmetric ID {p.tekmetricId}</span>}
        </div>
        <span className="muted small">Jira created {p.created}</span>
      </div>
      <ol className="steps">
        <li className={p.template ? "done" : ""}>
          Template: <b>{p.template || "not found in Jira — check “Select Your Preferred … Site Design”"}</b>
          {p.template && <button className="sm ghost" onClick={() => copy(p.template, "tpl")}>{copied === "tpl" ? "✓" : "Copy"}</button>}
        </li>
        <li className={editorUrl ? "done" : ""}>
          Create the Duda site with that template, then paste its <b>Editor URL</b>:
          <div className="row" style={{ marginTop: 6, flexWrap: "nowrap" }}>
            <input value={ed} onChange={(e) => setEd(e.target.value)} placeholder="https://my.duda.co/home/site/xxxxxxxx/home" />
            <button className="sm" disabled={ed === editorUrl} onClick={() => onEditor(ed.trim())}>Save</button>
            <a className="btn sm" href="https://my.duda.co/home/dashboard/sites" target="_blank" rel="noreferrer">Open Duda ↗</a>
          </div>
        </li>
        <li className={previewUrl ? "done" : ""}>Preview link for QA: {previewUrl ? <a href={previewUrl} target="_blank" rel="noreferrer">{previewUrl} ↗</a> : <span className="muted">set automatically from the Editor URL</span>}</li>
      </ol>
      {p.activity.some((a) => a.type === "COMMENT") && (
        <details><summary className="muted small">Jira comments ({p.activity.filter((a) => a.type === "COMMENT").length})</summary>
          <div className="stack" style={{ marginTop: 8 }}>{p.activity.filter((a) => a.type === "COMMENT").map((a, i) => (
            <div key={i} className="small"><b>{a.author}</b> <span className="muted">{a.date}</span><div style={{ whiteSpace: "pre-wrap" }}>{a.details.slice(0, 1200)}</div></div>
          ))}</div>
        </details>
      )}
    </div>
  );
}

function StatusBadge({ s, onClick }: { s: Status; onClick: () => void }) {
  const t = s === "ok" ? ["ok", "OK"] : s === "review" ? ["warning", "Review"] : ["error", "Missing"];
  return <button className={`badge ${t[0]}`} style={{ border: "none", cursor: "pointer" }} title="Click to toggle OK / Review" onClick={onClick}>{t[1]}</button>;
}

function AutoText({ value, onSave, rows = 1, small, mono, placeholder }: { value: string; onSave: (v: string) => void; rows?: number; small?: boolean; mono?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const wrapped = v.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / (small ? 48 : 70))), 0);
  const lines = Math.min(14, Math.max(rows, wrapped));
  return (
    <textarea value={v} rows={lines} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v); }}
      style={{ minHeight: 0, fontSize: small ? 12 : 13, fontFamily: mono ? "var(--mono)" : undefined, resize: "vertical", color: small ? "var(--muted)" : undefined }} />
  );
}

function Evidence({ ev, locs }: { ev: Data["evidence"]; locs: Loc[] }) {
  return (
    <div className="card stack small" style={{ boxShadow: "none" }}>
      <h3 style={{ margin: 0 }}>What research found</h3>
      {!ev.gbp && !ev.website && !ev.search && !ev.gbpLocs?.length && <p className="muted">Nothing yet — run the research.</p>}
      {ev.gbpLocs?.map((g, i) => g && (
        <div key={i}><b>GBP — {locs[i]?.city || `Location ${i + 1}`}</b> <span className="muted">via {g.provider} · {ago(g.at)}</span>
          {g.title ? <div>{g.title} — {g.address} {g.rating != null && <span className="badge">{g.rating}★ · {g.reviews ?? "?"}</span>}</div> : <div className="muted">No match</div>}
        </div>
      ))}
      {ev.gbp && (
        <div><b>GBP</b> <span className="muted">via {ev.gbp.provider} · {ago(ev.gbp.at)}</span>
          {ev.gbp.title ? <div>{ev.gbp.title} — {ev.gbp.address} {ev.gbp.rating != null && <span className="badge">{ev.gbp.rating}★ · {ev.gbp.reviews ?? "?"}</span>}</div> : <div className="muted">No match</div>}
          {ev.gbp.hours && Object.keys(ev.gbp.hours).length > 0 && <div className="muted">Hours: {Object.entries(ev.gbp.hours).map(([d, h]) => `${d.slice(0, 3)} ${h}`).join(" · ")}</div>}
        </div>
      )}
      {ev.website && (
        <div><b>Website</b> <span className="muted">· {ago(ev.website.at)}</span>
          <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{ev.website.pages.map((p) => <li key={p.url}><a href={p.url} target="_blank" rel="noreferrer">{p.title || p.url}</a></li>)}</ul>
        </div>
      )}
      {ev.search && (
        <details><summary><b>Search</b> <span className="muted">via {ev.search.provider} · {ev.search.results.length} results · {ago(ev.search.at)}</span></summary>
          <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{ev.search.results.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a></li>)}</ul>
        </details>
      )}
    </div>
  );
}
