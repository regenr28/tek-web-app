/**
 * Shop hours — formatted and compared by code, never by AI.
 *
 * Jira is the source of truth. We only reformat what Jira says. If any part of the Jira text can't be
 * read with certainty (no days given, a time we can't place, a word we don't understand), we keep the
 * Jira text exactly as written and flag it for review instead of guessing.
 */
import type { Day } from "./facts";

const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const SHORT: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export type Span = [number, number]; // minutes from midnight
export type DaySlot = { closed?: boolean; text?: string; spans: Span[] }; // text = "By Appointment" / "Open 24 Hours"
export type WeekHours = Partial<Record<Day, DaySlot>>;
export type ReadResult = { ok: true; week: WeekHours; lunch: Span | null } | { ok: false; why: string };

const DAY_RE = "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?";
const dayOf = (s: string): Day => DAYS.find((d) => s.toLowerCase().startsWith(d))!;
const NUM = "\\d{1,2}(?::\\d{2})?(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?|a(?![a-z])|p(?![a-z])))?";
const RANGE = new RegExp(`(${NUM})\\s*(?:-|to|until|till)\\s*(${NUM})`, "gi");
const LEFTOVER_TIME = /\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|\b\d{1,2}\s*-\s*\d{1,2}\b/i;

function normalize(text: string) {
  return (" " + text + " ")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\bnoon\b/g, "12 pm").replace(/\bmidnight\b/g, "12 am")
    .replace(/\bm\s*-\s*f\b/g, "mon-fri").replace(/\bm\s*-\s*sat?\b/g, "mon-sat")
    .replace(/\bweekdays\b/g, "mon-fri").replace(/\bweekends?\b/g, "sat-sun")
    .replace(/\b(?:daily|every day|7 days(?: a week)?)\b/g, "mon-sun")
    .replace(/\b(thru|through)\b/g, "-")
    .replace(/\s+/g, " ");
}

type T = { h: number; m: number; ap: "am" | "pm" | "" };
function tok(s: string): T | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(?:(a|p)(?:\.?m\.?)?(?![a-z]))?/i);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 24 || mi > 59) return null;
  return { h, m: mi, ap: m[3] ? (m[3].toLowerCase() === "a" ? "am" : "pm") : "" };
}
const toMin = (h: number, m: number, ap: "am" | "pm") => ((h % 12) + (ap === "pm" ? 12 : 0)) * 60 + m;

/** A start–end pair; bare numbers ("8-5") are placed the way shop hours are written (8 → AM, 5 → PM). */
function readRange(a: string, b: string): Span | null {
  const s = tok(a), e = tok(b);
  if (!s || !e) return null;
  if (s.h > 12 || e.h > 12) { // 24-hour clock
    if (s.ap || e.ap) return null;
    const st = s.h * 60 + s.m, en = e.h * 60 + e.m;
    return en > st ? [st, en] : null;
  }
  let sap = s.ap, eap = e.ap;
  // start without AM/PM: 5–11 → AM (shops open in the morning), 12 → noon, 1–4 → PM (afternoon half of split hours)
  if (!sap) sap = eap === "am" ? "am" : s.h === 12 ? "pm" : s.h >= 5 ? "am" : "pm";
  if (!eap) {
    if (e.h === 12 || sap === "pm") eap = "pm";
    else if ((e.h % 12) < (s.h % 12)) eap = "pm"; // "8-5" → 5 PM
    else return null; // "8-11" could be AM or PM — don't guess
  }
  const st = toMin(s.h, s.m, sap as "am" | "pm"), en = toMin(e.h, e.m, eap as "am" | "pm");
  return en > st ? [st, en] : null;
}

