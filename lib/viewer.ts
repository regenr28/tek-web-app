/**
 * "Show on page": the real page (rendered in Chrome for desktop, tablet or mobile) shown inside the app, scrolled to
 * the finding and outlined in red. Something hidden (a closed menu, an accordion, an element hidden on this device)
 * is made visible so you can see it, and the banner says it was hidden.
 *
 * Safety: the page is served from its own address with a strict Content-Security-Policy — none of the site's scripts
 * run, only our small highlighter (by nonce) — and the app shows it in a sandboxed frame (no access to the app).
 */
import * as cheerio from "cheerio";
import { createHash, randomBytes } from "crypto";
import { one, run } from "./db";
import { snapshotHtml, type Device } from "./render";

const TTL_MS = 20 * 60_000;

async function cached(url: string, device: Device): Promise<{ html: string; finalUrl: string }> {
  const k = createHash("sha256").update(`${device}|${url}`).digest("hex");
  const hit = await one<{ html: string; final_url: string; at: number }>("SELECT html, final_url, at FROM view_cache WHERE k = ?", [k]).catch(() => null);
  if (hit && Date.now() - hit.at < TTL_MS) return { html: hit.html, finalUrl: hit.final_url };
  const r = await snapshotHtml(url, device);
  if (r.status >= 400) throw new Error(`The page answered HTTP ${r.status}`);
  await run("INSERT INTO view_cache (k, html, final_url, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET html = excluded.html, final_url = excluded.final_url, at = excluded.at", [k, r.html, r.finalUrl, Date.now()]).catch(() => {});
  await run("DELETE FROM view_cache WHERE at < ?", [Date.now() - TTL_MS]).catch(() => {});
  return { html: r.html, finalUrl: r.finalUrl };
}

export type Target = { selector: string; text: string; file: string; message: string; rule: string; head: boolean; h1: boolean; settings: boolean };

/** The page prepared for the viewer + the CSP header that goes with it. */
export async function viewerPage(url: string, device: Device, t: Target): Promise<{ html: string; csp: string }> {
  const { html, finalUrl } = await cached(url, device);
  const $ = cheerio.load(html);
  // none of the site's own code runs in the viewer
  $("script, iframe[src*='userway' i], meta[http-equiv]").remove();
  $("[onload],[onclick],[onerror],[onmouseover],[onfocus]").each((_, el) => { for (const a of Object.keys((el as { attribs: Record<string, string> }).attribs || {})) if (/^on/i.test(a)) $(el).removeAttr(a); });
  $("base").remove();
  $("head").prepend(`<base href="${finalUrl.replace(/"/g, "&quot;")}">`);
  // lazy images that never got their real address
  $("img[data-src]").each((_, el) => { const s = $(el).attr("data-src"); if (s && (!$(el).attr("src") || /^data:/.test($(el).attr("src") || ""))) $(el).attr("src", s); });
  const nonce = randomBytes(16).toString("base64");
  $("head").append(`<style nonce="${nonce}">${CSS}</style>`);
  $("body").append(`<script nonce="${nonce}">(${HIGHLIGHT.toString()})(${JSON.stringify(t).replace(/</g, "\\u003c")}, ${JSON.stringify(device)});</script>`);
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src * 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src * data:",
    "media-src *",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri *",
    "frame-ancestors 'self'",
    "sandbox allow-scripts allow-popups",
  ].join("; ");
  return { html: $.html(), csp };
}

const CSS = `
.tek-hit{outline:4px solid #e11d48!important;outline-offset:3px!important;box-shadow:0 0 0 9999px rgba(15,23,42,.18),0 0 0 8px rgba(225,29,72,.35)!important;border-radius:4px;position:relative;z-index:2147483000!important;animation:tekpulse 1.2s ease-in-out 3}
@keyframes tekpulse{50%{outline-color:#fb7185}}
#tek-bar{position:fixed;left:0;right:0;top:0;z-index:2147483647;font:600 13px/1.35 system-ui,-apple-system,sans-serif;color:#fff;padding:8px 12px;box-shadow:0 4px 18px rgba(0,0,0,.3)}
#tek-bar small{display:block;font-weight:400;opacity:.9;margin-top:2px}
#tek-tag{position:absolute;z-index:2147483647;background:#e11d48;color:#fff;font:700 11px/1 system-ui,sans-serif;padding:4px 7px;border-radius:4px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)}
#tek-seo{position:fixed;left:12px;right:12px;top:60px;z-index:2147483646;background:#fff;color:#0f172a;border:3px solid #e11d48;border-radius:8px;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)}
#tek-seo b{display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin-top:6px}
`;

