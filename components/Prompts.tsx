"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ago } from "./api";
import HomepageContent from "./HomepageContent";

type Gen = { at: string; provider: string; issues: string[] };
type MetaRow = { page: string; title: string; description: string };
type ServicePage = Gen & { sections: { label: string; title: string; content: string }[]; metaTitle: string; metaDescription: string; text: string };
type RedirectRow = { from: string; to: string; type: string; why?: string };
type View = {
  onePager: boolean; template: string | null; projectType: string | null; vars: Record<string, string>; services: string[];
  metaPagesDefault: string[]; oldUrlsDefault: string; destUrlDefault: string; domain: string; serviceAreas: { list: string[]; from: "you" | "website" | "" };
  location: (Gen & { text: string; cities: string[] }) | null;
  faq: (Gen & { variant: string; text: string; links?: { question: string; label: string; requested: boolean }[] }) | null;
  rules: Record<"location" | "faq" | "meta" | "services" | "redirects", string[]>;
  meta: (Gen & { pages: string[]; rows: MetaRow[]; text: string; csv: string }) | null;
  servicePages: Record<string, ServicePage>; servicesCsv: string;
  redirects: (Gen & { oldText: string; destUrl: string; destText: string; fullAnchors: boolean; rows: RedirectRow[]; csvParts: string[] }) | null;
  ai: boolean;
};

const TABS = [["homepage", "Homepage"], ["location", "Location"], ["faq", "FAQ"], ["meta", "Meta"], ["services", "Services"], ["redirects", "URL Redirects"]] as const;
type Tab = (typeof TABS)[number][0];

/** Prompts tab: every content prompt for this project, filled from its Data Collection. */
export default function Prompts({ siteId, canManage }: { siteId: number; canManage: boolean }) {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "homepage";
    const q = new URLSearchParams(window.location.search).get("p");
    return (TABS.find(([k]) => k === q)?.[0] as Tab) || "homepage";
  });
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api<View>(`/api/sites/${siteId}/prompts`).then(setV).catch((e) => setErr(e.message)), [siteId]);
  useEffect(() => { if (tab !== "homepage") load(); }, [tab, load]);
  const pick = (t: Tab) => { setTab(t); const u = new URL(window.location.href); u.searchParams.set("p", t); window.history.replaceState(null, "", u); };

  /** One AI request; `key` names what's busy so only that button shows progress. */
  const gen = async (key: string, body: Record<string, unknown>) => {
    setErr(""); setBusy(key);
    try { setV(await api<View>(`/api/sites/${siteId}/prompts`, { body })); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(""); }
  };
  const edit = (body: Record<string, unknown>) => api<View>(`/api/sites/${siteId}/prompts`, { method: "PUT", body }).then(setV).catch((e) => setErr(e.message));

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6 }}>
        {TABS.map(([k, label]) => <button key={k} className={`sm ${tab === k ? "primary" : ""}`} onClick={() => pick(k)}>{label}</button>)}
      </div>
      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}
      {tab === "homepage" ? <HomepageContent siteId={siteId} canManage={canManage} /> : !v ? <p className="muted">Loading…</p> : (
        <>
          {!v.ai && <div className="alert warning small">No AI provider is set up yet — a Super Admin can add a free key in Settings → AI providers.</div>}
          {tab === "location" && <LocationPanel v={v} busy={busy} gen={gen} edit={edit} />}
          {tab === "faq" && <FaqPanel v={v} busy={busy} gen={gen} edit={edit} />}
          {tab === "meta" && <MetaPanel v={v} busy={busy} gen={gen} edit={edit} />}
          {tab === "services" && <ServicesPanel v={v} busy={busy} gen={gen} edit={edit} />}
          {tab === "redirects" && <RedirectsPanel v={v} busy={busy} gen={gen} edit={edit} siteId={siteId} onError={setErr} />}
          <p className="muted small" style={{ margin: 0 }}>Prompts are edited in Settings → Prompts. Shop details come from this project&apos;s Data Collection — fix them there and write again.</p>
        </>
      )}
    </div>
  );
}

type P = { v: View; busy: string; gen: (key: string, body: Record<string, unknown>) => Promise<boolean>; edit: (b: Record<string, unknown>) => void };

