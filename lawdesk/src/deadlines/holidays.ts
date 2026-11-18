// "Legal holidays" for Kansas time computation.
//
// K.S.A. 60-206(a)(6), https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html :
//   "'Legal holiday' means any day declared a holiday by the president of the United States,
//    the congress of the United States or the legislature of this state, or any day observed as a
//    holiday by order of the Kansas supreme court. A half holiday is considered as other days and
//    not as a holiday."
//
// So a legal holiday is the union of four sources:
//   1. the Kansas legislature: K.S.A. 35-107(a) (generated below by rule);
//   2. Congress: 5 U.S.C. 6103(a) (generated below by rule);
//   3. the President: ad hoc executive orders (NOT generated; pass them in as extra holidays);
//   4. the Kansas Supreme Court: yearly administrative orders approving the judicial branch's
//      holidays, plus one-off orders (only the orders actually read are listed in SUPREME_COURT_ORDERS).
//
// Observed-date shifting: neither K.S.A. 35-107 nor 5 U.S.C. 6103(a) moves a holiday that falls on
// a weekend. 5 U.S.C. 6103(b) does move Saturday/Sunday holidays, but only "For the purpose of
// statutes relating to pay and leave of employees", so it is not applied here. Weekday "observed"
// dates (e.g. Friday, November 10, 2023 for Veterans Day) come in only through a Kansas Supreme
// Court order listed below, because 60-206(a)(6) counts "any day observed as a holiday by order of
// the Kansas supreme court".

import { type ISODate, isISODate } from "../dates.ts";

export const SOURCES = {
  ksa60206: "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html",
  ksa35107: "https://ksrevisor.gov/statutes/chapters/ch35/035_001_0007.html",
  usc6103: "https://www.law.cornell.edu/uscode/text/5/6103",
  order2022CC080: "https://16jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2022-CC-080.pdf?ext=.pdf",
  order2024CC081: "https://2jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2024-CC-081.pdf?ext=.pdf",
  order2024CC105: "https://2jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2024-CC-105.pdf",
} as const;

export interface Holiday {
  date: ISODate;
  name: string;
  /** Every authority that makes this day a legal holiday. */
  sources: string[];
}

/**
 * Earliest year the generated list is offered for. Only the current text of the statutes was read,
 * and holiday lists change over time (Juneteenth is in today's 5 U.S.C. 6103(a)), so years long
 * past are refused rather than computed from today's text.
 */
export const FIRST_SUPPORTED_YEAR = 2022;
export const LAST_SUPPORTED_YEAR = 2100;

function ymd(y: number, m: number, d: number): ISODate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The nth given weekday (0 = Sunday ... 6 = Saturday) of a month; n = -1 means the last one. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  if (n > 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
    return ymd(year, month, day);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return ymd(year, month, lastDay - ((lastDow - weekday + 7) % 7));
}

const KS = "K.S.A. 35-107(a) (Kansas legislature)";
const US = "5 U.S.C. 6103(a) (Congress)";

/**
 * K.S.A. 35-107(a): "On and after January 1, 2006, the following days are declared to be legal
 * public holidays and are to be observed as such:" New Year's Day, January 1; Martin Luther King,
 * Jr. Day, the third Monday in January; President's Day, the third Monday in February; Memorial
 * Day, the last Monday in May; Independence Day, July 4; Labor Day, the first Monday in September;
 * Columbus Day, the second Monday in October; Veterans' Day, the eleventh day in November;
 * Thanksgiving Day, the fourth Thursday in November; Christmas Day, December 25.
 * (No weekend-observance provision in the text.)
 */