/** Runs inside the viewer: find the element, make it visible if it's hidden, scroll to it, outline it. */
function HIGHLIGHT(t: Target, device: string) {
  const norm = (s: string) => (s || "").replace(/…/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const size = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const bar = (text: string, sub: string, color: string) => {
    const b = document.createElement("div"); b.id = "tek-bar"; b.style.background = color;
    b.textContent = text; const s = document.createElement("small"); s.textContent = sub; b.appendChild(s);
    document.body.appendChild(b);
  };
  const tell = (found: boolean, hidden: boolean) => { try { parent.postMessage({ tek: 1, found, hidden }, "*"); } catch (e) { /* ignore */ } };

  if (t.settings) { bar("Not one spot on the page — it's in the site's settings / code", t.message, "#334155"); tell(true, false); return; }
  if (t.h1) {
    const hs = Array.from(document.querySelectorAll(/heading/.test(t.rule) ? "h1,h2,h3,h4,h5,h6" : "h1")) as HTMLElement[];
    hs.forEach((h, i) => { h.classList.add("tek-hit"); const tag = document.createElement("div"); tag.id = "tek-tag"; tag.textContent = h.tagName + (hs.length > 1 ? " #" + (i + 1) : ""); const r = h.getBoundingClientRect(); tag.style.left = Math.max(4, r.left + scrollX) + "px"; tag.style.top = Math.max(4, r.top + scrollY - 22) + "px"; document.body.appendChild(tag); });
    if (hs[0]) hs[0].scrollIntoView({ block: "center" });
    bar(hs.length ? `Headings outlined (${hs.length})` : "No H1 on this page", t.message, "#e11d48"); tell(hs.length > 0, false); return;
  }
  if (t.head) {
    const box = document.createElement("div"); box.id = "tek-seo";
    const add = (label: string, val: string) => { const b = document.createElement("b"); b.textContent = label; box.appendChild(b); const d = document.createElement("div"); d.textContent = val || "(empty)"; box.appendChild(d); };
    add("Meta title", document.title);
    add("Meta description", (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || "");
    const h1 = document.querySelector("h1"); if (h1) add("H1", h1.textContent || "");
    document.body.appendChild(box);
    bar("SEO (page settings)", t.message, "#e11d48"); tell(true, false); return;
  }

  let el: Element | null = null;
  try { if (t.selector && !/^(head|body|html)$/.test(t.selector)) el = document.querySelector(t.selector); } catch (e) { /* bad selector */ }
  const file = norm(t.file);
  if (el && file && el.tagName === "IMG" && !norm((el as HTMLImageElement).src).includes(file)) el = null; // the selector now points to another image
  if (!el && file) el = Array.from(document.images).find((i) => norm(i.currentSrc || i.src).includes(file)) || null;
  const txt = norm(t.text).slice(0, 70);
  if (el && txt && !el.querySelector("img") && el.tagName !== "IMG" && !norm(el.textContent || "").includes(txt.slice(0, 30))) el = null;
  // a form field's value (e.g. the form's send-to email)
  if (!el && txt) { const inp = Array.from(document.querySelectorAll("input[value],textarea")).find((i) => norm((i as HTMLInputElement).value).includes(txt.slice(0, 40))); if (inp) el = inp.closest("form") || inp; }
  if (!el && txt) {
    const all = Array.from(document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,a,span,button,td,th,label,div,strong,em,b"));
    const hits = all.filter((e) => norm(e.textContent || "").includes(txt.slice(0, 60)));
    el = hits.find((e) => !Array.from(e.children).some((k) => norm(k.textContent || "").includes(txt.slice(0, 60)))) || hits[hits.length - 1] || null;
  }
  if (!el) { bar("Couldn't find this exact spot on the " + device + " page", "It may have been fixed already. " + t.message, "#334155"); tell(false, false); return; }

  // hidden on this device / inside a closed menu or accordion → show it
  let hidden = false;
  for (let x: HTMLElement | null = el as HTMLElement; x && x !== document.body; x = x.parentElement) {
    const cs = getComputedStyle(x);
    if (cs.display === "none") { x.style.setProperty("display", /^(LI)$/.test(x.tagName) ? "list-item" : /^(SPAN|A|IMG|STRONG|EM|B)$/.test(x.tagName) ? "inline-block" : "block", "important"); hidden = true; }
    if (cs.visibility === "hidden" || cs.visibility === "collapse") { x.style.setProperty("visibility", "visible", "important"); hidden = true; }
    if (parseFloat(cs.opacity) < 0.15) { x.style.setProperty("opacity", "1", "important"); hidden = true; }
    if ((cs.maxHeight === "0px" || cs.height === "0px") && cs.overflow !== "visible") { x.style.setProperty("max-height", "none", "important"); x.style.setProperty("height", "auto", "important"); x.style.setProperty("overflow", "visible", "important"); hidden = true; }
    if (x.hasAttribute("hidden")) { x.removeAttribute("hidden"); hidden = true; }
    if (cs.transform !== "none" && (x.getBoundingClientRect().right < 0 || x.getBoundingClientRect().left > innerWidth)) { x.style.setProperty("transform", "none", "important"); x.style.setProperty("left", "0", "important"); hidden = true; }
  }
  if (!size(el)) { (el as HTMLElement).style.setProperty("min-width", "24px", "important"); (el as HTMLElement).style.setProperty("min-height", "24px", "important"); (el as HTMLElement).style.setProperty("display", "inline-block", "important"); hidden = true; }
  el.classList.add("tek-hit");
  el.scrollIntoView({ block: "center" });
  const place = () => { const r = el!.getBoundingClientRect(); let tag = document.getElementById("tek-tag"); if (!tag) { tag = document.createElement("div"); tag.id = "tek-tag"; tag.textContent = "▼ here"; document.body.appendChild(tag); } tag.style.left = Math.max(4, r.left + scrollX) + "px"; tag.style.top = Math.max(4, r.top + scrollY - 24) + "px"; };
  place(); setTimeout(() => { el!.scrollIntoView({ block: "center" }); place(); }, 600);
  bar(hidden ? "Found — it was hidden on " + device + " (shown here so you can see it)" : "Found on " + device, t.message, hidden ? "#b45309" : "#e11d48");
  tell(true, hidden);
}
