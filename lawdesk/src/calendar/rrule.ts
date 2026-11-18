// The subset of RFC 5545 recurrence rules (§3.3.10, https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10)
// the firm calendar supports:
//   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, WKST,
//   BYDAY on WEEKLY (MO,WE,FR) and on MONTHLY (2TU = second Tuesday, -1FR = last Friday).
// Anything else (BYMONTHDAY, BYSETPOS, BYHOUR...) is rejected rather than silently
// misread, so a court date is never shown on the wrong day.
//
// Expansion works on local calendar dates; the caller attaches the time of day in the
// event's zone. As RFC 5545 §3.3.10 requires, dates that don't exist (31 April,
// 29 February in a common year) are skipped, not moved.

import type { ISODate } from "../dates.ts";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface ByDay {
  /** 1..5 or -1..-5 for MONTHLY ("2nd Tuesday", "last Friday"); absent = every such weekday. */
  n?: number;
  /** 0 = Sunday ... 6 = Saturday. */
  wd: number;
}

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** As written in iCalendar: YYYYMMDD (all-day) or YYYYMMDDTHHMMSSZ (timed, UTC). */
  until?: string;
  byday?: ByDay[];
  /** Week start, 0 = Sunday ... 6 = Saturday. Default Monday, as in RFC 5545. */
  wkst: number;
}

export class RRuleError extends Error {}

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const UNTIL_RE = /^(\d{8})(T\d{6}Z?)?$/;

export function parseRRule(input: string): RRule {
  const s = input.trim().replace(/^RRULE:/i, "");
  if (!s) throw new RRuleError("Empty repeat rule");
  const parts = new Map<string, string>();
  for (const piece of s.split(";")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq < 1) throw new RRuleError(`Bad repeat rule part "${piece}"`);
    const k = piece.slice(0, eq).toUpperCase();
    if (parts.has(k)) throw new RRuleError(`${k} appears twice in the repeat rule`);
    parts.set(k, piece.slice(eq + 1).toUpperCase());
  }
  for (const k of parts.keys()) {
    if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"].includes(k)) {
      throw new RRuleError(`Repeat rules with ${k} are not supported`);
    }
  }
  const freq = parts.get("FREQ");
  if (!freq || !FREQS.has(freq)) throw new RRuleError("Repeat rule needs FREQ=DAILY, WEEKLY, MONTHLY or YEARLY");
  const rule: RRule = { freq: freq as Freq, interval: 1, wkst: 1 };

  if (parts.has("INTERVAL")) {
    const n = Number(parts.get("INTERVAL"));
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RRuleError("INTERVAL must be a whole number from 1 to 1000");
    rule.interval = n;
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) throw new RRuleError("Use COUNT or UNTIL, not both");
  if (parts.has("COUNT")) {
    const n = Number(parts.get("COUNT"));
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new RRuleError("COUNT must be a whole number from 1 to 10000");
    rule.count = n;
  }
  if (parts.has("UNTIL")) {
    const u = parts.get("UNTIL")!;
    const m = UNTIL_RE.exec(u);
    if (!m || !isValidCompactDate(m[1])) throw new RRuleError(`UNTIL "${u}" is not a date like 20261231 or 20261231T235959Z`);
    rule.until = u;
  }
  if (parts.has("WKST")) {
    const i = WEEKDAYS.indexOf(parts.get("WKST")!);
    if (i < 0) throw new RRuleError("WKST must be a weekday like MO");
    rule.wkst = i;
  }
  if (parts.has("BYDAY")) {
    if (rule.freq !== "WEEKLY" && rule.freq !== "MONTHLY") throw new RRuleError("BYDAY is supported only with WEEKLY or MONTHLY");
    const seen = new Set<string>();
    rule.byday = parts
      .get("BYDAY")!
      .split(",")
      .map((tok) => {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
        if (!m) throw new RRuleError(`BYDAY value "${tok}" is not a weekday like MO or 2TU`);
        const out: ByDay = { wd: WEEKDAYS.indexOf(m[2]) };
        if (m[1] !== undefined) {
          if (rule.freq === "WEEKLY") throw new RRuleError("Weekly repeats take plain weekdays (MO, not 2MO)");
          const n = Number(m[1]);
          if (n === 0 || n < -5 || n > 5) throw new RRuleError(`BYDAY "${tok}": the week number must be 1 to 5 or -1 to -5`);
          out.n = n;
        }
        const key = `${out.n ?? ""}${out.wd}`;
        if (seen.has(key)) throw new RRuleError(`BYDAY lists ${tok} twice`);
        seen.add(key);
        return out;
      });
    if (!rule.byday.length) throw new RRuleError("BYDAY is empty");
  }
  return rule;
}

