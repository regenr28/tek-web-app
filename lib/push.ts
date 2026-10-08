import crypto from "crypto";
import { one, run } from "./db";
import { encrypt, decrypt } from "./secrets";
import { safeFetch } from "./net";

/**
 * Browser push notifications (Web Push) without any third-party account: the app signs with its own VAPID key
 * (generated once, stored encrypted in settings) and encrypts each message for the browser (RFC 8291 / 8292).
 * Works in Chrome, Edge, Firefox and Safari on Mac; on iPhone/iPad only after "Add to Home Screen".
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

/** Push services the browsers use — the only hosts we ever send to. */
export const PUSH_HOSTS = ["fcm.googleapis.com", "*.googleapis.com", "*.push.services.mozilla.com", "web.push.apple.com", "*.push.apple.com", "*.notify.windows.com", "*.wns.windows.com"];
export function validEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && PUSH_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
  } catch { return false; }
}

type Vapid = { publicKey: string; privateJwk: crypto.JsonWebKey };
let cached: Vapid | null = null;

/** The app's VAPID key pair (created on first use). publicKey = the browser's applicationServerKey. */
export async function vapid(): Promise<Vapid> {
  if (cached) return cached;
  const read = async () => { const r = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'vapid'"); return r ? (JSON.parse(decrypt(r.value)) as Vapid) : null; };
  let v = await read();
  if (!v) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const fresh: Vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x!), fromB64u(jwk.y!)])), privateJwk: jwk };
    await run("INSERT INTO settings (key, value) VALUES ('vapid', ?) ON CONFLICT(key) DO NOTHING", [encrypt(JSON.stringify(fresh))]);
    v = (await read()) || fresh; // another request may have created it first
  }
  cached = v;
  return v;
}

/** ES256 JWT for the push service (RFC 8292). */
export function vapidJwt(audience: string, subject: string, privateJwk: crypto.JsonWebKey, now = Date.now()) {
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const body = enc({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
  const key = crypto.createPrivateKey({ key: privateJwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

/**
 * Encrypts one message for a browser subscription ("aes128gcm", RFC 8291).
 * `serverKey` / `salt` are only passed by tests (normally a fresh key pair and salt per message).
 */
export function encryptPayload(plain: Buffer, p256dh: string, auth: string, opts: { serverPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.serverPrivate) ecdh.setPrivateKey(opts.serverPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt || crypto.randomBytes(16);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

export type PushSub = { endpoint: string; p256dh: string; auth: string };
export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/** Sends one notification. Returns the push service's HTTP status (404/410 = the subscription is gone). */
export async function sendPush(sub: PushSub, msg: PushMessage, subject: string): Promise<number> {
  if (!validEndpoint(sub.endpoint)) return 410;
  const v = await vapid();
  const jwt = vapidJwt(new URL(sub.endpoint).origin, subject, v.privateJwk);
  const body = encryptPayload(Buffer.from(JSON.stringify(msg)), sub.p256dh, sub.auth);
  const r = await safeFetch(sub.endpoint, {
    hosts: PUSH_HOSTS, method: "POST", body, timeoutMs: 15000, maxBytes: 100_000, maxRedirects: 0,
    headers: { TTL: String(24 * 3600), Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${jwt}, k=${v.publicKey}` },
  });
  return r.status;
}

/** Contact for the push services (required by Apple): the app's own address. */
export function pushSubject() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  return host ? `https://${host.replace(/^https?:\/\//, "")}` : "mailto:alerts@example.com";
}