/** Read the Jira hours text. Fails (instead of guessing) when anything is unclear. */
export function readHours(text: string, _swapped = false): ReadResult {
  const raw = (text || "").trim();
  if (!raw) return { ok: false, why: "No hours in Jira." };
  let t = normalize(raw);

  // "closed for lunch 12-1" / "lunch 12-1"
  let lunch: Span | null = null;
  t = t.replace(new RegExp(`\\(?\\s*(?:closed\\s*(?:for|during)?\\s*)?lunch(?:\\s*(?:break|hour))?\\s*(?:from|is|:)?\\s*(${NUM})\\s*(?:-|to)\\s*(${NUM})\\s*\\)?`, "gi"), (_all, a, b) => {
    const r = readRange(a, b); if (r) lunch = r; return r ? " ; " : _all;
  });

  // day groups: "mon-fri", "mon, wed & fri", "saturday"
  const GROUP = new RegExp(`${DAY_RE}(?:\\s*-\\s*${DAY_RE})?(?:\\s*(?:,|&|and|\\/)\\s*${DAY_RE}(?:\\s*-\\s*${DAY_RE})?)*`, "gi");
  const groups = [...t.matchAll(GROUP)];
  if (!groups.length) return { ok: false, why: "Jira doesn't say which days these hours are for." };
  if (LEFTOVER_TIME.test(t.slice(0, groups[0].index))) {
    // "7:30am - 5:30pm, M-F" / "8-5 M-F, 8-12 Sat": times written before the days → put each time after its days and read again
    if (_swapped) return { ok: false, why: "Jira lists times before naming the days." };
    const items = [...[...t.matchAll(RANGE)].map((m) => ({ k: "t" as const, i: m.index!, s: m[0] })), ...groups.map((m) => ({ k: "d" as const, i: m.index!, s: m[0] }))]
      .sort((a, b) => a.i - b.i);
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i += 2) {
      if (items[i]?.k !== "t" || items[i + 1]?.k !== "d") return { ok: false, why: "Jira lists times before naming the days, in a way that can't be read for sure." };
      pairs.push(`${items[i + 1].s} ${items[i].s}`);
    }
    // nothing else may be left over (only separators / filler words)
    let rest = t;
    for (const it of items) rest = rest.replace(it.s, " ");
    if (/[a-z0-9]/i.test(rest.replace(/\b(open|from|hours?|and|on|daily)\b/g, " "))) return { ok: false, why: `Didn't understand "${rest.replace(/[\s,;|.]+/g, " ").trim()}" in the Jira hours.` };
    const lunchPart = lunch ? ` ; closed for lunch ${fmtTime(lunch[0])}-${fmtTime(lunch[1])}` : "";
    return readHours(pairs.join(" ; ") + lunchPart, true);
  }

  const week: WeekHours = {};
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const body = t.slice(g.index! + g[0].length, gi + 1 < groups.length ? groups[gi + 1].index : t.length);
    // days in this group
    const days: Day[] = [];
    for (const part of g[0].split(/\s*(?:,|&|\band\b|\/)\s*/)) {
      const ends = part.split(/\s*-\s*/).filter(Boolean);
      if (!ends.length) continue;
      const d1 = dayOf(ends[0].trim()), d2 = dayOf((ends[1] || ends[0]).trim());
      if (!d1 || !d2) return { ok: false, why: `Couldn't read the days "${part}".` };
      let i = DAYS.indexOf(d1); const j = DAYS.indexOf(d2);
      for (let n = 0; n < 7; n++) { days.push(DAYS[i]); if (i === j) break; i = (i + 1) % 7; }
    }
    // what's after the days
    let slot: DaySlot | null = null;
    const spans: Span[] = [];
    let rest = body.replace(RANGE, (all, a, b) => { const r = readRange(a, b); if (r) { spans.push(r); return " "; } return all; });
    if (spans.length) slot = { spans: spans.sort((x, y) => x[0] - y[0]) };
    else if (/\bclosed\b/.test(rest)) { slot = { closed: true, spans: [] }; rest = rest.replace(/\bclosed\b/, " "); }
    else if (/by appointment/.test(rest)) { slot = { text: "By Appointment", spans: [] }; rest = rest.replace(/by appointment(?: only)?/, " "); }
    else if (/24 ?(?:hours|hrs)/.test(rest)) { slot = { text: "Open 24 Hours", spans: [] }; rest = rest.replace(/(?:open )?24 ?(?:hours|hrs)/, " "); }
    if (LEFTOVER_TIME.test(rest)) return { ok: false, why: `Couldn't read the time "${rest.trim()}".` };
    // anything left must be filler words only
    const left = rest.replace(/\b(open|opens|from|hours?|are|is|we|on|at|the|shop|and|&|,|;|:|\.|\(|\)|-|\/)\b/g, " ").replace(/[,;:.()&/|\-]/g, " ").trim();
    if (left) return { ok: false, why: `Didn't understand "${left}" in the Jira hours.` };
    if (!slot) {
      // "Mon-Fri & Sat 8-5": days with no time of their own share the next group's time — only when joined directly
      if (!body.trim() || /^\s*(?:,|&|and)\s*$/.test(body)) { (week as Record<string, unknown>)[`__pending_${gi}`] = days; continue; }
      return { ok: false, why: `No time given for ${days.map((d) => SHORT[d]).join(", ")}.` };
    }
    // earlier groups that were waiting for a time
    for (const k of Object.keys(week).filter((k) => k.startsWith("__pending_"))) {
      for (const d of (week as Record<string, unknown>)[k] as Day[]) days.unshift(d);
      delete (week as Record<string, unknown>)[k];
    }
    for (const d of days) {
      if (week[d] && JSON.stringify(week[d]) !== JSON.stringify(slot)) return { ok: false, why: `Jira gives two different times for ${SHORT[d]}.` };
      week[d] = slot;
    }
  }
  if (Object.keys(week).some((k) => k.startsWith("__pending_"))) return { ok: false, why: "Some days in Jira have no time." };

  // "8-12 & 1-5" → open 8–5 with a lunch break 12–1
  for (const d of DAYS) {
    const s = week[d];
    if (!s || s.spans.length < 2) continue;
    if (s.spans.length > 2) return { ok: false, why: `More than one break on ${SHORT[d]}.` };
    const gap: Span = [s.spans[0][1], s.spans[1][0]];
    if (gap[1] <= gap[0]) return { ok: false, why: `Overlapping times on ${SHORT[d]}.` };
    if (lunch && (lunch[0] !== gap[0] || lunch[1] !== gap[1])) return { ok: false, why: "The lunch break in Jira doesn't match the split hours." };
    lunch = gap;
    week[d] = { spans: [[s.spans[0][0], s.spans[1][1]]] };
  }
  return { ok: true, week, lunch };
}

