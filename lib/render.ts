/**
 * Renders a page in real headless Chrome, like "Inspect element" (not "view source"): scripts run, lazy images load,
 * then the finished DOM is audited. Also takes a screenshot with one element highlighted (for the findings list).
 *
 * Production (Vercel): @sparticuz/chromium. Local/dev: set CHROME_PATH to a Chrome/Chromium binary.
 * The browser only loads the preview page and its normal resources; requests to private/internal addresses are blocked.
 */
import type { Browser, Page } from "puppeteer-core";

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICES: Device[] = ["desktop", "tablet", "mobile"];
const VIEW: Record<Device, { width: number; height: number; mobile: boolean; ua: string }> = {
  desktop: { width: 1366, height: 900, mobile: false, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 DudaPreviewAudit/1.0" },
  tablet: { width: 820, height: 1180, mobile: true, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 DudaPreviewAudit/1.0" },
  mobile: { width: 390, height: 844, mobile: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 DudaPreviewAudit/1.0" },
};

/** Duda previews pick the layout from dm_device — set it so tablet/mobile get their own elements (icons, menus…). */
export function deviceUrl(url: string, device: Device) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("dm_device") || /\/site\/|\/preview\//.test(u.pathname)) u.searchParams.set("dm_device", device);
    return u.toString();
  } catch { return url; }
}

let browserP: Promise<Browser> | null = null;
async function browser(): Promise<Browser> {
  if (browserP) {
    const b = await browserP.catch(() => null);
    if (b && b.connected) return b;
  }
  browserP = (async () => {
    const puppeteer = (await import("puppeteer-core")).default;
    if (process.env.CHROME_PATH) {
      return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });
    }
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true, args: [...chromium.args, "--hide-scrollbars"] });
  })();
  return browserP;
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|metadata\.google\.internal)$/i;
const allowPrivate = () => process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL;

async function openPage(url: string, device: Device): Promise<{ page: Page; status: number; finalUrl: string }> {
  const b = await browser();
  const page = await b.newPage();
  const v = VIEW[device];
  await page.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
  await page.setUserAgent(v.ua);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    let host = "";
    try { host = new URL(req.url()).hostname; } catch { /* data: / blob: */ }
    if (host && PRIVATE_HOST.test(host) && !allowPrivate()) return req.abort().catch(() => {});
    if (["media", "websocket", "eventsource"].includes(req.resourceType())) return req.abort().catch(() => {});
    return req.continue().catch(() => {});
  });
  let navErr = "";
  const res = await page.goto(deviceUrl(url, device), { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => { navErr = (e as Error).message; return null; });
  // the page didn't load at all (connection refused, DNS…): Chrome shows its own error page — never audit that
  if (!res && (page.url().startsWith("chrome-error:") || /net::ERR_/.test(navErr))) {
    await page.close().catch(() => {});
    throw new Error(`Couldn't open the page in Chrome (${(navErr.match(/net::ERR_[A-Z_]+/) || [navErr.slice(0, 80)])[0]})`);
  }
  // scroll through the page so lazy-loaded images, sliders and widgets render, then come back up
  await page.evaluate(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40000; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  return { page, status: res?.status() ?? 0, finalUrl: page.url() };
}

/**
 * Marks text that is nearly invisible — its color is (almost) the same as the background behind it, e.g. white text on a
 * white section ("About Us address text is white and not visible"). Text over a photo / video / background image is
 * skipped (it can't be judged from colors). Marked elements get data-tek-lc="<text color> on <background>".
 */
const MARK_LOW_CONTRAST = `(() => {
  const parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const visuals = [];
  for (const el of document.querySelectorAll("img,video,picture,canvas,iframe,svg")) { const r = el.getBoundingClientRect(); if (r.width > 20 && r.height > 20) visuals.push(r); }
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++n > 6000) break;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== "none") { const r = el.getBoundingClientRect(); if (r.width > 20 && r.height > 20) visuals.push(r); }
  }
  const out = [];
  n = 0;
  for (const el of document.querySelectorAll("p,span,a,li,h1,h2,h3,h4,h5,h6,td,div,strong,b,em,label,button")) {
    if (++n > 5000) break;
    if (![...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 1)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) < 0.1 || parseFloat(cs.fontSize) < 6) continue;
    const fg = parse(cs.color); if (!fg) continue;
    let bg = null, image = false;
    const layers = [];
    for (let x = el; x; x = x.parentElement) {
      const s = getComputedStyle(x);
      if (s.backgroundImage && s.backgroundImage !== "none") { image = true; break; }
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    if (image) continue;
    bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const text = over(fg, bg);
    const L1 = lum(text), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio >= 1.35) continue;
    if (visuals.some((v) => !(v.right < r.left || v.left > r.right || v.bottom < r.top || v.top > r.bottom))) continue; // text over a picture
    out.push(el);
    el.setAttribute("data-tek-lc", "rgb(" + [text.r, text.g, text.b].map(Math.round).join(",") + ") on rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")");
    if (out.length > 40) break;
  }
})()`;

/** The page's finished DOM (after scripts and lazy loading), for one device. */
export async function renderHtml(url: string, device: Device): Promise<{ status: number; finalUrl: string; html: string }> {
  const { page, status, finalUrl } = await openPage(url, device);
  try {
    await page.evaluate(MARK_LOW_CONTRAST).catch(() => {});
    return { status, finalUrl, html: await page.content() };
  } finally { await page.close().catch(() => {}); }
}

/** Screenshot of the area around one element, outlined in red. Falls back to finding the element by its text. */
export async function screenshotElement(url: string, device: Device, selector: string, text: string): Promise<{ png: Uint8Array; found: boolean }> {
  const { page } = await openPage(url, device);
  try {
    const found = await page.evaluate((sel: string, txt: string) => {
      let el: Element | null = null;
      try { if (sel && sel !== "head") el = document.querySelector(sel); } catch { /* bad selector */ }
      const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      if ((!el || !visible(el)) && txt) {
        const t = txt.replace(/…/g, "").trim().slice(0, 60).toLowerCase();
        const all = Array.from(document.body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,a,span,div,img,button,td"));
        el = all.find((e) => visible(e) && ((e.textContent || "").toLowerCase().includes(t) || ((e as HTMLImageElement).src || "").toLowerCase().includes(t)) && !Array.from(e.children).some((c) => (c.textContent || "").toLowerCase().includes(t))) || null;
      }
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:4px solid #e11d48;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.25);z-index:2147483647;pointer-events:none`;
      document.body.appendChild(box);
      return true;
    }, selector, text);
    await new Promise((r) => setTimeout(r, 300));
    const png = await page.screenshot({ type: "png" });
    return { png: new Uint8Array(png), found };
  } finally { await page.close().catch(() => {}); }
}
