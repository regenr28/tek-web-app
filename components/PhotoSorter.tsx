"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ago } from "./api";
import { listZip, readEntry, isPhoto, baseName, type ZipEntry } from "@/lib/zipread";

type Result = { key: string; file: string; zip: string; category: string; focus: string; why: string; confidence: string; provider: string; checked?: boolean; manual?: boolean; at: string };
type Provider = { id: string; label: string; model: string; usedToday: number; remaining: number | null; limit: number | null; reported: boolean; resetIn: string; restingUntil: number };
type View = { services: string[]; others: string[]; results: Result[]; providers: Provider[]; text: string };
type Item = { key: string; file: string; zip: string; blob: File; entry: ZipEntry };
type ZipInfo = { name: string; photos: number; other: number; error?: string };

const SPACING_MS = 2500; // ≤ 24 photos a minute — stays under Groq's free 30 requests/minute
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff" };

/** Photo → small JPEG (max 1024 px) for the AI + a tiny thumbnail for this page. Nothing is uploaded or kept on the server. */
async function shrink(data: Uint8Array, name: string): Promise<{ b64: string; thumb: string }> {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: MIME[ext] || "application/octet-stream" }));
  const draw = (max: number) => {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  };
  let url = draw(1024).toDataURL("image/jpeg", 0.8);
  if (url.length > 900_000) url = draw(800).toDataURL("image/jpeg", 0.6);
  const thumb = draw(112).toDataURL("image/jpeg", 0.6);
  bmp.close();
  return { b64: url.slice(url.indexOf(",") + 1), thumb };
}