// ---------- output ----------

export function fmtTime(min: number, withAp = true) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const h12 = h % 12 || 12, ap = h < 12 ? "AM" : "PM";
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${withAp ? ` ${ap}` : ""}`;
}
export function fmtSpan([a, b]: Span) {
  const sameAp = (a < 720) === (b < 720);
  return sameAp ? `${fmtTime(a, false)}–${fmtTime(b)}` : `${fmtTime(a)}–${fmtTime(b)}`;
}
const slotText = (s: DaySlot) => (s.closed ? "Closed" : s.text || s.spans.map(fmtSpan).join(", "));
/** The day-group style for the main hours value. "8 AM–5 PM" keeps AM/PM on both ends. */
const valueSpan = ([a, b]: Span) => `${fmtTime(a)}–${fmtTime(b)}`;
const valueSlot = (s: DaySlot) => (s.closed ? "Closed" : s.text || s.spans.map(valueSpan).join(", "));

function groupDays(week: WeekHours, text: (s: DaySlot) => string) {
  const out: string[] = [];
  let i = 0;
  while (i < 7) {
    const s = week[DAYS[i]];
    if (!s || s.closed) { i++; continue; } // only open days are listed
    let j = i;
    while (j + 1 < 7 && week[DAYS[j + 1]] && JSON.stringify(week[DAYS[j + 1]]) === JSON.stringify(s)) j++;
    out.push(`${j > i ? `${SHORT[DAYS[i]]}–${SHORT[DAYS[j]]}` : SHORT[DAYS[i]]}: ${text(s)}`);
    i = j + 1;
  }
  return out;
}

/** "Mon–Fri: 8 AM–5 PM | Sat: 8 AM–12 PM | Closed for Lunch: 12–1 PM" */
export function formatHours(r: { week: WeekHours; lunch: Span | null }) {
  const parts = groupDays(r.week, valueSlot);
  if (r.lunch) parts.push(`Closed for Lunch: ${fmtSpan(r.lunch)}`);
  return parts.join(" | ");
}

// ---------- GBP ----------

/** GBP hours come as {"monday":"8:30 AM–5:30 PM", "sunday":"Closed"} (key names vary by provider). */
export function readGbpHours(h: Record<string, string> | undefined | null): { week: WeekHours; lunch: Span | null } | null {
  if (!h || !Object.keys(h).length) return null;
  const week: WeekHours = {};
  let lunch: Span | null = null;
  for (const [k, v] of Object.entries(h)) {
    const d = DAYS.find((x) => k.toLowerCase().trim().startsWith(x));
    if (!d) continue;
    const val = normalize(String(v));
    if (/closed/.test(val) && !/\d/.test(val)) { week[d] = { closed: true, spans: [] }; continue; }
    if (/24 ?hours/.test(val)) { week[d] = { text: "Open 24 Hours", spans: [] }; continue; }
    const spans: Span[] = [];
    val.replace(RANGE, (all, a, b) => { const r = readRange(a, b); if (r) spans.push(r); return " "; });
    if (!spans.length) return null; // unreadable — don't compare on a guess
    spans.sort((x, y) => x[0] - y[0]);
    if (spans.length === 2) { lunch = lunch || [spans[0][1], spans[1][0]]; week[d] = { spans: [[spans[0][0], spans[1][1]]] }; }
    else week[d] = { spans };
  }
  return Object.keys(week).length ? { week, lunch } : null;
}

/** Day-by-day differences between Jira and GBP, written for a person. Empty = same. */
export function compareHours(jira: { week: WeekHours; lunch: Span | null }, gbp: { week: WeekHours; lunch: Span | null }) {
  const diffs: string[] = [];
  const wrong: Record<string, Day[]> = {};
  for (const d of DAYS) {
    const j = jira.week[d], g = gbp.week[d];
    const jo = j && !j.closed, go = g && !g.closed;
    let msg = "";
    if (jo && !go) msg = g ? `Jira ${slotText(j!)}, GBP Closed` : `Jira ${slotText(j!)}, GBP doesn't list it`;
    else if (!jo && go) msg = `Jira ${j ? "Closed" : "doesn't list it"}, GBP ${slotText(g!)}`;
    else if (jo && go && slotText(j!) !== slotText(g!)) msg = `Jira ${slotText(j!)}, GBP ${slotText(g!)}`;
    if (msg) (wrong[msg] ||= []).push(d);
  }
  for (const [msg, days] of Object.entries(wrong)) diffs.push(`${groupNames(days)}: ${msg}`);
  if (jira.lunch && !gbp.lunch) diffs.push(`Lunch break ${fmtSpan(jira.lunch)} is in Jira but not on GBP`);
  else if (!jira.lunch && gbp.lunch) diffs.push(`GBP shows a lunch break ${fmtSpan(gbp.lunch)} that Jira doesn't`);
  else if (jira.lunch && gbp.lunch && fmtSpan(jira.lunch) !== fmtSpan(gbp.lunch)) diffs.push(`Lunch break: Jira ${fmtSpan(jira.lunch)}, GBP ${fmtSpan(gbp.lunch)}`);
  return diffs;
}
function groupNames(days: Day[]) {
  const idx = days.map((d) => DAYS.indexOf(d));
  const out: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    out.push(j > i ? `${SHORT[DAYS[idx[i]]]}–${SHORT[DAYS[idx[j]]]}` : SHORT[DAYS[idx[i]]]);
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * Jira hours → the sheet's format, plus the GBP comparison note.
 * The formatted value is read back and must give exactly the same days and times as Jira, or Jira's text is kept as-is.
 */
/** Jira text kept as written, but on one line ("Mon-Fri 8-5\nSat 8-12" → "Mon-Fri 8-5 | Sat 8-12"). */
const oneLine = (t: string) => t.trim().split(/\s*\n+\s*/).filter(Boolean).join(" | ");

export function hoursFromJira(jiraText: string, gbpHours?: Record<string, string> | null) {
  const notes: string[] = [];
  const r = readHours(jiraText);
  const gbp = readGbpHours(gbpHours);
  if (!r.ok) {
    notes.push(`Kept exactly as written in Jira — ${r.why}`);
    if (gbp) notes.push(`GBP shows: ${groupDays(gbp.week, valueSlot).join(" | ")}${gbp.lunch ? ` | Closed for Lunch: ${fmtSpan(gbp.lunch)}` : ""}`);
    return { value: oneLine(jiraText), note: notes.join("\n"), status: "review" as const, formatted: false };
  }
  const value = formatHours(r);
  const back = readHours(value);
  const openDays = (w: WeekHours) => JSON.stringify(DAYS.map((d) => (w[d] && !w[d]!.closed ? w[d] : null)));
  if (!back.ok || openDays(back.week) !== openDays(r.week) || JSON.stringify(back.lunch) !== JSON.stringify(r.lunch)) {
    return { value: oneLine(jiraText), note: "Kept exactly as written in Jira — the reformatted hours didn't read back the same.", status: "review" as const, formatted: false };
  }
  let status: "ok" | "review" = "ok";
  if (!gbp) notes.push("From Jira. GBP hours weren't available to compare.");
  else {
    const d = compareHours(r, gbp);
    if (d.length) { status = "review"; notes.push(`From Jira. GBP is different — ${d.join("; ")}`); }
    else notes.push("From Jira. Matches GBP.");
  }
  return { value, note: notes.join("\n"), status, formatted: true };
}
