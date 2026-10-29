/**
 * The logo library: the certification / affiliation / partner logos the designers have ready (the Figma "logos" file).
 * A certification the client asks for that isn't in the library needs a new logo → ask Teodora (Designer).
 *
 * The list is edited in Settings → Logos: paste plain names (one per line, "Group:" lines for groups) or copy the
 * layer rows straight from Figma's layer panel — both are read.
 */

export type Logo = { name: string; group: string };
export const DESIGNER = "Teodora (Designer)";

/** From the Figma layers pasted on 2026-10-29 (the panel showed 40 of its 190 layers — paste the rest in Settings → Logos). */
const SEED: [string, string[]][] = [
  ["Other Memberships/Partnerships", ["NFIB-Member"]],
  ["Other Warranty Related", ["Route-66-logo", "Endurance-logo", "Carvana-logo", "Silverrock-logo", "Carmax-logo", "RepairPal-Certified-logo", "Fidelity-Warranty-Services-logo", "Phoenix-American-logo", "CNA-National-logo", "carShield-logo"]],
  ["Performance Parts", ["GM-Auto-Parts-logo", "motocraft-logo", "mopar-logo", "flf-logo", "csf-logo", "Private-Label-Mfg-logo", "ets-logo", "killer-b-motorsports-logo", "iag-performance-logo", "grimm-speed-logo", "K-N_Plain_Logo", "g-reddy-logo", "perrin-performance-logo", "hawk-performance-logo", "invidia-exhaust-systems-logo", "act-logo", "power-division-logo", "enkei-wheels-logo", "the-driveshaft-shop-logo", "apr-logo", "method-race-wheels-logo", "aem-performance-electronics-logo", "moroso-logo", "wilwood-disk-brakes-logo", "gsa-fleet-logo", "penske-logo"]],
];
export const DEFAULT_LOGOS: Logo[] = SEED.flatMap(([group, names]) => names.map((name) => ({ name, group })));

/** "RepairPal-Certified-logo" → "RepairPal Certified", "K-N_Plain_Logo" → "K&N" */
export function logoLabel(name: string) {
  const t = name.replace(/\.(png|jpe?g|svg|webp|gif)$/i, "").replace(/[-_ ]*(plain[-_ ]*)?logo$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return /^[A-Za-z] [A-Za-z]$/.test(t) ? t.replace(" ", "&") : t;
}

const squash = (x: string) => x.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const wordsOf = (x: string) => x.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean);
function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Words that don't identify a brand ("ASE Certified" and "ASE" are the same logo). */
const GENERIC = /^(certified|certification|approved|member|membership|partner|logo|plain|auto|automotive|repair|facility|shop|services?|inc|llc|co|the|of|and)$/;
const core = (x: string) => wordsOf(x).filter((w) => !GENERIC.test(w));

/** The library logo for a certification / affiliation ("AAA Approved Auto Repair" → the AAA logo), or null. */
export function findLogo(item: string, logos: Logo[]): Logo | null {
  const it = squash(item), iw = core(item), itCore = iw.join("");
  if (!it) return null;
  /** b's words appear together, in order, inside a (from its first word when `start`) */
  const within = (a: string[], b: string[], start = false) => {
    if (!b.length || b.length > a.length) return false;
    for (let i = 0; i + b.length <= a.length; i++) { if (b.every((w, j) => a[i + j] === w)) return true; if (start) break; }
    return false;
  };
  for (const l of logos) {
    const lab = logoLabel(l.name), s = squash(lab), lw = core(lab), c = lw.join("");
    if (!s) continue;
    if (s === it || (c && c === itCore)) return l;
    // the logo's name inside the item ("AAA" in "AAA Approved Auto Repair", "K&N" in "K&N Filters")
    if (within(iw, lw)) return l;
    // the item is the start of the logo's name ("Fidelity" → "Fidelity Warranty Services") — never a lone word like "Warranty"
    if (itCore.length >= 4 && within(lw, iw, true)) return l;
    if (c.length >= 6 && itCore.length >= 6 && lev(c, itCore) <= 1) return l; // "motocraft" (as named in Figma) = Motorcraft
  }
  return null;
}

/** Plain lines ("Group:" starts a group) or rows copied from Figma's layer panel → logos. */
export function parseLogos(text: string): Logo[] {
  const out: Logo[] = [];
  let group = "";
  if (/role="row"|data-testid="layer-row"/.test(text)) {
    for (const row of text.split(/role="row"/).slice(1)) {
      const type = row.match(/data-tooltip="([^"]+)"/)?.[1] || "";
      const name = [...row.matchAll(/>([^<>]+)</g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').trim()).filter(Boolean)[0] || "";
      if (!name) continue;
      if (/^text$/i.test(type)) group = name; else out.push({ name, group });
    }
  } else {
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.replace(/^[-•*\s]+/, "").trim();
      if (!l) continue;
      if (/:$/.test(l)) { group = l.slice(0, -1).trim(); continue; }
      out.push({ name: l, group });
    }
  }
  const seen = new Set<string>();
  return out.filter((l) => { const k = squash(logoLabel(l.name)); if (!k || seen.has(k)) return false; seen.add(k); return true; }).map((l) => ({ name: l.name.slice(0, 120), group: l.group.slice(0, 80) })).slice(0, 1000);
}

/** The library as editable text ("Group:" then one logo per line). */
export function logosText(logos: Logo[]) {
  const lines: string[] = [];
  let g: string | null = null;
  for (const l of logos) { if (l.group !== g) { if (lines.length) lines.push(""); if (l.group) lines.push(`${l.group}:`); g = l.group; } lines.push(l.name); }
  return lines.join("\n");
}

/** Certifications with no logo in the library. */
export function missingLogos(certs: string[], logos: Logo[]) {
  return certs.map((c) => c.trim()).filter(Boolean).filter((c) => !findLogo(c, logos));
}

export const LOGO_NOTE = /^No logo in the library for: /;
/** The Data Collection note for certifications the designers have no logo for (replaces the previous one). */
export function logoNoteFor(value: string, note: string, logos: Logo[]) {
  const miss = missingLogos(value.split(/\n+|;\s*/), logos);
  const kept = note.split("\n").filter((l) => !LOGO_NOTE.test(l));
  if (miss.length) kept.push(`No logo in the library for: ${miss.join(", ")} — ask ${DESIGNER}.`);
  return { note: kept.filter(Boolean).join("\n"), missing: miss };
}