export default function PhotoSorter({ siteId }: { siteId: number }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [services, setServices] = useState("");
  const [zips, setZips] = useState<ZipInfo[]>([]);
  const [queue, setQueue] = useState<Item[]>([]);
  const [run, setRun] = useState<{ state: "idle" | "running" | "paused" | "waiting" | "done"; done: number; total: number; current: string; note: string }>({ state: "idle", done: 0, total: 0, current: "", note: "" });
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const stopRef = useRef(false);

  const load = useCallback(() => api<View>(`/api/sites/${siteId}/photos`).then((x) => { setV(x); setServices((s) => s || x.services.join("\n")); }).catch((e) => setErr(e.message)), [siteId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { stopRef.current = true; }, []);

  // every photo with a result counts as done (incl. "Couldn't open" — add a converted copy to retry it)
  const doneKeys = useMemo(() => new Set((v?.results || []).map((r) => r.key)), [v]);

  async function addZips(files: FileList | null) {
    if (!files?.length) return;
    setErr("");
    const items: Item[] = [], infos: ZipInfo[] = [];
    for (const f of Array.from(files)) {
      try {
        const entries = await listZip(f);
        const photos = entries.filter((e) => isPhoto(e.name));
        infos.push({ name: f.name, photos: photos.length, other: entries.length - photos.length });
        for (const e of photos) items.push({ key: `${f.name}|${e.name}|${e.size}`, file: baseName(e.name), zip: f.name, blob: f, entry: e });
      } catch (e) { infos.push({ name: f.name, photos: 0, other: 0, error: (e as Error).message }); }
    }
    setZips((z) => [...z.filter((x) => !infos.some((i) => i.name === x.name)), ...infos]);
    setQueue((q) => [...q.filter((x) => !items.some((i) => i.key === x.key)), ...items]);
  }

  const todo = queue.filter((i) => !doneKeys.has(i.key));
  const saveServices = () => api<View>(`/api/sites/${siteId}/photos`, { method: "PUT", body: { services } }).then(setV);

  async function start() {
    setErr("");
    const list = services.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!list.length) { setErr("Add the shop's services first (one per line)."); return; }
    if (!todo.length) { setErr(queue.length ? "Every photo in these zips is already sorted." : "Add one or more .zip files of photos first."); return; }
    try { await saveServices(); } catch (e) { setErr((e as Error).message); return; }
    try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch { /* ignore */ }
    stopRef.current = false;
    const items = [...todo];
    let done = 0;
    setRun({ state: "running", done: 0, total: items.length, current: "", note: "" });
    let next = 0, lastStart = 0;
    // local testing only: a faster pace can be set with localStorage "photoSpacingMs"
    let spacing = SPACING_MS;
    try { const x = Number(localStorage.getItem("photoSpacingMs")); if (location.hostname === "localhost" && x > 0 && x < SPACING_MS) spacing = x; } catch { /* ignore */ }
    const worker = async () => {
      while (!stopRef.current) {
        const i = next++;
        if (i >= items.length) return;
        const it = items[i];
        // pace requests
        const wait = lastStart + spacing - Date.now();
        lastStart = Math.max(Date.now(), lastStart + spacing);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        setRun((r) => ({ ...r, current: `${it.zip} / ${it.file}` }));
        let img: { b64: string; thumb: string } | null = null;
        try { img = await shrink(await readEntry(it.blob, it.entry), it.entry.name); }
        catch (e) {
          const m = (e as Error).message || "";
          const reason = /heic|heif/i.test(it.file) ? "HEIC photo — this browser can't open it. Convert it to JPG (or open this page in Safari) and add it again." : `Couldn't open the file (${m.slice(0, 80) || "unknown format"}).`;
          await api(`/api/sites/${siteId}/photos/analyze`, { body: { key: it.key, file: it.file, zip: it.zip, failed: reason } }).catch(() => {});
        }
        if (img) {
          setThumbs((t) => ({ ...t, [it.key]: img!.thumb }));
          // never skip: if every free AI is resting (limit reached), wait and try the same photo again
          for (let attempt = 0; !stopRef.current; attempt++) {
            let r: { result?: Result; resting?: number; error?: string; providers?: Provider[] };
            try { r = await api(`/api/sites/${siteId}/photos/analyze`, { body: { key: it.key, file: it.file, zip: it.zip, mime: "image/jpeg", b64: img.b64 } }); }
            catch (e) { r = { error: (e as Error).message }; }
            if (r.providers) setV((x) => (x ? { ...x, providers: r.providers! } : x));
            if (r.result) { setV((x) => (x ? { ...x, results: [...x.results.filter((y) => y.key !== it.key), r.result!] } : x)); break; }
            if (r.resting) {
              const until = new Date(r.resting);
              setRun((s) => ({ ...s, state: "waiting", note: `The free AI limit is reached — it continues by itself at ${until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Keep this tab open.` }));
              while (!stopRef.current && Date.now() < r.resting) await new Promise((res) => setTimeout(res, 5000));
              setRun((s) => ({ ...s, state: "running", note: "" }));
              continue;
            }
            if (attempt >= 3) {
              await api(`/api/sites/${siteId}/photos/analyze`, { body: { key: it.key, file: it.file, zip: it.zip, failed: `The AI couldn't analyze it: ${(r.error || "").slice(0, 200)}` } }).catch(() => {});
              break;
            }
            await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
          }
        }
        done++;
        setRun((r) => ({ ...r, done }));
        document.title = `${done}/${items.length} photos sorted`;
      }
    };
    await Promise.all([worker(), worker()]);
    await load();
    const finished = !stopRef.current;
    setRun((r) => ({ ...r, state: finished ? "done" : "paused", current: "", note: finished ? "" : "Paused — press Start to continue where it stopped." }));
    document.title = "Tek Website Monitoring";
    if (finished) {
      try { if ("Notification" in window && Notification.permission === "granted") new Notification("Photos sorted", { body: `${items.length} photo(s) analyzed — open the Photos tab to see them by service.` }); } catch { /* ignore */ }
    }
  }

  const move = (key: string, category: string) => api<View>(`/api/sites/${siteId}/photos`, { method: "PUT", body: { move: { key, category } } }).then(setV).catch((e) => setErr(e.message));
  const clearAll = () => { if (confirm("Remove all photo results for this project?")) api<View>(`/api/sites/${siteId}/photos`, { method: "PUT", body: { clear: true } }).then(setV); };
  const copy = async (t: string, k: string) => { await navigator.clipboard.writeText(t); setCopied(k); setTimeout(() => setCopied(""), 1500); };

  if (!v) return <p className="muted">{err || "Loading…"}</p>;
  const multiZip = new Set(v.results.map((r) => r.zip)).size > 1;
  const groups = [...v.services, ...v.others.filter((o) => o !== "Needs your check" && o !== "Couldn't open")];
  const special = ["Needs your check", "Couldn't open"];
  const by = (g: string) => v.results.filter((r) => r.category === g);
  const label = (r: Result) => (multiZip ? `${r.zip} / ${r.file}` : r.file);
  const groupText = (g: string) => `${g}\n${by(g).map((r) => `* ${label(r)}`).join("\n")}`;
  const busy = run.state === "running" || run.state === "waiting";
  const canDo = v.providers.reduce((n, p) => n + (p.remaining ?? 0), 0);

  return (
    <div className="stack">
      {err && <div className="alert error" onClick={() => setErr("")}>{err}</div>}
      <div className="card stack" style={{ boxShadow: "none", background: "var(--panel-2)" }}>
        <div>
          <h3 style={{ margin: 0 }}>Photo sorter</h3>
          <div className="muted small">Add .zip files of their photos (Facebook / GBP downloads). Every photo is looked at by free AI, one by one, and filed under the service it shows — only when that service is the focus of the photo. Photos stay in your browser; only file names and results are saved. Keep this tab open while it runs.</div>
        </div>
        <div className="grid2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
          <label className="stack small" style={{ gap: 4 }}><b>Services to sort by (one per line)</b>
            <textarea rows={8} value={services} disabled={busy} onChange={(e) => setServices(e.target.value)} onBlur={() => { if (services.trim() !== v.services.join("\n")) saveServices().catch(() => {}); }} placeholder={"Brake Repair\nOil Change\nAxle & Drivetrain Service"} />
            <span className="muted">Taken from Data Collection → Primary Services. Photos that aren't a service go to Shop, Team, Vehicles, Flyers or “Needs your check”.</span>
          </label>
          <div className="stack small" style={{ gap: 6 }}>
            <b>Free AI credits today</b>
            {!v.providers.length && <div className="alert warning">No AI that can look at photos is set up. Add a free Groq key in Settings → AI providers.</div>}
            {v.providers.map((p) => (
              <div key={p.id} className="row between" style={{ borderBottom: "1px solid var(--border)", padding: "2px 0" }}>
                <span>{p.label} <span className="muted">({p.model.split("/").pop()})</span></span>
                <span>
                  {p.remaining != null ? <b>{p.remaining.toLocaleString()}</b> : "?"}{p.limit ? ` of ${p.limit.toLocaleString()}` : ""} left
                  <span className="muted"> · {p.usedToday} used today{p.reported ? "" : " (estimated)"}{p.restingUntil ? ` · resting until ${new Date(p.restingUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
                </span>
              </div>
            ))}
            {v.providers.length > 0 && <span className="muted">{v.providers.some((p) => p.remaining == null) ? "Some providers don't say how many they have left." : `≈ ${canDo.toLocaleString()} photo(s) can be done today (an unsure photo uses 2).`} If credits run out, it waits and continues by itself — nothing is skipped.</span>}
          </div>
        </div>
        <label className="dropzone" style={{ display: "block", border: "2px dashed var(--border)", borderRadius: 10, padding: 16, textAlign: "center", cursor: busy ? "not-allowed" : "pointer" }}>
          <input type="file" accept=".zip,application/zip" multiple disabled={busy} style={{ display: "none" }} onChange={(e) => { addZips(e.target.files); e.target.value = ""; }} />
          <b>Choose .zip files</b> <span className="muted">— one or several, any number of photos each</span>
        </label>
        {zips.length > 0 && (
          <div className="small">
            {zips.map((z) => <div key={z.name}>{z.error ? <span style={{ color: "var(--error)" }}>✗ {z.name}: {z.error}</span> : <>📦 <b>{z.name}</b> — {z.photos} photo(s){z.other ? <span className="muted"> · {z.other} other file(s) ignored (not photos)</span> : ""}</>}</div>)}
            <div className="muted">{todo.length} to analyze{queue.length - todo.length ? ` · ${queue.length - todo.length} already sorted (kept)` : ""}</div>
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          {busy ? <button onClick={() => { stopRef.current = true; setRun((r) => ({ ...r, note: "Pausing after the current photo…" })); }}>Pause</button>
            : <button className="primary" disabled={!todo.length || !v.providers.length} onClick={start}>{run.state === "paused" ? "Continue" : `Start — analyze ${todo.length} photo(s)`}</button>}
          {v.results.length > 0 && !busy && <button className="ghost sm" onClick={clearAll}>Clear results</button>}
        </div>
        {run.state !== "idle" && (
          <div className="stack small" style={{ gap: 4 }}>
            <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%`, height: "100%", background: "var(--accent)" }} /></div>
            <div>{run.state === "done" ? `✓ Done — ${run.total} photo(s) analyzed.` : `${run.done} of ${run.total}${run.current ? ` · now: ${run.current}` : ""}${run.state === "running" && run.total > run.done ? ` · about ${Math.ceil(((run.total - run.done) * SPACING_MS) / 2 / 60000 + 0.5)} min left` : ""}`}</div>
            {run.note && <div className="alert warning">{run.note}</div>}
          </div>
        )}
      </div>

      {v.results.length > 0 && (
        <>
          <div className="row between">
            <b>{v.results.length} photo(s) sorted</b>
            <div className="row" style={{ gap: 6 }}>
              <button className="sm" onClick={() => copy(v.text, "all")}>{copied === "all" ? "✓ Copied" : "Copy all"}</button>
              <button className="sm ghost" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([v.text], { type: "text/plain" })); a.download = "photos-by-service.txt"; a.click(); }}>Download .txt</button>
            </div>
          </div>
          {[...special.slice(0, 1), ...groups, ...special.slice(1)].map((g) => {
            const items = by(g);
            if (!items.length) return null;
            const warn = special.includes(g);
            return (
              <div key={g} className="card" style={{ boxShadow: "none", padding: 12, borderLeft: warn ? "4px solid var(--warning)" : undefined }}>
                <div className="row between" style={{ marginBottom: 6 }}>
                  <b>{g} <span className="muted">({items.length})</span></b>
                  <button className="sm ghost" onClick={() => copy(groupText(g), g)}>{copied === g ? "✓" : "Copy"}</button>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  {items.map((r) => (
                    <div key={r.key} className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
                      {thumbs[r.key] ? <img src={thumbs[r.key]} alt="" width={56} height={42} style={{ objectFit: "cover", borderRadius: 4, flex: "none" }} /> : <span style={{ width: 56, flex: "none" }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>• {label(r)} {r.manual && <span className="badge">moved by you</span>}{r.confidence === "medium" && !r.manual && g !== "Needs your check" && <span className="badge warning">medium</span>}</div>
                        {(r.focus || r.why) && <div className="muted">{r.focus}{r.why && r.why !== r.focus ? ` — ${r.why}` : ""}</div>}
                      </div>
                      <select className="sm" style={{ width: 180, flex: "none" }} value={g} onChange={(e) => move(r.key, e.target.value)} title="Move to another group">
                        {[...v.services, ...v.others].map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="muted small">Last result {ago(v.results[v.results.length - 1].at)}. Thumbnails show only for photos analyzed in this browser session.</div>
        </>
      )}
    </div>
  );
}