export function formatRRule(r: RRule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval !== 1) out.push(`INTERVAL=${r.interval}`);
  if (r.count !== undefined) out.push(`COUNT=${r.count}`);
  if (r.until !== undefined) out.push(`UNTIL=${r.until}`);
  if (r.byday?.length) out.push(`BYDAY=${r.byday.map((b) => `${b.n ?? ""}${WEEKDAYS[b.wd]}`).join(",")}`);
  if (r.wkst !== 1) out.push(`WKST=${WEEKDAYS[r.wkst]}`);
  return out.join(";");
}

function isValidCompactDate(s: string): boolean {
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// --- day arithmetic on epoch days (UTC, so no zone can shift a date) ---

const DAY = 86_400_000;
const toDays = (s: ISODate) => Math.floor(Date.parse(s + "T00:00:00Z") / DAY);
const fromDays = (n: number): ISODate => new Date(n * DAY).toISOString().slice(0, 10);
const dow = (n: number) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday

function ymd(y: number, m: number, d: number): ISODate | null {
  // m is 1-based; returns null when the date does not exist
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Dates of the month (y, m 1-based) matching the BYDAY list, sorted. */
function monthByDay(y: number, m: number, byday: ByDay[]): number[] {
  const first = toDays(ymd(y, m, 1)!);
  const len = daysInMonth(y, m);
  const set = new Set<number>();
  for (const b of byday) {
    const firstMatch = first + ((b.wd - dow(first) + 7) % 7);
    const all: number[] = [];
    for (let d = firstMatch; d < first + len; d += 7) all.push(d);
    if (b.n === undefined) all.forEach((d) => set.add(d));
    else {
      const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
      if (pick !== undefined) set.add(pick);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** True when the start date is itself an occurrence of the rule (RFC 5545 says DTSTART SHOULD be). */
export function startMatchesRule(rule: RRule, start: ISODate): boolean {
  const s = toDays(start);
  if (rule.freq === "WEEKLY" && rule.byday) return rule.byday.some((b) => b.wd === dow(s));
  if (rule.freq === "MONTHLY" && rule.byday) {
    const [y, m] = start.split("-").map(Number);
    return monthByDay(y, m, rule.byday).includes(s);
  }
  return true;
}

/**
 * The rule's occurrence dates from `start` on, in order, honouring COUNT but not UNTIL
 * (UNTIL compares instants, which depends on the time of day; the caller checks it).
 * Infinite when there is no COUNT: the caller stops iterating.
 */
export function* occurrenceDates(rule: RRule, start: ISODate): Generator<ISODate> {
  const s = toDays(start);
  const [sy, sm, sd] = start.split("-").map(Number);
  let emitted = 0;
  let emptyPeriods = 0;
  for (let k = 0; ; k++) {
    let dates: number[] = [];
    if (rule.freq === "DAILY") {
      dates = [s + k * rule.interval];
    } else if (rule.freq === "WEEKLY") {
      const weekStart = s - ((dow(s) - rule.wkst + 7) % 7) + k * 7 * rule.interval;
      const wds = rule.byday ? rule.byday.map((b) => b.wd) : [dow(s)];
      dates = wds.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)).sort((a, b) => a - b);
    } else if (rule.freq === "MONTHLY") {
      const idx = sm - 1 + k * rule.interval;
      const y = sy + Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      if (rule.byday) dates = monthByDay(y, m, rule.byday);
      else {
        const d = ymd(y, m, sd);
        dates = d ? [toDays(d)] : [];
      }
    } else {
      const d = ymd(sy + k * rule.interval, sm, sd);
      dates = d ? [toDays(d)] : [];
    }
    let any = false;
    for (const d of dates) {
      if (d < s) continue;
      any = true;
      yield fromDays(d);
      emitted++;
      if (rule.count !== undefined && emitted >= rule.count) return;
    }
    emptyPeriods = any ? 0 : emptyPeriods + 1;
    if (emptyPeriods > 2000) return; // a rule that can never match again
  }
}

/** UNTIL as epoch ms. A date-only UNTIL on a timed event means the end of that day in `tz`. */
export function untilInstant(until: string, endOfDateInZone: (date: ISODate) => number): number {
  const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  if (until.length === 8) return endOfDateInZone(date);
  const t = until.slice(9);
  return Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`);
}