/* ---------- shared bits ---------- */

function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = async (text: string, key: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); } catch { /* blocked */ } };
  return { copied, copy };
}
function download(name: string, text: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "shop";

function Head({ title, help, gen, busy, label, done }: { title: string; help: React.ReactNode; gen: () => void; busy: boolean; label: string; done?: Gen | null }) {
  return (
    <div className="row between">
      <div><h3 style={{ margin: 0 }}>{title}</h3><div className="muted small">{help}</div>
        {done && <div className="muted small">Written {ago(done.at)} · {done.provider.split(":")[0]}</div>}</div>
      <button className="primary" disabled={busy} onClick={gen}>{busy ? "Writing…" : done ? "Write again" : label}</button>
    </div>
  );
}
function Issues({ list }: { list: string[] }) {
  if (!list.length) return <span className="badge ok">All checks passed</span>;
  return <details className="small" open={list.length <= 4}><summary><span className="badge warning">{list.length} thing(s) to check</span></summary><ul style={{ margin: "4px 0", paddingLeft: 18 }}>{list.map((x, i) => <li key={i}>{x}</li>)}</ul></details>;
}
function AskAi({ onAsk, busy, placeholder = "Ask AI to change it — e.g. “shorter”, “more friendly”, “mention our free shuttle”" }: { onAsk: (t: string) => Promise<boolean>; busy: boolean; placeholder?: string }) {
  const [t, setT] = useState("");
  const go = async () => { if (t.trim() && !busy && (await onAsk(t.trim()))) setT(""); };
  return (
    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <input value={t} placeholder={placeholder} disabled={busy} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} />
      <button className="sm" disabled={busy || !t.trim()} onClick={go}>{busy ? "Revising…" : "✨ Revise"}</button>
    </div>
  );
}
function TextOut({ text, onSave, name }: { text: string; onSave: (t: string) => void; name: string }) {
  const [t, setT] = useState(text);
  useEffect(() => setT(text), [text]);
  const { copied, copy } = useCopy();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <textarea rows={Math.min(30, Math.max(8, t.split("\n").length + 2))} value={t} onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== text) onSave(t); }} />
      <div className="row"><button className="primary sm" onClick={() => copy(t, name)}>{copied === name ? "✓ Copied" : "Copy"}</button>{t !== text && <span className="muted small">click outside to save your edit</span>}</div>
    </div>
  );
}
/** The general rules (Settings → Prompts) that go out with this prompt. */
function Rules({ list }: { list: string[] }) {
  return (
    <details className="small"><summary className="muted">{list.length ? `General rules sent with this prompt (${list.length})` : "No general rules yet"}</summary>
      {list.length ? <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{list.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      <div className="muted">Admins edit them in <b>Settings → Prompts</b> (per prompt, or for every prompt). They go out in the same request as the prompt, so the first answer already follows them.</div>
    </details>
  );
}
function Vars({ v, keys }: { v: View; keys: string[] }) {
  return (
    <details className="small"><summary className="muted">Shop details used</summary>
      <table className="t small"><tbody>{keys.map((k) => <tr key={k}><td style={{ width: 160 }}><code>{k}</code></td><td style={{ whiteSpace: "pre-wrap" }}>{v.vars[k] || <span className="muted">(empty in Data Collection)</span>}</td></tr>)}</tbody></table>
    </details>
  );
}

/* ---------- Location ---------- */

function LocationPanel({ v, busy, gen, edit }: P) {
  const [areas, setAreas] = useState(v.serviceAreas.list.join("\n"));
  useEffect(() => setAreas(v.serviceAreas.list.join("\n")), [v.serviceAreas]);
  const changed = areas.trim() !== v.serviceAreas.list.join("\n").trim();
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <Head title="Our location" help="Intro for the location section + 24 nearby cities with their counties. The shop's own service area goes first." label="Write location content" busy={busy === "location"} done={v.location} gen={() => gen("location", { kind: "location" })} />
      <label className="field"><span>Service area — cities they cover ({v.serviceAreas.list.length}{v.serviceAreas.from === "website" ? ", read from their website" : v.serviceAreas.from === "you" ? ", entered by you" : ""})</span>
        <textarea rows={Math.min(8, Math.max(3, areas.split("\n").length + 1))} value={areas} onChange={(e) => setAreas(e.target.value)}
          placeholder={"Paste the list from their Facebook page (About → service area) or website, e.g.\nElburn, IL · North Aurora, IL · Batavia, IL · Geneva, IL"} />
        <span className="row small" style={{ gap: 6 }}>
          <button className="sm" disabled={!changed} onClick={() => edit({ serviceAreas: areas })}>Save service area</button>
          {v.serviceAreas.from === "you" && <button className="sm ghost" onClick={() => edit({ serviceAreas: null })}>Use what research found</button>}
          <span className="muted">These cities are listed first, in this order; the rest of the 24 are the nearest other towns.</span>
        </span>
      </label>
      <Vars v={v} keys={["Shop_Name", "City_State", "Vehicles_Serviced", "Certifications", "Warranty"]} />
      <Rules list={v.rules.location} />
      {v.location && <>
        <Issues list={v.location.issues} />
        <TextOut name="location" text={v.location.text} onSave={(t) => edit({ locationText: t })} />
        <AskAi busy={busy === "location"} onAsk={(t) => gen("location", { kind: "location", instruction: t })} />
      </>}
    </div>
  );
}

/* ---------- FAQ ---------- */

function FaqPanel({ v, busy, gen, edit }: P) {
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <Head title="FAQ" label="Write FAQ"
        help={v.onePager ? <>One-page site ({v.template || "Basic"}) — uses the <b>section</b> version. Answers only point to requested sections.</> : <>Multi-page site — uses the <b>page</b> version. Answers only point to requested pages.</>}
        busy={busy === "faq"} done={v.faq} gen={() => gen("faq", { kind: "faq" })} />
      <Vars v={v} keys={["Shop_Name", "Shop_Location", "Shop_Hours", "Requested_Pages"]} />
      <Rules list={v.rules.faq} />
      {v.faq && <>
        {!!v.faq.links?.length && <div className="muted small">{v.onePager ? "Sections" : "Pages"} the answers may point to:{" "}
          {v.faq.links.map((l) => <span key={l.question} className={`badge ${l.requested ? "ok" : ""}`} style={{ marginRight: 4 }} title={l.question}>{l.requested ? "✓" : "✗"} {l.label}{l.requested ? "" : " — not requested, not mentioned"}</span>)}</div>}
        <Issues list={v.faq.issues} />
        <TextOut name="faq" text={v.faq.text} onSave={(t) => edit({ faqText: t })} />
        <AskAi busy={busy === "faq"} onAsk={(t) => gen("faq", { kind: "faq", instruction: t })} />
      </>}
    </div>
  );
}

