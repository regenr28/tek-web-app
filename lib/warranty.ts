/**
 * Finding a shop's warranty in website text — kept separate so it can be tested on its own.
 *
 * Page text is read block by block (each heading, paragraph and list item on its own line), so a list like
 *   • Trusted by 900 customers  • Backed by a 3 Years /36,000 Miles warranty on all services  • Certified technicians
 * gives the warranty line by itself instead of one long run-on "sentence" that gets thrown away.
 */
import type * as cheerio from "cheerio";

/** Elements that start a new line of text. */
const BLOCKS = "p,div,li,h1,h2,h3,h4,h5,h6,td,th,tr,section,article,header,footer,ul,ol,dt,dd,address,blockquote,figcaption,label,button,option,table,main,aside";

/** The page's visible text as separate lines (one per heading / paragraph / list item). Removes scripts etc. from `$`. */
export function textLines($: cheerio.CheerioAPI): string[] {
  $("script,style,noscript,svg,iframe,template").remove();
  $("br").replaceWith("\n");
  $(BLOCKS).each((_, el) => { $(el).prepend("\n").append("\n"); });
  return ($("body").text() || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1);
}

/** Privacy policy, terms, accessibility… — their "guaranteed" / "warranty" wording is legal text, never the shop's warranty. */
export const LEGAL_PAGE = /(privacy|terms|conditions|legal|accessibility|cookie|disclaimer|policy|policies|sitemap|ada-compliance|gdpr|ccpa)/i;

/** Text that is legal / data wording, or about someone else's warranty (a manufacturer's, an extended warranty company…). */
const NOT_SHOP_WARRANTY = /\b(secure|security|privacy|personal (data|information)|cookies?|accura(te|cy)|uninterrupted|error[- ]free|merchantability|fitness for a particular purpose|as is|without warrant|no warrant|disclaim|implied warrant|express or implied)\b/i;
const THIRD_PARTY = /\b(manufacturer|factory|dealer(ship)?s?|void(s|ed|ing)?|extended warrant|powertrain|bumper[- ]to[- ]bumper|new (cars?|vehicles?) (come|comes|usually|typically)|car ?shield|endurance)\b/i;
const SHOP_VOICE = /\b(our|we|we're|we are|us|backed by|on all (our )?(services|repairs|work|parts)|comes? with|includes?|offer(s|ed)?|provide[sd]?|stand behind|guaranteed for)\b/i;
const WARRANTY_CONTEXT = /\b(parts?|labou?r|workmanship|months?|years?|miles?|nationwide|lifetime|satisfaction|repairs?|services?)\b/i;

/** Lines / sentences that state the shop's warranty or guarantee, each with the page it came from: "… (https://…)". */
export function warrantySnippets(lines: string[], url: string): string[] {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep */ }
  if (LEGAL_PAGE.test(path)) return [];
  const out: string[] = [];
  for (const line of lines) {
    if (!/warrant|guarantee|peace of mind/i.test(line)) continue;
    // a long line is split into sentences; a very long sentence is cut to the words around "warranty"
    const parts = line.length <= 320 ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/);
    for (let s of parts) {
      if (s.length > 320) {
        const i = s.search(/warrant|guarantee|peace of mind/i);
        s = s.slice(Math.max(0, i - 160), i + 160).replace(/^\S*\s/, "").replace(/\s\S*$/, "");
      }
      s = s.trim();
      if (s.length < 15 || !/warrant|guarantee|peace of mind/i.test(s)) continue;
      if (NOT_SHOP_WARRANTY.test(s)) continue;
      // "guarantee" alone is often marketing or legal text — it must be about parts / labor / time / miles / satisfaction
      if (!/warrant/i.test(s) && !WARRANTY_CONTEXT.test(s)) continue;
      if (THIRD_PARTY.test(s) && !/backed by|our (\w+ )?(warranty|guarantee)|we (offer|provide|back|stand)/i.test(s)) continue;
      if (!(warrantyTerms(s) || /nationwide|lifetime|parts (and|&) labou?r|peace of mind|\d/i.test(s))) continue;
      if (!SHOP_VOICE.test(s) && !warrantyTerms(s)) continue;
      out.push(`${s} (${url})`);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, eighteen: 18, "twenty-four": 24, "thirty-six": 36 };
const num = (s: string) => NUM_WORDS[s.toLowerCase()] ?? Number(s);
const unitWord = (n: number, unit: string) => (/^y/i.test(unit) ? (n === 1 ? "Year" : "Years") : n === 1 ? "Month" : "Months");

/**
 * The warranty terms in a sentence, written the sheet's way:
 *   "Backed by a 3 Years years /36,000 Miles miles warranty on all services" → "3 Years / 36,000 Miles Warranty"
 *   "24-month/24,000-mile nationwide warranty" → "24 Months / 24,000 Miles Nationwide Warranty"
 *   "Lifetime warranty on brake pads" → "Lifetime Warranty"
 * null when no terms are stated.
 */
export function warrantyTerms(sentence: string): { value: string; quote: string } | null {
  const s0 = sentence.replace(/\s\(https?:[^)]*\)$/, "");
  // "3 Years years", "36,000 Miles miles" (template text doubled the unit)
  const s = s0.replace(/\b(years?|months?|miles?)\s+\1\b/gi, "$1").replace(/\s+/g, " ");
  const N = "(\\d{1,3}|one|two|three|four|five|six|twelve|eighteen|twenty-four|thirty-six)";
  const dur = new RegExp(`\\b${N}[\\s-]*(years?|yrs?\\.?|months?|mos?\\.?|mo\\.)(?![a-z])`, "i");
  const miles = /(\d{1,3}(?:,\d{3})+|\d{1,3}\s?k|\d{4,6})\s*-?\s*(?:miles?|mi\.?)(?![a-z])|\bunlimited\s+(?:miles?|mileage)\b/i;
  const nationwide = /\bnation[- ]?wide\b/i.test(s);
  const partsLabor = /\bparts\s*(?:and|&)\s*labou?r\b/i.test(s);
  const extras = (base: string) => `${base}${nationwide ? " Nationwide" : ""} Warranty${partsLabor ? " (Parts & Labor)" : ""}`;
  const d = s.match(dur);
  const m = s.match(miles);
  if (d) {
    const n = num(d[1]);
    if (!n || n > 120) return null;
    const durText = `${n} ${unitWord(n, d[2])}`;
    // the miles must belong to this warranty (close to the duration), not another number on the line
    if (m && Math.abs((m.index ?? 0) - (d.index ?? 0)) <= 40) {
      const milesText = /unlimited/i.test(m[0]) ? "Unlimited Miles" : (() => {
        const raw = m[1].replace(/\s/g, "").toLowerCase();
        const v = raw.endsWith("k") ? Number(raw.slice(0, -1)) * 1000 : Number(raw.replace(/,/g, ""));
        return `${v.toLocaleString("en-US")} Miles`;
      })();
      return { value: extras(`${durText} / ${milesText}`), quote: s0.trim() };
    }
    if (/warrant|guarantee/i.test(s)) return { value: extras(durText), quote: s0.trim() };
  }
  if (/\blifetime\b[^.]{0,30}\b(warrant|guarantee)/i.test(s)) return { value: `Lifetime${nationwide ? " Nationwide" : ""} Warranty${partsLabor ? " (Parts & Labor)" : ""}`, quote: s0.trim() };
  return null;
}

/** "… text … (https://site/page)" → the URL at the end. */
export const snippetUrl = (s: string) => s.match(/\((https?:[^)]*)\)$/)?.[1] || "";
