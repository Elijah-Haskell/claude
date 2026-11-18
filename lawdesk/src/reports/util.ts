// Small helpers shared by the reports module: safe reads, periods and ratios.
//
// The reports read other modules' tables (billing, conflicts). Those modules may not be
// mounted, or may have no rows yet, so every read of a module table goes through
// `hasTables` first and a missing module shows as "not available" instead of an error.

import type { DB } from "../db.ts";
import { addDays, isISODate, today as todayIn, type ISODate } from "../dates.ts";
import { EngineError } from "../engine.ts";

export type Row = Record<string, any>;

export const FIRM_TZ = "America/Chicago";

export function all(db: DB, sql: string, ...p: any[]): Row[] {
  return db.prepare(sql).all(...p) as Row[];
}

export function one(db: DB, sql: string, ...p: any[]): Row | undefined {
  return db.prepare(sql).get(...p) as Row | undefined;
}

/** True when every named table exists in the database. */
export function hasTables(db: DB, ...names: string[]): boolean {
  const q = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  return names.every((n) => q.get(n) != null);
}

export const BILLING_TABLES = [
  "billing_settings",
  "billing_matters",
  "billing_time_entries",
  "billing_expenses",
  "billing_invoices",
  "billing_invoice_lines",
  "billing_payments",
  "billing_allocations",
  "billing_writeoffs",
];

/** The firm-time-zone calendar date of an ISO timestamp (activity rows are stored in UTC). */
export function localDate(stamp: string): ISODate {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return String(stamp).slice(0, 10);
  return todayIn(FIRM_TZ, d);
}

/** "9:30 PM" in the firm's time zone. */
export function localTime(stamp: string): string {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: FIRM_TZ, hour: "numeric", minute: "2-digit" }).format(d).replace(/\s/g, " ");
}

/** a / d rounded to 4 decimal places (0.9250 = 92.5%), or null when d is 0. Same rule as billing's reports. */
export function ratio(a: number, d: number): number | null {
  return d === 0 ? null : Math.round((a / d) * 10_000) / 10_000;
}

export function monthStart(d: ISODate): ISODate {
  return d.slice(0, 8) + "01";
}

export function monthEnd(d: ISODate): ISODate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${d.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

/** First day of the month `n` months after the month containing d (n may be negative). */
export function addMonths(d: ISODate, n: number): ISODate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(d: ISODate, withYear = true): string {
  const m = MONTHS[Number(d.slice(5, 7)) - 1];
  return withYear ? `${m} ${d.slice(0, 4)}` : m;
}

/** Calendar months overlapping [from, to], each clipped to the range. */
export function monthsIn(from: ISODate, to: ISODate): { month: string; from: ISODate; to: ISODate }[] {
  const out = [];
  for (let s = monthStart(from); s <= to; s = addMonths(s, 1)) {
    out.push({ month: s.slice(0, 7), from: s < from ? from : s, to: monthEnd(s) > to ? to : monthEnd(s) });
    if (out.length > 240) throw new EngineError("That period is too long; pick 20 years or less");
  }
  return out;
}

export function checkDate(v: unknown, what: string): ISODate {
  if (!isISODate(v)) throw new EngineError(`${what} must be a date like 2026-01-31`);
  return v;
}

export { addDays };
