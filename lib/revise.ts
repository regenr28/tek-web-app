/**
 * "Request a change" on one Data Collection field, in plain words:
 *  - "Make each offer a new line"            → the AI rewrites the current value (no new facts allowed)
 *  - "Search further, I saw one on Google"   → a new web search for that field (socials use the full verified social search)
 *  - "https://www.facebook.com/x is theirs"  → the link you give is used (you're the source)
 * Every change keeps the previous value for Undo, and a note says what was asked and what changed.
 * Anything the AI writes is checked: a price, number, link or email that isn't in the current value, the sources or
 * your request means the change is NOT applied.
 */
import { loadProject, saveProject, jiraRaw } from "./projects";
import { callAI, parseJson } from "./ai";
import { webSearch, type WebResult } from "./search";
import { safeFetch } from "./net";
import { UA } from "./crawl";
import { HttpError } from "./security";
import { FIELDS, LOC_FIELDS, joinNote, splitLinesKeep, domainOf, websiteUrl, type CField, type Collection } from "./collect";
import { stepSearch, composeSocials, evidenceBlock, nameQuery, profileOf, type Evidence } from "./research";

export type ReviseInput = { key: string; loc?: number; request?: string; undo?: boolean };

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const SEARCH_INTENT = /\b(search|find|look(?:\s+(?:for|up|again|online))?|google|scan|online|another|missing|i (?:saw|found|see)|there(?:'s| is) (?:a|one|another)|check (?:again|online|google|their)|research)\b/i;

/** What to add to a search for each field. */
const FIELD_TERMS: Record<string, string> = {
  coupons: "coupon OR special OR offer OR discount", warranties: "warranty OR guarantee", financing: "financing OR \"pay over time\"",
  certifications: "ASE OR certified OR NAPA OR AAA", services: "services", amenities: "amenities OR \"waiting room\" OR shuttle OR loaner",
  about: "about OR history OR \"family owned\" OR established", hours: "hours", phone: "phone", address: "address", email: "email", faq: "FAQ",
  vehicles: "makes models", existingWebsite: "website", domain: "website",
};
/** Which website pages / evidence matter for a field. */
const FIELD_PAGES: Record<string, RegExp> = {
  coupons: /coupon|special|offer|promo/i, warranties: /warrant|guarantee/i, financing: /financ/i, about: /about|history/i, services: /service/i,
  amenities: /amenit|why|benefit/i, faq: /faq/i, certifications: /about|certif/i,
};

/** Prices, numbers, percentages, links and emails in a text (what the AI must not invent). */
function factTokens(t: string): string[] {
  const out = new Set<string>();
  for (const x of t.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) || []) out.add(x.replace(/[\s,]/g, ""));
  for (const x of t.match(/\b\d[\d,]*(?:\.\d+)?%?/g) || []) { const v = x.replace(/,/g, ""); if ((v.replace(/\D/g, "").length >= 2 || v.endsWith("%")) && !out.has(`$${v}`)) out.add(v); }
  for (const x of t.match(URL_RE) || []) out.add(x.toLowerCase().replace(/[/.,;]+$/, ""));
  for (const x of t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []) out.add(x.toLowerCase());
  return [...out];
}
const norm = (t: string) => t.toLowerCase().replace(/,/g, "").replace(/^\$/, "");
/** Details in `next` that appear nowhere in `sources` (compared as whole tokens: "$9.99" is not "$169.99"). */
export function unsupportedFacts(next: string, sources: string): string[] {
  const have = new Set(factTokens(sources).map(norm));
  return factTokens(next).filter((t) => !have.has(norm(t)));
}
/** Details that were in `prev` but are gone from `next`. */
const droppedFacts = (prev: string, next: string) => { const have = new Set(factTokens(next).map(norm)); return factTokens(prev).filter((t) => !have.has(norm(t))); };

const EDIT_SYS = `You edit ONE field of an auto repair shop's website data sheet, exactly as the person asks.
Rules:
- Never invent anything. Every name, price, number, date, link or claim must come from the CURRENT VALUE, the SOURCES or the PERSON'S REQUEST.
- Change only what the request asks; keep everything else as it is.
- Plain text, no markdown, no bullets symbols unless asked. When the request asks for separate lines, put each item on its own line.
- Reply with JSON only.`;

function fieldOf(c: Collection, key: string, loc?: number): { f: CField; label: string } {
  if (loc != null) {
    const L = c.locations[loc];
    const l = LOC_FIELDS.find((x) => x.key === key);
    if (!L || !l) throw new HttpError(400, "Unknown location field");
    return { f: L.fields[l.key], label: `${l.label} (location ${loc + 1})` };
  }
  const l = FIELDS.find((x) => x.key === key);
  if (!l || !c.fields[l.key]) throw new HttpError(400, "Unknown field");
  return { f: c.fields[l.key], label: l.label.replace(/:$/, "") };
}

/** Apply a change to the field: previous value kept for Undo, a note line saying what was asked. */
function apply(f: CField, value: string, source: CField["source"], noteLine: string, status?: CField["status"]) {
  f.prev = f.value;
  f.value = value.trim();
  f.source = source;
  f.manual = true; // research won't overwrite what you asked for
  if (status) f.status = status;
  f.note = joinNote(f.note.split("\n").filter((l) => !/^(Changed|Searched|Added) on your request/.test(l)).join("\n"), noteLine);
}

export async function reviseField(siteId: number, inp: ReviseInput): Promise<{ ok: boolean; summary: string }> {
  const p = await loadProject(siteId);
  const c = p.collection, ev = p.evidence;
  const { f, label } = fieldOf(c, inp.key, inp.loc);

  if (inp.undo) {
    if (f.prev == null) return { ok: false, summary: "Nothing to undo." };
    const cur = f.value;
    f.value = f.prev; f.prev = cur; f.manual = true;
    f.note = joinNote(f.note.split("\n").filter((l) => !/^Undone/.test(l)).join("\n"), "Undone — the previous value is back (Undo again to redo).");
    await saveProject(siteId, c, ev);
    return { ok: true, summary: "Restored the previous value." };
  }

  const req = (inp.request || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!req) throw new HttpError(400, "Type what you want changed");
  const raw = p.jira ? jiraRaw(p.jira.fields) : {};
  const urls = [...new Set(req.match(URL_RE) || [])].map((u) => u.replace(/[.,;]+$/, ""));

  let r: { ok: boolean; summary: string };
  if (inp.key === "socials") r = urls.length || SEARCH_INTENT.test(req) ? await socials(c, ev, raw, f, req, urls, inp.loc) : await rewrite(c, ev, f, label, req, inp.key);
  else if (SEARCH_INTENT.test(req) || urls.length) r = await searchFill(c, ev, f, label, req, urls, inp.key);
  else {
    r = await rewrite(c, ev, f, label, req, inp.key);
    if (!r.ok && r.summary === "NEEDS_SEARCH") r = await searchFill(c, ev, f, label, req, urls, inp.key);
  }
  if (r.ok) await saveProject(siteId, c, ev);
  return r;
}

/** Formatting / wording change on what's already there. */
async function rewrite(c: Collection, ev: Evidence, f: CField, label: string, req: string, key: string): Promise<{ ok: boolean; summary: string }> {
  const evidence = evidenceBlock(ev, FIELD_PAGES[key] || /$^/, 5000, /warrant|financ|certif/.test(key));
  const a = await callAI({ system: EDIT_SYS, json: true, maxTokens: 2500, user:
`FIELD: ${label}
SHOP: ${c.fields.shopName.value}, ${c.fields.cityState.value}

CURRENT VALUE:
${f.value || "(empty)"}

CURRENT NOTE:
${f.note || "(none)"}

PERSON'S REQUEST: ${req}

SOURCES (the only other facts you may use):
${evidence}

Return ONLY JSON: {"value":"the new field value","summary":"one short sentence saying what you changed","needsSearch":false}
If the request needs information that is in neither the CURRENT VALUE nor the SOURCES, return {"value":"","summary":"","needsSearch":true}.` });
  const j = parseJson<{ value?: string; summary?: string; needsSearch?: boolean }>(a.text);
  if (!j) return { ok: false, summary: `The AI (${a.provider}) didn't return a usable answer — try again.` };
  if (j.needsSearch) return { ok: false, summary: "NEEDS_SEARCH" };
  const value = String(j.value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!value && f.value.trim()) return { ok: false, summary: "The AI returned an empty value — nothing changed." };
  if (value === f.value.trim()) return { ok: false, summary: "Nothing to change — the value already matches the request." };
  const bad = unsupportedFacts(value, `${f.value}\n${f.note}\n${req}\n${evidence}`);
  if (bad.length) return { ok: false, summary: `Not applied — the AI added details that aren't in the current value, the sources or your request: ${bad.slice(0, 5).join(", ")}.` };
  const gone = droppedFacts(f.value, value);
  const what = String(j.summary || "rewritten").slice(0, 200);
  apply(f, value, "ai", `Changed on your request (“${req}”): ${what}${gone.length ? ` — no longer includes ${gone.slice(0, 5).join(", ")}` : ""}. Undo restores the previous value.`);
  return { ok: true, summary: `${what}${gone.length ? ` (removed: ${gone.slice(0, 5).join(", ")} — check that's what you wanted)` : ""}` };
}

/** Read a page the person pointed to (public sites only). */
async function readPage(url: string) {
  try {
    const r = await safeFetch(url, { hosts: "public", headers: { "User-Agent": UA, Accept: "text/html" }, timeoutMs: 12000, maxBytes: 2_000_000 });
    if (r.status >= 400) return "";
    return r.text().replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 6000);
  } catch { return ""; }
}

/** New web search for one field, then the AI updates it from what was found (sources cited). */
async function searchFill(c: Collection, ev: Evidence, f: CField, label: string, req: string, urls: string[], key: string): Promise<{ ok: boolean; summary: string }> {
  const name = c.fields.shopName.value;
  const where = c.fields.cityState.value.replace(",", "");
  const words = req.replace(URL_RE, " ").replace(/\b(please|can you|could you|search|find|look|for|up|again|further|more|google|online|i|saw|see|found|one|it|in|on|the|a|an|there|is|their|another|check|research|field|this|that|and|or)\b/gi, " ").replace(/[^\w$%&' -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const terms = FIELD_TERMS[key] || label.toLowerCase();
  const queries = [`${nameQuery(name)} ${where} ${words || terms}`];
  if (words) queries.push(`${nameQuery(name)} ${where} ${terms}`);
  const site = c.fields.existingWebsite.value ? domainOf(websiteUrl(c.fields.existingWebsite.value) || c.fields.existingWebsite.value).replace(/^www\./, "") : "";
  if (site && /\./.test(site)) queries.push(`site:${site} ${words || terms}`);

  const results: WebResult[] = [];
  const errs: string[] = [];
  for (const q of queries) {
    try { const r = await webSearch(q, 8); for (const x of r.results) if (!results.some((y) => y.url === x.url)) results.push(x); }
    catch (e) { errs.push((e as Error).message.slice(0, 120)); }
  }
  const pages = (await Promise.all(urls.slice(0, 3).map(async (u) => ({ url: u, text: await readPage(u) })))).filter((x) => x.text);
  if (!results.length && !pages.length) return { ok: false, summary: `The search found nothing${errs.length ? ` (${errs[0]})` : ""}. Nothing changed.` };

  const found = [
    ...pages.map((x) => `[${x.url}] (page you gave)\n${x.text}`),
    ...results.slice(0, 16).map((r) => `[${r.url}] ${r.title} — ${r.snippet.slice(0, 300)}`),
  ].join("\n\n");
  const a = await callAI({ system: EDIT_SYS, json: true, maxTokens: 2500, user:
`FIELD: ${label}
SHOP: ${name}, ${c.fields.cityState.value}${site ? ` (website ${site})` : ""}

CURRENT VALUE:
${f.value || "(empty)"}

PERSON'S REQUEST: ${req}

SEARCH RESULTS / PAGES (only use results that are clearly about THIS shop — same name and city/phone/address/website):
${found}

Update the field following the request, using only the CURRENT VALUE and the results above.
Return ONLY JSON: {"value":"the new field value (unchanged if nothing reliable was found)","summary":"one short sentence of what you found/changed","sources":["urls you used"]}` });
  const j = parseJson<{ value?: string; summary?: string; sources?: string[] }>(a.text);
  if (!j) return { ok: false, summary: `The AI (${a.provider}) didn't return a usable answer — try again.` };
  const value = String(j.value ?? "").replace(/\r\n?/g, "\n").trim();
  const srcs = (Array.isArray(j.sources) ? j.sources : []).map(String).filter((u) => found.includes(u)).slice(0, 5);
  if (!value || value === f.value.trim()) return { ok: false, summary: `${String(j.summary || "Nothing reliable found for this shop")}. Nothing changed.` };
  const bad = unsupportedFacts(value, `${f.value}\n${req}\n${found}`);
  if (bad.length) return { ok: false, summary: `Not applied — the AI added details that aren't in the search results or your request: ${bad.slice(0, 5).join(", ")}.` };
  const what = String(j.summary || "updated from search").slice(0, 200);
  apply(f, value, "search", `Searched on your request (“${req}”): ${what}${srcs.length ? ` Sources: ${srcs.join(", ")}` : ""}. Confirm before using. Undo restores the previous value.`, "review");
  return { ok: true, summary: what };
}

/** Socials: links you give are used; otherwise the full social search runs again with your hint, and every new profile still needs proof. */
async function socials(c: Collection, ev: Evidence, raw: Record<string, string>, f: CField, req: string, urls: string[], loc?: number): Promise<{ ok: boolean; summary: string }> {
  const before = new Set(splitLinesKeep(f.value).map((u) => profileOf(u)?.key).filter(Boolean));
  const prev = f.value;
  const L = loc ?? 0;
  // keep links the person typed in themselves
  if (f.manual) {
    for (const u of splitLinesKeep(f.value)) if (profileOf(u) && !(ev.socialFinds || []).some((x) => profileOf(x.url)?.key === profileOf(u)?.key))
      (ev.socialFinds ||= []).push({ url: u, reason: "you typed it in", loc: L, via: "you" });
    f.manual = false;
  }
  const given = urls.filter((u) => profileOf(u));
  for (const u of given) {
    ev.socialFinds = (ev.socialFinds || []).filter((x) => profileOf(x.url)?.key !== profileOf(u)?.key);
    ev.socialFinds.push({ url: u, reason: `you added it (“${req.slice(0, 80)}”)`, loc: L, via: "you" });
  }
  let searched = "";
  if (SEARCH_INTENT.test(req.replace(URL_RE, " "))) {
    const name = c.fields.shopName.value;
    const loc1 = c.locations[L];
    const where = loc1 ? `${loc1.city} ${loc1.state}` : c.fields.cityState.value.replace(",", "");
    const plats = [["facebook", /facebook|\bfb\b/i], ["instagram", /instagram|\binsta|\big\b/i], ["yelp", /yelp/i], ["youtube", /youtube/i], ["tiktok", /tik ?tok/i], ["linkedin", /linkedin/i]] as const;
    const wanted = plats.filter(([, re]) => re.test(req)).map(([p]) => p);
    const extra = wanted.length ? wanted.map((p) => `${nameQuery(name)} ${where} site:${p}.com`) : [`${nameQuery(name)} ${where} facebook OR instagram OR yelp OR tiktok OR youtube`, `${nameQuery(name)} ${where} site:facebook.com`];
    extra.push(`${nameQuery(name)} ${where} ${req.replace(URL_RE, " ").slice(0, 80)}`);
    try { searched = await stepSearch(c, ev, raw, { extraQueries: extra }); } catch (e) { searched = `search failed: ${(e as Error).message.slice(0, 120)}`; }
  }
  composeSocials(c, ev);
  const tf = loc != null && c.locations[loc] ? c.locations[loc].fields.socials : c.fields.socials;
  const added = splitLinesKeep(tf.value).filter((u) => !before.has(profileOf(u)?.key));
  if (!added.length) {
    tf.note = joinNote(tf.note, `Searched on your request (“${req}”): no new profile could be confirmed for this shop.${searched ? ` (${searched})` : ""}`);
    return { ok: true, summary: `No new profile could be confirmed${searched ? ` — ${searched}` : ""}. If you found one, paste its link in the request and it will be added.` };
  }
  tf.prev = prev;
  tf.note = joinNote(tf.note.split("\n").filter((l) => !/^(Searched|Added) on your request/.test(l)).join("\n"), `Added on your request (“${req}”): ${added.join(" · ")}. Undo restores the previous list.`);
  return { ok: true, summary: `Added ${added.length}: ${added.join(", ")}` };
}
