// Time-zone arithmetic for the calendar, built on the IANA database that ships with
// Node (Intl). A timed event is stored as a UTC instant plus the zone it was entered
// in; recurrences are expanded on the local wall clock of that zone so that a weekly
// 9:00 hearing stays at 9:00 across daylight-saving changes.
//
// Rules for wall-clock times that don't exist or happen twice follow RFC 5545 §3.3.5
// (https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5):
//   - a time that occurs twice (fall back) means the first occurrence;
//   - a time that does not occur (spring forward) is read with the UTC offset in
//     force before the gap, so 02:30 on the spring-forward day becomes 03:30 CDT.

import type { ISODate } from "../dates.ts";

export const FIRM_TZ = "America/Chicago";

export interface LocalDateTime {
  date: ISODate; // YYYY-MM-DD
  time: string; // HH:MM:SS
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock date and time in `tz` at the instant `ms` (epoch milliseconds). */
export function utcToLocal(ms: number, tz: string): LocalDateTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function wallAsUtc(date: string, time: string): number {
  const t = time.length === 5 ? time + ":00" : time;
  return Date.parse(`${date}T${t}Z`);
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (Chicago in winter = -6h). */
export function offsetAt(ms: number, tz: string): number {
  const l = utcToLocal(ms, tz);
  return wallAsUtc(l.date, l.time) - (ms - (ms % 1000 + 1000) % 1000);
}

/** The instant at which the wall clock in `tz` reads `date time` (see RFC 5545 rules above). */
export function localToUtc(date: string, time: string, tz: string): number {
  const wall = wallAsUtc(date, time);
  if (Number.isNaN(wall)) throw new Error(`Not a valid date/time: ${date} ${time}`);
  const before = offsetAt(wall - 36 * 3600_000, tz);
  const after = offsetAt(wall + 36 * 3600_000, tz);
  const candidates = [wall - before, wall - after].sort((a, b) => a - b);
  const want = wallAsUtc(date, time);
  for (const c of candidates) {
    const l = utcToLocal(c, tz);
    if (wallAsUtc(l.date, l.time) === want) return c; // earliest valid = first occurrence
  }
  return wall - before; // in the spring-forward gap: use the offset before the gap
}

export function isoInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The UTC instants bounding a local calendar day in `tz` (23 or 25 hours long on DST days). */
export function dayBounds(date: ISODate, tz: string): { start: number; end: number } {
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  return { start: localToUtc(date, "00:00:00", tz), end: localToUtc(next, "00:00:00", tz) };
}
