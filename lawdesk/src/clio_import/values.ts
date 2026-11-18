// Reading the values found in Clio files: dates, times, money, hours, yes/no.
// Every parser returns null for a blank cell and throws ValueError (with a plain message)
// for something it can't read, so the preview can show the problem on its row.
//
// Clio's migration templates use MM/DD/YYYY dates and H:MM:SS AM/PM times, and give time
// as decimal hours (see docs/clio-import.md for the sources). The API uses ISO-8601.

import { isISODate, type ISODate } from "../dates.ts";
import { FIRM_TZ, localToUtc, utcToLocal } from "../calendar/tz.ts";

export class ValueError extends Error {}

const blank = (v: unknown) => v == null || String(v).trim() === "";

/** "03/09/2026", "3/9/2026", "3/9/26", "2026-03-09", "2026-03-09T14:00:00Z" (converted to the firm's day). */
export function parseDate(v: unknown, order: "mdy" | "dmy" = "mdy", timeZone = FIRM_TZ): ISODate | null {
  if (blank(v)) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    if (!isISODate(s)) throw new ValueError(`"${s}" is not a real date`);
    return s;
  }
  // An instant with a time: convert to the firm's calendar day.
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    if (!m[3]) {
      if (!isISODate(m[1])) throw new ValueError(`"${s}" is not a real date`);
      return m[1];
    }
    const ms = Date.parse(s.replace(" ", "T"));
    if (Number.isNaN(ms)) throw new ValueError(`"${s}" is not a date and time we can read`);
    return utcToLocal(ms, timeZone).date;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s+.*)?$/.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [mo, d] = order === "mdy" ? [a, b] : [b, a];
    let y = Number(m[3]);
    if (m[3].length === 2) y += y >= 70 ? 1900 : 2000;
    const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!isISODate(iso)) throw new ValueError(`"${s}" is not a real date (dates should be MM/DD/YYYY)`);
    return iso;
  }
  throw new ValueError(`"${s}" is not a date we can read (use MM/DD/YYYY)`);
}

/** "9:30:00 AM", "9:30 AM", "14:00", "2:00pm" -> "HH:MM:SS" (24-hour). */
export function parseTime(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(s);
  if (!m || (!m[2] && !m[4])) throw new ValueError(`"${s}" is not a time we can read (use 9:30:00 AM)`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const sec = Number(m[3] ?? 0);
  if (m[4]) {
    if (h < 1 || h > 12) throw new ValueError(`"${s}" is not a real time`);
    const pm = /^p/i.test(m[4]);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59 || sec > 59) throw new ValueError(`"${s}" is not a real time`);
  return [h, min, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Local wall time in the firm's zone -> UTC instant string. */
export function localInstant(date: ISODate, time: string, timeZone = FIRM_TZ): string {
  return new Date(localToUtc(date, time, timeZone)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parse a decimal string exactly into an integer scaled by 10^scale, rounding half away
 * from zero at the last place. "12.345" with scale 2 -> 1235. No floating point.
 */
export function parseDecimal(v: unknown, scale: number, what = "number"): number | null {
  if (blank(v)) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValueError(`${what} is not a number`);
    v = v.toFixed(Math.min(scale + 4, 20));
  }
  let s = String(v).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(USD|US\$|\$)\s*/i, "").replace(/\s*(USD)$/i, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1).replace(/^\$/, "");
  }
  s = s.replace(/,/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) throw new ValueError(`"${String(v).trim()}" is not a ${what} we can read`);
  const whole = m[1] || "0";
  const frac = (m[2] ?? "").padEnd(scale + 1, "0");
  let n = Number(whole) * 10 ** scale + Number(frac.slice(0, scale) || "0");
  if (Number(frac[scale]) >= 5) n += 1;
  if (!Number.isSafeInteger(n)) throw new ValueError(`"${String(v).trim()}" is too large`);
  return neg ? -n : n;
}

/** "$1,234.56" -> 123456 cents. "(12.00)" and "-12" are negative. */
export function parseMoney(v: unknown): number | null {
  return parseDecimal(v, 2, "dollar amount");
}

/** Decimal hours ("1.5", "0.25") or "h:mm" ("1:30") -> whole minutes (rounded to the nearest minute). */
export function parseHours(v: unknown): number | null {
  if (blank(v)) return null;
  const s = String(v).trim();
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const thousandths = parseDecimal(s.replace(/\s*(h|hr|hrs|hours?)$/i, ""), 4, "number of hours");
  if (thousandths == null) return null;
  if (thousandths < 0) throw new ValueError(`"${s}" is negative; time can't be less than zero`);
  return Math.round((thousandths * 60) / 10_000);
}

/** Seconds (the API's `quantity` from version 4.0.4 on) -> whole minutes. */
export function secondsToMinutes(v: unknown): number | null {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ValueError(`"${v}" is not a number of seconds`);
  return Math.round(n / 60);
}

const TRUE = new Set(["1", "true", "yes", "y", "t", "x", "complete", "completed", "done", "billed", "non-billable", "nonbillable"]);
const FALSE = new Set(["0", "false", "no", "n", "f", "", "incomplete", "pending", "unbilled", "billable"]);

export function parseBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (s === "") return null;
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw new ValueError(`"${String(v).trim()}" should be yes or no`);
}

export function cleanText(v: unknown, max = 10_000): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\r\n?/g, "\n").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Name used for matching: lower case, single spaces, no punctuation around it. */
export function nameKey(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fmtCents(c: number): string {
  const neg = c < 0;
  const a = Math.abs(c);
  const s = `$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}
