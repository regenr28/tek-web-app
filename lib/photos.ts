/**
 * Photo sorting: each photo (sent one at a time from the browser, already shrunk) is looked at by a free vision AI
 * and put under the ONE service it shows. Photos are never stored — only the file name and the result.
 *
 * Rules the AI must follow:
 *  - the service is what the photo is ABOUT (what's being done / the part in focus), not something visible at the edge;
 *  - a part that belongs to a service counts when it's the focus (a drivetrain close-up → "Axle & Drivetrain Service");
 *  - no clear focus, not a service, or unsure → it goes to "Needs your check" instead of a guess.
 * A photo the AI isn't sure about gets a second, yes/no look before it's filed under a service.
 */
import { one, all, run } from "./db";
import { callVision } from "./ai";
import { HttpError } from "./security";
import { parseJson } from "./ai";
import { splitLinesKeep } from "./collect";

export const OTHER = {
  shop: "Shop & Building", team: "Team & People", vehicle: "Customer Vehicles (no service shown)", text: "Flyers, Logos & Text",
  unclear: "Needs your check", failed: "Couldn't open",
} as const;
export const OTHER_LIST = Object.values(OTHER);

export type PhotoResult = {
  key: string; file: string; zip: string; category: string; focus: string; why: string; confidence: "high" | "medium" | "low";
  provider: string; checked?: boolean; manual?: boolean; at: string;
};
export type PhotoState = { services: string[]; results: PhotoResult[] };

const MAX_RESULTS = 6000;

/** Services list lives on the project; each photo's result is its own row (photos are analyzed in parallel). */
export async function getPhotos(siteId: number): Promise<PhotoState> {
  const r = await one<{ photos_json: string | null }>("SELECT photos_json FROM sites WHERE id = ?", [siteId]);
  const s = r?.photos_json ? (JSON.parse(r.photos_json) as { services?: string[] }) : null;
  const rows = await all<{ result: string }>("SELECT result FROM photo_results WHERE site_id = ? ORDER BY rowid LIMIT ?", [siteId, MAX_RESULTS]);
  return { services: s?.services || [], results: rows.map((x) => JSON.parse(x.result) as PhotoResult) };
}
async function putResult(siteId: number, res: PhotoResult) {
  await run("INSERT INTO photo_results (site_id, photo_key, result) VALUES (?, ?, ?) ON CONFLICT(site_id, photo_key) DO UPDATE SET result = excluded.result, updated_at = datetime('now')", [siteId, res.key.slice(0, 600), JSON.stringify(res)]);
}

const SYSTEM = `You sort photos for an auto repair shop's website. You look at ONE photo and say which ONE service it shows.
Be strict and literal:
- First find the FOCUS: what is being done or shown in the middle / in focus / being worked on. Ignore things that are only visible in the background or at the edges.
- The service must BE that focus. Example: a technician doing an oil change while a brake rotor is visible nearby → the service is the oil change, NOT brake repair.
- A part that belongs to a service counts when it is the focus (e.g. a close-up of a drivetrain or axle → "Axle & Drivetrain Service"; a tire on a balancer → a tire service).
- If the photo is the shop/building, staff/people posing, a customer car with no work shown, or a flyer/logo/text graphic, use that OTHER category.
- If you can't tell, or two services are equally the focus, answer "unclear". Never guess.
Reply with JSON only.`;