/* ---------- Meta ---------- */

function MetaPanel({ v, busy, gen, edit }: P) {
  const [pages, setPages] = useState((v.meta?.pages || v.metaPagesDefault).join("\n"));
  const [rows, setRows] = useState<MetaRow[]>(v.meta?.rows || []);
  useEffect(() => setRows(v.meta?.rows || []), [v.meta]);
  const { copied, copy } = useCopy();
  const list = pages.split("\n").map((x) => x.trim()).filter(Boolean);
  const shop = slug(v.vars.Shop_Name);
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <Head title="Meta titles & descriptions" label="Write meta" busy={busy === "meta"} done={v.meta}
        help={v.onePager ? "One-page site: Home, Image Credits, Privacy Policy, Site Wide." : "Requested pages + Home, About Us, Image Credits, Privacy Policy, Site Wide."}
        gen={() => gen("meta", { kind: "meta", pages: list })} />
      <Rules list={v.rules.meta} />
      <details className="small" open={!v.meta}><summary>Pages ({list.length})</summary>
        <textarea rows={Math.min(14, list.length + 1)} value={pages} onChange={(e) => setPages(e.target.value)} />
        <button className="sm ghost" onClick={() => setPages(v.metaPagesDefault.join("\n"))}>Reset to the default list</button>
      </details>
      {v.meta && <>
        <Issues list={v.meta.issues} />
        <table className="t small">
          <thead><tr><th style={{ width: 130 }}>Page</th><th>Meta title</th><th>Meta description</th></tr></thead>
          <tbody>{rows.map((m, i) => {
            const set = (k: keyof MetaRow, val: string) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
            const save = () => { if (JSON.stringify(rows) !== JSON.stringify(v.meta!.rows)) edit({ metaRows: rows }); };
            const tBad = m.title.length >= 70, dBad = m.description.length < 150 || m.description.length > 160;
            return (
              <tr key={i}>
                <td><b>{m.page}</b></td>
                <td><textarea rows={2} value={m.title} onChange={(e) => set("title", e.target.value)} onBlur={save} /><span className={`badge ${tBad ? "warning" : "ok"}`}>{m.title.length} / &lt;70</span></td>
                <td><textarea rows={3} value={m.description} onChange={(e) => set("description", e.target.value)} onBlur={save} /><span className={`badge ${dBad ? "warning" : "ok"}`}>{m.description.length} / 150–160</span></td>
              </tr>
            );
          })}</tbody>
        </table>
        <div className="row">
          <button className="primary sm" onClick={() => copy(rows.map((m) => `${m.page}\n${m.title}\n${m.description}`).join("\n\n"), "meta")}>{copied === "meta" ? "✓ Copied" : "Copy all"}</button>
          <button className="sm" onClick={() => download(`${shop}-meta.csv`, v.meta!.csv)}>Download CSV</button>
        </div>
        <AskAi busy={busy === "meta"} onAsk={(t) => gen("meta", { kind: "meta", pages: list, instruction: t })} />
      </>}
    </div>
  );
}

