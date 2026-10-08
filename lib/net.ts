import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";
import { HttpError } from "./security";
import { hostAllowed } from "./policy";

/**
 * Outbound HTTP for the crawler and AI calls, hardened against SSRF:
 *  - only http/https on ports 80/443
 *  - every DNS answer is checked at connect time (blocks private/loopback/metadata IPs and DNS-rebinding)
 *  - redirects are followed manually and each hop is re-checked
 *  - response bodies are size-capped and time-limited
 */

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) blocked.addSubnet(a, p, "ipv6");

// Local testing only (never on Vercel): lets the crawler reach a fixture server on localhost.
const allowPrivate = () => process.env.ALLOW_PRIVATE_FETCH === "1" && !process.env.VERCEL;

export function isBlockedIp(ip: string) {
  if (allowPrivate()) return false;
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) ip = v4mapped[1];
  const fam = net.isIP(ip);
  if (!fam) return true;
  return blocked.check(ip, fam === 4 ? "ipv4" : "ipv6");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
export function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true, order: "ipv4first" }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedIp(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error(`Blocked address for ${hostname}`), { code: "EBLOCKED" }), "");
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup as never, timeout: 10_000 }, headersTimeout: 20_000, bodyTimeout: 20_000 });

export type SafeOpts = {
  /** host patterns the URL (and every redirect) must match; "public" = any public host */
  hosts: string[] | "public";
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  httpsOnly?: boolean;
  /** called for every redirect hop (status, from, to) — used by the domain health check */
  onRedirect?: (status: number, from: string, to: string) => void;
};

export type SafeResponse = { status: number; url: string; headers: Headers; body: Buffer; text: () => string };

function checkUrl(raw: string, o: SafeOpts): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, "Invalid URL"); }
  if (!(u.protocol === "https:" || (u.protocol === "http:" && !o.httpsOnly))) throw new HttpError(400, `Blocked URL scheme: ${u.protocol}`);
  if (u.username || u.password) throw new HttpError(400, "URLs with credentials are not allowed");
  if (u.port && !["80", "443"].includes(u.port) && !allowPrivate()) throw new HttpError(400, "Only ports 80 and 443 are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedIp(host)) throw new HttpError(400, "Blocked address");
  if (o.hosts !== "public" && !hostAllowed(host, o.hosts)) throw new HttpError(400, `${host} isn't an allowed domain`);
  return u;
}

export async function safeFetch(rawUrl: string, o: SafeOpts): Promise<SafeResponse> {
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  let url = checkUrl(rawUrl, o);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
  try {
    for (let hop = 0; ; hop++) {
      const res = await ufetch(url, { method: o.method || "GET", headers: o.headers, body: o.body, redirect: "manual", signal: ctrl.signal, dispatcher: agent });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc || hop >= (o.maxRedirects ?? 5)) throw new HttpError(502, "Too many redirects");
        const next = checkUrl(new URL(loc, url).toString(), o);
        o.onRedirect?.(res.status, url.toString(), next.toString());
        url = next;
        continue;
      }
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > maxBytes) { await res.body?.cancel(); throw new HttpError(413, "Response too large"); }
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > maxBytes) { ctrl.abort(); throw new HttpError(413, "Response too large"); }
          chunks.push(Buffer.from(chunk));
        }
      }
      const body = Buffer.concat(chunks);
      return { status: res.status, url: url.toString(), headers: res.headers as unknown as Headers, body, text: () => body.toString("utf8") };
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "EBLOCKED") throw new HttpError(400, "Blocked: that host resolves to a private network address");
    if ((e as Error).name === "AbortError") throw new HttpError(504, "Request timed out");
    throw new HttpError(502, `Fetch failed: ${cause?.code || (e as Error).message}`.slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}
