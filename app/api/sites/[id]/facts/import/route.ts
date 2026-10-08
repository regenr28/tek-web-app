import { handle, requireUser, HttpError } from "@/lib/auth";
import { idOf, type Ctx } from "@/lib/http";
import { parseUpload } from "@/lib/parse";
import { rateLimit } from "@/lib/security";
import { extractFacts, normalizeFacts, emptyFacts } from "@/lib/facts";
import { aiExtractFacts } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Parses a Jira export and returns suggested facts. Nothing is saved until the user reviews and clicks Save. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser("member", { area: "projects" });
  await idOf(ctx);
  await rateLimit(`import:${me.id}`, 60, 3600);
  if (Number(req.headers.get("content-length") || 0) > 4.5 * 1024 * 1024) throw new HttpError(413, "Upload is larger than 4 MB");
  const form = await req.formData();
  const file = form.get("file");
  const pasted = String(form.get("text") || "").slice(0, 60000);
  const useAi = form.get("ai") === "1";
  let text = pasted, rows: string[][] = [], source = "Pasted text";
  if (file instanceof File && file.size) {
    if (file.size > 4 * 1024 * 1024) throw new HttpError(413, "File is larger than 4 MB");
    const parsed = await parseUpload(file);
    text = parsed.text + (pasted ? "\n\n" + pasted : "");
    rows = parsed.rows;
    source = file.name.replace(/[^\w .()-]/g, "_").slice(0, 120);
  }
  if (!text.trim()) throw new HttpError(400, "Upload a Jira PDF/XLSX/CSV or paste text");
  let facts = extractFacts(text, rows);
  let aiNote = "";
  if (useAi) {
    try {
      const ai = await aiExtractFacts(text);
      if (ai) facts = mergeFacts(normalizeFacts(ai), facts);
    } catch (e) { aiNote = `AI extraction failed, used rule-based extraction instead: ${(e as Error).message}`; }
  }
  return Response.json({ facts, text: text.slice(0, 60000), source, aiNote });
});

function mergeFacts(a: ReturnType<typeof emptyFacts>, b: ReturnType<typeof emptyFacts>) {
  const u = <T,>(x: T[], y: T[], key: (v: T) => string) => { const m = new Map<string, T>(); [...x, ...y].forEach((v) => { const k = key(v); if (k && !m.has(k)) m.set(k, v); }); return [...m.values()]; };
  return {
    ...b, ...a,
    businessName: a.businessName || b.businessName,
    phones: u(a.phones, b.phones, (p) => p.replace(/\D/g, "").slice(-10)),
    emails: u(a.emails, b.emails, (e) => e.toLowerCase()),
    locations: a.locations.length ? a.locations : b.locations,
    hours: a.hours.length ? a.hours : b.hours,
    socials: u(a.socials, b.socials, (s) => s.url.toLowerCase()),
    services: u(a.services, b.services, (s) => s.toLowerCase()),
    citiesServed: u(a.citiesServed, b.citiesServed, (s) => s.toLowerCase()),
    custom: u(a.custom, b.custom, (c) => c.key.toLowerCase()),
    websiteDomain: a.websiteDomain || b.websiteDomain,
  };
}