/* ---------- Service pages ---------- */

function ServicesPanel({ v, busy, gen, edit }: P) {
  const [t, setT] = useState(v.services.join("\n"));
  useEffect(() => setT(v.services.join("\n")), [v.services]);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState<{ done: number; total: number } | null>(null);
  const list = t.split("\n").map((x) => x.trim()).filter(Boolean);
  const { copied, copy } = useCopy();
  if (v.onePager) return <div className="alert small">This is a one-page site ({v.template || "Basic"}) — service pages are only written for multi-page sites. Use the homepage Services section instead.</div>;
  const missing = v.services.filter((s) => !v.servicePages[s]);
  const writeAll = async (names: string[]) => {
    setAll({ done: 0, total: names.length });
    for (let i = 0; i < names.length; i++) {
      if (!(await gen(`svc:${names[i]}`, { kind: "service", service: names[i] }))) break;
      setAll({ done: i + 1, total: names.length });
    }
    setAll(null);
  };
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <div className="row between">
        <div><h3 style={{ margin: 0 }}>Service pages</h3><div className="muted small">One page per service: 4 content sections + meta title/description. Each one is a separate AI request.</div></div>
        <div className="row">
          <button className="primary" disabled={!!busy || !missing.length} onClick={() => writeAll(missing)}>{all ? `Writing ${all.done + 1} of ${all.total}…` : `Write ${missing.length ? `the ${missing.length} missing` : "all"}`}</button>
          {v.servicesCsv && <button onClick={() => download(`${slug(v.vars.Shop_Name)}-service-pages.csv`, v.servicesCsv)}>Download CSV</button>}
        </div>
      </div>
      <details className="small" open={!Object.keys(v.servicePages).length}><summary>Services ({v.services.length}) — shared with the homepage Services section</summary>
        <textarea rows={Math.min(14, list.length + 1)} value={t} onChange={(e) => setT(e.target.value)} placeholder="One service per line" />
        <button className="sm" disabled={list.join("\n") === v.services.join("\n")} onClick={() => edit({ services: list.length ? list : null })}>Save services</button>
      </details>
      <Vars v={v} keys={["Shop_Name", "City_State", "Certifications", "Warranty"]} />
      <Rules list={v.rules.services} />
      <table className="t small">
        <tbody>{[...v.services, ...Object.keys(v.servicePages).filter((s) => !v.services.includes(s))].map((s) => {
          const sp = v.servicePages[s];
          const b = busy === `svc:${s}`;
          return (
            <tr key={s}><td>
              <div className="row between">
                <div><b>{s}</b> {sp ? <span className="muted">· written {ago(sp.at)}</span> : <span className="muted">· not written</span>} {sp && <span className={`badge ${sp.issues.length ? "warning" : "ok"}`}>{sp.issues.length ? `${sp.issues.length} to check` : "checks passed"}</span>}</div>
                <div className="row">
                  {sp && <button className="sm" onClick={() => setOpen(open === s ? null : s)}>{open === s ? "Close" : "Open"}</button>}
                  {sp && <button className="sm" onClick={() => copy(sp.text, s)}>{copied === s ? "✓ Copied" : "Copy"}</button>}
                  <button className="sm" disabled={!!busy} onClick={() => gen(`svc:${s}`, { kind: "service", service: s })}>{b ? "Writing…" : sp ? "Write again" : "Write"}</button>
                  {sp && !v.services.includes(s) && <button className="sm ghost danger" onClick={() => edit({ service: { name: s, remove: true } })}>Remove</button>}
                </div>
              </div>
              {sp && open === s && <ServiceEditor name={s} sp={sp} busy={b} gen={gen} edit={edit} />}
            </td></tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
function ServiceEditor({ name, sp, busy, gen, edit }: { name: string; sp: ServicePage; busy: boolean; gen: P["gen"]; edit: P["edit"] }) {
  const [x, setX] = useState(sp);
  useEffect(() => setX(sp), [sp]);
  const save = () => { if (JSON.stringify(x) !== JSON.stringify(sp)) edit({ service: { name, sections: x.sections, metaTitle: x.metaTitle, metaDescription: x.metaDescription } }); };
  const words = (s: string) => (s.match(/[A-Za-z0-9’'-]+/g) || []).length;
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8 }}>
      <Issues list={sp.issues} />
      {x.sections.map((s, i) => (
        <div key={i} className="stack" style={{ gap: 4 }}>
          <div className="muted">{s.label} · {words(s.content)} words</div>
          <input value={s.title} onChange={(e) => setX({ ...x, sections: x.sections.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)) })} onBlur={save} style={{ fontWeight: 600 }} />
          <textarea rows={Math.min(16, Math.max(4, Math.ceil(s.content.length / 110) + s.content.split("\n").length))} value={s.content} onChange={(e) => setX({ ...x, sections: x.sections.map((y, j) => (j === i ? { ...y, content: e.target.value } : y)) })} onBlur={save} />
        </div>
      ))}
      <label className="field"><span>Meta title ({x.metaTitle.length})</span><input value={x.metaTitle} onChange={(e) => setX({ ...x, metaTitle: e.target.value })} onBlur={save} /></label>
      <label className="field"><span>Meta description ({x.metaDescription.length})</span><textarea rows={2} value={x.metaDescription} onChange={(e) => setX({ ...x, metaDescription: e.target.value })} onBlur={save} /></label>
      <AskAi busy={busy} onAsk={(t) => gen(`svc:${name}`, { kind: "service", service: name, instruction: t })} />
    </div>
  );
}

/* ---------- URL redirects ---------- */

function RedirectsPanel({ v, busy, gen, siteId, onError }: P & { siteId: number; onError: (e: string) => void }) {
  const r = v.redirects;
  const [oldText, setOld] = useState(r?.oldText ?? v.oldUrlsDefault);
  const [destUrl, setDestUrl] = useState(r?.destUrl || v.destUrlDefault);
  const [destText, setDest] = useState(r?.destText || "");
  const [fullAnchors, setFull] = useState(r?.fullAnchors ?? false);
  const [scanMsg, setScanMsg] = useState("");
  const { copied, copy } = useCopy();
  const olds = oldText.split("\n").filter((x) => x.trim()).length, dests = destText.split("\n").filter((x) => x.trim()).length;
  const scan = async () => {
    setScanMsg("Scanning…"); onError("");
    try {
      const s = await api<{ paths: string[]; errors: string[] }>(`/api/sites/${siteId}/prompts`, { body: { kind: "scan", url: destUrl } });
      setDest(s.paths.join("\n"));
      setScanMsg(`Found ${s.paths.length} page(s)/anchor(s)${s.errors.length ? ` · ${s.errors.length} page(s) couldn't be opened` : ""}.`);
    } catch (e) { setScanMsg(""); onError((e as Error).message); }
  };
  const body = { kind: "redirects", oldText, destUrl, destText, fullAnchors };
  const shop = slug(v.vars.Shop_Name);
  return (
    <div className="card stack" style={{ boxShadow: "none" }}>
      <div className="row between">
        <div><h3 style={{ margin: 0 }}>Duda URL redirects</h3><div className="muted small">Old website pages → pages on the new site. CSV ready for Duda&apos;s import (301, paths only, up to 200 per file).</div>
          {r && <div className="muted small">Written {ago(r.at)} · {r.provider.split(":")[0]}</div>}</div>
        <button className="primary" disabled={busy === "redirects" || !olds || !dests} onClick={() => gen("redirects", body)}>{busy === "redirects" ? "Matching…" : r ? "Write again" : "Write redirects"}</button>
      </div>
      <Rules list={v.rules.redirects} />
      <div className="grid2">
        <label className="field"><span>Old page URLs ({olds})</span>
          <textarea rows={12} value={oldText} onChange={(e) => setOld(e.target.value)} placeholder={"/about-us\n/services/brakes\n…"} />
          <span className="muted small">{v.oldUrlsDefault ? "Filled from the internal URLs research found on their existing website — add any others (e.g. from the domain)." : "Paste the old website's URLs, one per line (run the Existing website research step to fill this automatically)."}{" "}
            {v.oldUrlsDefault && oldText !== v.oldUrlsDefault && <button className="sm ghost" onClick={() => setOld(v.oldUrlsDefault)}>Use research list</button>}</span>
        </label>
        <label className="field"><span>Destination page URLs ({dests})</span>
          <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
            <input value={destUrl} onChange={(e) => setDestUrl(e.target.value)} placeholder="New site URL (Duda preview or live)" />
            <button className="sm" disabled={!destUrl.trim()} onClick={scan}>Scan site</button>
          </div>
          <textarea rows={10} value={destText} onChange={(e) => setDest(e.target.value)} placeholder={v.onePager ? "/home#services\n/home#about-us\n…" : "/services\n/vehicles-we-work-on\n…"} />
          <span className="muted small">{scanMsg || (v.onePager ? "One-page site: most destinations are anchors (/home#anchor) from the navigation." : "Scan the new site to list its pages.")}</span>
        </label>
      </div>
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={fullAnchors} onChange={(e) => setFull(e.target.checked)} style={{ width: "auto" }} />
        Full URL for anchors ({v.domain ? `www.${v.domain.replace(/^www\./, "")}/#anchor` : "needs the domain in Data Collection"}) — Duda&apos;s help says CSV anchor redirects need it; default is /home#anchor.</label>
      {r && <>
        <Issues list={r.issues} />
        <div className="row">
          {r.csvParts.map((csv, i) => <button key={i} className={i ? "sm" : "primary sm"} onClick={() => download(`${shop}-redirects${r.csvParts.length > 1 ? `-part${i + 1}` : ""}.csv`, csv)}>Download CSV{r.csvParts.length > 1 ? ` part ${i + 1}` : ""}</button>)}
          <button className="sm" onClick={() => copy(r.csvParts.join(""), "csv")}>{copied === "csv" ? "✓ Copied" : "Copy CSV"}</button>
          <span className="muted small">{r.rows.length} redirect(s)</span>
        </div>
        <table className="t small">
          <thead><tr><th>Old Page URL</th><th>Destination Page URL</th><th>Type</th><th>How</th></tr></thead>
          <tbody>{r.rows.map((x, i) => <tr key={i} className={x.why === "fallback rule" ? "dc-review" : ""}><td><code>{x.from}</code></td><td><code>{x.to}</code></td><td>{x.type}</td><td className="muted">{x.why}</td></tr>)}</tbody>
        </table>
        <AskAi busy={busy === "redirects"} placeholder="Ask AI to change the matches — e.g. “send /tires/* to /tire-services”" onAsk={(t) => gen("redirects", { ...body, instruction: t })} />
      </>}
    </div>
  );
}