export function kansasStatutoryHolidays(year: number): Holiday[] {
  return [
    { date: ymd(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: "Martin Luther King, Jr. Day" },
    { date: nthWeekday(year, 2, 1, 3), name: "President's Day" },
    { date: nthWeekday(year, 5, 1, -1), name: "Memorial Day" },
    { date: ymd(year, 7, 4), name: "Independence Day" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Columbus Day" },
    { date: ymd(year, 11, 11), name: "Veterans' Day" },
    { date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving Day" },
    { date: ymd(year, 12, 25), name: "Christmas Day" },
  ].map((h) => ({ ...h, sources: [KS] }));
}

/**
 * 5 U.S.C. 6103(a): New Year's Day, January 1; Birthday of Martin Luther King, Jr., the third
 * Monday in January; Washington's Birthday, the third Monday in February; Memorial Day, the last
 * Monday in May; Juneteenth National Independence Day, June 19; Independence Day, July 4; Labor
 * Day, the first Monday in September; Columbus Day, the second Monday in October; Veterans Day,
 * November 11; Thanksgiving Day, the fourth Thursday in November; Christmas Day, December 25.
 * Inauguration Day (6103(c)) is left out: the statute limits it to "statutes relating to pay and
 * leave of employees" in and around the District of Columbia.
 */
export function federalStatutoryHolidays(year: number): Holiday[] {
  return [
    { date: ymd(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: "Birthday of Martin Luther King, Jr." },
    { date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { date: nthWeekday(year, 5, 1, -1), name: "Memorial Day" },
    { date: ymd(year, 6, 19), name: "Juneteenth National Independence Day" },
    { date: ymd(year, 7, 4), name: "Independence Day" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Columbus Day" },
    { date: ymd(year, 11, 11), name: "Veterans Day" },
    { date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving Day" },
    { date: ymd(year, 12, 25), name: "Christmas Day" },
  ].map((h) => ({ ...h, sources: [US] }));
}

export interface CourtOrder {
  order: string;
  url: string;
  /** What the order covers. */
  covers: string;
  days: { date: ISODate; name: string }[];
}

/**
 * Kansas Supreme Court administrative orders that were actually read. 60-206(a)(6) counts "any day
 * observed as a holiday by order of the Kansas supreme court". Add a year here only after reading
 * that year's order; every day in an order is listed, including days that are also statutory.
 */
export const SUPREME_COURT_ORDERS: CourtOrder[] = [
  {
    order: "Kansas Supreme Court Administrative Order 2022-CC-080, Re: Calendar Year 2023 Holidays (Nov. 23, 2022)",
    url: SOURCES.order2022CC080,
    covers: "2023",
    days: [
      { date: "2023-01-02", name: "New Year's Day (observed)" },
      { date: "2023-01-16", name: "Martin Luther King Jr. Day" },
      { date: "2023-02-20", name: "Presidents' Day" },
      { date: "2023-05-29", name: "Memorial Day" },
      { date: "2023-06-19", name: "Juneteenth" },
      { date: "2023-07-04", name: "Independence Day" },
      { date: "2023-09-04", name: "Labor Day" },
      { date: "2023-10-09", name: "Columbus Day/Indigenous Peoples' Day" },
      { date: "2023-11-10", name: "Veterans Day (observed)" },
      { date: "2023-11-23", name: "Thanksgiving Day" },
      { date: "2023-11-24", name: "Thanksgiving holiday (Friday)" },
      { date: "2023-12-25", name: "Christmas Day" },
    ],
  },
  {
    order: "Kansas Supreme Court Administrative Order 2024-CC-081, Re: Calendar Year 2025 Holidays (Sept. 24, 2024)",
    url: SOURCES.order2024CC081,
    covers: "2025",
    days: [
      { date: "2025-01-01", name: "New Year's Day" },
      { date: "2025-01-20", name: "Martin Luther King Jr. Day" },
      { date: "2025-02-17", name: "Presidents' Day" },
      { date: "2025-05-26", name: "Memorial Day" },
      { date: "2025-06-19", name: "Juneteenth" },
      { date: "2025-07-04", name: "Independence Day" },
      { date: "2025-09-01", name: "Labor Day" },
      { date: "2025-10-13", name: "Columbus Day/Indigenous Peoples' Day" },
      { date: "2025-11-11", name: "Veterans Day" },
      { date: "2025-11-27", name: "Thanksgiving Day" },
      { date: "2025-11-28", name: "Thanksgiving holiday (Friday)" },
      { date: "2025-12-25", name: "Christmas Day" },
    ],
  },
  {
    // "The National Day of Mourning will be observed as a holiday for time computation purposes."
    order: "Kansas Supreme Court Administrative Order 2024-CC-105, Re: National Day of Mourning (Dec. 31, 2024)",
    url: SOURCES.order2024CC105,
    covers: "one day",
    days: [{ date: "2025-01-09", name: "National Day of Mourning for former President Jimmy Carter" }],
  },
];

/** Years for which the yearly Supreme Court holiday order has been read and loaded. */
export const YEARS_WITH_COURT_ORDER = new Set(
  SUPREME_COURT_ORDERS.filter((o) => /^\d{4}$/.test(o.covers)).map((o) => Number(o.covers)),
);

export function checkYear(year: number) {
  if (!Number.isInteger(year) || year < FIRST_SUPPORTED_YEAR || year > LAST_SUPPORTED_YEAR) {
    throw new RangeError(`Legal holidays are only generated for ${FIRST_SUPPORTED_YEAR}-${LAST_SUPPORTED_YEAR}`);
  }
}

/**
 * Every legal holiday in a year under K.S.A. 60-206(a)(6), merged by date. `extra` adds days the
 * user knows about (a presidential declaration, a Supreme Court order not loaded here).
 */
export function legalHolidays(year: number, extra: Holiday[] = []): Holiday[] {
  checkYear(year);
  const byDate = new Map<ISODate, Holiday>();
  const add = (h: Holiday) => {
    const cur = byDate.get(h.date);
    if (!cur) byDate.set(h.date, { date: h.date, name: h.name, sources: [...h.sources] });
    else for (const s of h.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
  };
  kansasStatutoryHolidays(year).forEach(add);
  federalStatutoryHolidays(year).forEach(add);
  for (const o of SUPREME_COURT_ORDERS) {
    for (const d of o.days) if (d.date.startsWith(`${year}-`)) add({ date: d.date, name: d.name, sources: [o.order] });
  }
  for (const h of extra) {
    if (!isISODate(h.date)) throw new Error(`Not a valid date: ${h.date}`);
    if (h.date.startsWith(`${year}-`)) add(h);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Caches holiday lookups across the years a computation touches. */
export class HolidayCalendar {
  private years = new Map<number, Map<ISODate, Holiday>>();
  private extra: Holiday[];
  constructor(extra: Holiday[] = []) {
    this.extra = extra;
  }

  private forYear(year: number): Map<ISODate, Holiday> {
    let m = this.years.get(year);
    if (!m) {
      m = new Map(legalHolidays(year, this.extra).map((h) => [h.date, h]));
      this.years.set(year, m);
    }
    return m;
  }

  get(date: ISODate): Holiday | undefined {
    return this.forYear(Number(date.slice(0, 4))).get(date);
  }

  /** Years touched so far. */
  touchedYears(): number[] {
    return [...this.years.keys()].sort();
  }
}