function prompt(services: string[]) {
  return `SERVICES (pick exactly one name from this list, copied exactly):
${services.map((s) => `- ${s}`).join("\n")}

OTHER categories: "shop" (building, bays, waiting room, equipment with no job), "team" (people posing / staff photos), "vehicle" (a car with no service being done), "text" (flyer, logo, coupon, text graphic), "unclear" (can't tell / no single focus).

Return ONLY JSON:
{"focus":"one short sentence: what is being done or shown, and which part is the focus","service":"exact service name from SERVICES, or empty","other":"shop|team|vehicle|text|unclear or empty","confidence":"high|medium|low","why":"short reason the focus is this service (or why not)"}`;
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

export async function analyzePhoto(siteId: number, inp: { key: string; file: string; zip: string; mime: string; b64: string; services: string[] }): Promise<{ result?: PhotoResult; resting?: number; error?: string }> {
  const services = [...new Set(inp.services.map((s) => s.trim()).filter(Boolean))].slice(0, 80);
  if (!services.length) throw new HttpError(400, "Add the shop's services first (one per line) so photos can be sorted by them.");
  let first;
  try { first = await callVision({ system: SYSTEM, user: prompt(services), image: { mime: inp.mime, b64: inp.b64 } }); }
  catch (e) {
    const m = (e as Error).message;
    const rest = m.match(/^ALL_RESTING (\d+)/);
    if (rest) return { resting: Number(rest[1]) };
    return { error: m.slice(0, 400) };
  }
  const j = parseJson<{ focus?: string; service?: string; other?: string; confidence?: string; why?: string }>(first.text) || {};
  const conf = (["high", "medium", "low"].includes(String(j.confidence)) ? j.confidence : "low") as PhotoResult["confidence"];
  const svc = services.find((s) => norm(s) === norm(String(j.service || "")));
  const otherKey = String(j.other || "").toLowerCase() as keyof typeof OTHER;
  let category: string = svc || (otherKey && otherKey in OTHER && otherKey !== "failed" ? OTHER[otherKey] : OTHER.unclear);
  let why = String(j.why || "").slice(0, 300);
  let checked = false;
  // a service the AI wasn't sure about gets a second, yes/no look; "no" or unsure → you check it
  if (svc && conf !== "high") {
    try {
      const v = await callVision({ system: SYSTEM, image: { mime: inp.mime, b64: inp.b64 }, user:
`Question: is the FOCUS of this photo (what's being done / the part being worked on, not something in the background) "${svc}"?
Return ONLY JSON: {"answer":"yes|no|unsure","focus":"what the focus actually is"}` });
      const a = parseJson<{ answer?: string; focus?: string }>(v.text) || {};
      checked = true;
      if (String(a.answer).toLowerCase() !== "yes") { category = OTHER.unclear; why = `Not sure it's ${svc}: ${String(a.focus || j.focus || "").slice(0, 200)}`; }
    } catch { category = OTHER.unclear; why = `Possibly ${svc} — the second check couldn't run, so please check it.`; }
  }
  if (category === OTHER.unclear && svc && !why.startsWith("Not sure") && !why.startsWith("Possibly")) why = `Possibly ${svc}. ${why}`;
  if (!svc && j.service && category === OTHER.unclear) why = `AI said "${String(j.service).slice(0, 60)}", which isn't one of the services. ${why}`;
  const result: PhotoResult = {
    key: inp.key, file: inp.file.slice(0, 300), zip: inp.zip.slice(0, 200), category, focus: String(j.focus || "").slice(0, 300), why,
    confidence: conf, provider: `${first.provider}:${first.model}`, checked, at: new Date().toISOString(),
  };
  await putResult(siteId, result);
  return { result };
}

/** A photo the browser couldn't open (e.g. HEIC on Chrome) — listed, never silently skipped. */
export async function markFailed(siteId: number, inp: { key: string; file: string; zip: string; reason: string }) {
  await putResult(siteId, { key: inp.key, file: inp.file.slice(0, 300), zip: inp.zip.slice(0, 200), category: OTHER.failed, focus: "", why: inp.reason.slice(0, 300), confidence: "low", provider: "", at: new Date().toISOString() });
}

export async function updatePhotos(siteId: number, body: { services?: string; move?: { key: string; category: string }; clear?: boolean }) {
  if (body.services != null) {
    const services = [...new Set(splitLinesKeep(body.services))].slice(0, 80);
    await run("UPDATE sites SET photos_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify({ services }), siteId]);
  }
  if (body.move) {
    const s = await getPhotos(siteId);
    const r = s.results.find((x) => x.key === body.move!.key);
    if (r && (s.services.includes(body.move.category) || (OTHER_LIST as readonly string[]).includes(body.move.category))) { r.category = body.move.category; r.manual = true; await putResult(siteId, r); }
  }
  if (body.clear) await run("DELETE FROM photo_results WHERE site_id = ?", [siteId]);
  return getPhotos(siteId);
}

/** "Brake Repair\n* image1.jpg\n* image2.jpg\n\n…" — services first (in your order), then the other groups. */
export function photosText(s: PhotoState, withZip: boolean) {
  const groups = [...s.services, ...OTHER_LIST.filter((o) => o !== OTHER.unclear && o !== OTHER.failed), OTHER.unclear, OTHER.failed];
  return groups.map((g) => {
    const items = s.results.filter((r) => r.category === g);
    if (!items.length) return "";
    return `${g}\n${items.map((r) => `* ${withZip ? `${r.zip}/` : ""}${r.file}`).join("\n")}`;
  }).filter(Boolean).join("\n\n");
}
