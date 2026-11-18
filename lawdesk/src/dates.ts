// Date helpers. Every date is a plain "YYYY-MM-DD" string handled in UTC so that
// time zones can never shift a due date by a day.

export type ISODate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toDate(s: ISODate): Date {
  if (!isISODate(s)) throw new Error(`Not a valid date: ${s}`);
  return new Date(s + "T00:00:00Z");
}

function fromDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

export function isWeekend(s: ISODate): boolean {
  const day = toDate(s).getUTCDay();
  return day === 0 || day === 6;
}

/** True when the day is a weekend or one of the firm's listed closed days. */
export function isNonBusinessDay(s: ISODate, holidays: ReadonlySet<string>): boolean {
  return isWeekend(s) || holidays.has(s);
}

/**
 * Move n business days from s (n may be negative). n = 0 returns s itself, even
 * when s is not a business day; use rollForward for that.
 */
export function addBusinessDays(s: ISODate, n: number, holidays: ReadonlySet<string> = new Set()): ISODate {
  let cur = s;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    cur = addDays(cur, step);
    if (!isNonBusinessDay(cur, holidays)) left--;
  }
  return cur;
}

/** If s falls on a weekend or closed day, move to the next business day. */
export function rollForward(s: ISODate, holidays: ReadonlySet<string> = new Set()): ISODate {
  let cur = s;
  while (isNonBusinessDay(cur, holidays)) cur = addDays(cur, 1);
  return cur;
}

export function offsetDate(
  s: ISODate,
  days: number,
  businessDays: boolean,
  holidays: ReadonlySet<string> = new Set(),
): ISODate {
  return businessDays ? addBusinessDays(s, days, holidays) : addDays(s, days);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

export function maxDate(dates: ISODate[]): ISODate | null {
  if (dates.length === 0) return null;
  return dates.reduce((m, d) => (d > m ? d : m));
}

/** Today's date in the firm's time zone (Kansas is mostly Central time). */
export function today(timeZone = "America/Chicago", now = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
