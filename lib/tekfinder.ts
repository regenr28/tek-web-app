/**
 * "Tek Finder" — a tiny Chrome extension (no server, no network access, only the "storage" permission).
 *
 * The app's "✏️ Open in Duda editor" button opens  https://my.duda.co/home/site/<id>/<page>#tekfind=<finding>.
 * The extension reads that #tekfind=… as the editor loads, keeps it for 3 minutes, and in every frame of the editor
 * (the site canvas is an iframe) looks for the element: by its CSS selector, else by its text / image file name.
 * When found it scrolls to it and outlines it in red. Nothing leaves the browser.
 */
import { zipSync, strToU8 } from "fflate";

export const TEK_FINDER_VERSION = "1.0.0";

const MANIFEST = {
  manifest_version: 3,
  name: "Tek Finder",
  version: TEK_FINDER_VERSION,
  description: "Opens a Tek Website Monitoring finding inside the Duda editor: scrolls to it and outlines it in red.",
  permissions: ["storage"],
  content_scripts: [{
    matches: ["https://*.duda.co/*", "https://*.dudaone.com/*", "https://*.multiscreensite.com/*", "https://*.dudamobile.com/*", "https://*.tekmetric.site/*"],
    js: ["content.js"],
    all_frames: true,
    match_about_blank: true,
    run_at: "document_start",
  }],
};

const CONTENT = String.raw`(() => {
  const KEY = "tekfind";
  const isTop = window === window.top;
  const MAX_AGE = 3 * 60 * 1000;

  // 1) the editor tab was opened from the app: remember the finding, then tidy the address bar
  if (isTop) {
    const m = location.hash.match(/tekfind=([^&]+)/);
    if (m) {
      let f = null;
      try { f = JSON.parse(decodeURIComponent(m[1])); } catch (e) {}
      if (f && typeof f === "object") {
        chrome.storage.local.set({ [KEY]: { s: String(f.s || "").slice(0, 600), t: String(f.t || "").slice(0, 200), p: String(f.p || "").slice(0, 200), d: String(f.d || "").slice(0, 20), m: String(f.m || "").slice(0, 200), at: Date.now() } });
        try { history.replaceState(history.state, "", location.href.replace(/#.*$/, "")); } catch (e) {}
      }
    }
  }

  // only search frames that show the website itself (Duda pages have #dmRoot / .dmBody), never the editor's own panels
  const isSite = () => !!document.querySelector("#dmRoot, .dmBody, .dmRespRow, #dm, .dmInner");
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function find(f) {
    let el = null;
    try { if (f.s && f.s !== "head" && f.s !== "header") el = document.querySelector(f.s); } catch (e) {}
    if (el && vis(el)) return el;
    const t = (f.t || "").replace(/…/g, "").replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase();
    if (!t) return el;
    for (const img of document.images) if ((img.currentSrc || img.src || "").toLowerCase().includes(t) && vis(img)) return img;
    const all = document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,a,span,button,td,div");
    for (const e of all) {
      const tx = (e.textContent || "").replace(/\s+/g, " ").toLowerCase();
      if (vis(e) && tx.includes(t) && ![...e.children].some((k) => (k.textContent || "").replace(/\s+/g, " ").toLowerCase().includes(t))) return e;
    }
    return el;
  }
  function note(text, ok) {
    const n = document.createElement("div");
    n.textContent = text;
    n.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,90vw);padding:10px 14px;border-radius:8px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);background:" + (ok ? "#e11d48" : "#334155");
    document.documentElement.appendChild(n);
    setTimeout(() => n.remove(), 9000);
  }
  function mark(el, f) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const o = el.style.outline, oo = el.style.outlineOffset;
    el.style.outline = "4px solid #e11d48"; el.style.outlineOffset = "3px";
    setTimeout(() => { el.style.outline = o; el.style.outlineOffset = oo; }, 15000);
    note("Tek: " + (f.m || "here it is"), true);
  }

  let tries = 0, warned = false;
  async function tick() {
    let f;
    try { f = (await chrome.storage.local.get(KEY))[KEY]; } catch (e) { return; }
    if (!f || Date.now() - f.at > MAX_AGE) return;
    if (isTop && !warned && f.d && f.d !== "desktop") { warned = true; note("Tek: this finding shows on " + f.d + " — switch the editor to the " + f.d + " view", false); }
    if (isSite()) {
      const el = find(f);
      if (el) { mark(el, f); chrome.storage.local.remove(KEY); return; }
    }
    if (++tries < 60) setTimeout(tick, 1000);
    else if (isTop) note("Tek: couldn't find it on this page" + (f.p ? " (" + f.p + ")" : "") + " — it may be fixed already, or on another device view.", false);
  }
  const start = () => setTimeout(tick, 1200);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  chrome.storage.onChanged.addListener((c) => { if (c[KEY] && c[KEY].newValue) { tries = 0; setTimeout(tick, 600); } });
})();
`;

const README = `Tek Finder — install once (free, about 1 minute)

1. Unzip this file. You get a folder "tek-finder".
2. In Chrome open  chrome://extensions
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and choose the "tek-finder" folder.

Then, in the app, click "✏️ Open in Duda editor" on a finding: the editor opens on that page, scrolls to the spot and
outlines it in red. The extension only reads the page you open from the app; it has no network access and sends nothing.
`;

/** The extension as a .zip (folder "tek-finder/"). */
export function tekFinderZip(): Uint8Array {
  return zipSync({
    "tek-finder/manifest.json": strToU8(JSON.stringify(MANIFEST, null, 2)),
    "tek-finder/content.js": strToU8(CONTENT),
    "tek-finder/README.txt": strToU8(README),
  }, { level: 6 });
}

/** For tests: the content script source. */
export const TEK_FINDER_CONTENT = CONTENT;
