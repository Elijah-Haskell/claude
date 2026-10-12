// ── Time utilities ────────────────────────────────────────────

/** Convert "HH:MM" to total minutes since midnight */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Convert total minutes since midnight to "HH:MM" */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Format "HH:MM" (24h) to "H:MM AM/PM" */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = (h ?? 0) % 12 || 12;
  const ampm = (h ?? 0) < 12 ? "AM" : "PM";
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
}

// ── Local calendar-date keys ──────────────────────────────────
// Every "YYYY-MM-DD" in this app is a LOCAL calendar date (the student's wall
// calendar). Never derive one with toISOString(): that is the UTC date, which
// is "tomorrow" on a US evening and "yesterday" on a morning east of UTC.

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Local calendar date of a Date as "YYYY-MM-DD". */
export function localDateKey(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Local calendar date of a stored due/exam date. A plain "YYYY-MM-DD" is already a local date key
 * (never feed it to `new Date()`: that parses it as UTC midnight); a full ISO instant is converted
 * to the local date it falls on.
 */
export function dateKeyOf(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : localDateKey(parsed);
}

/** Local midnight of a "YYYY-MM-DD" key (a time part, if any, is ignored). */
export function parseLocalDate(key: string): Date {
  const match = DATE_KEY.exec(key);
  if (!match) return new Date(NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function keyToUtcDay(key: string): number {
  const match = DATE_KEY.exec(key);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Add N calendar days to a "YYYY-MM-DD" key. Pure calendar math: DST- and timezone-proof. */
export function addDaysToKey(key: string, days: number): string {
  const t = keyToUtcDay(key);
  if (Number.isNaN(t)) return key;
  const d = new Date(t + days * 86_400_000);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whole calendar days from key `from` to key `to` (positive when `to` is later). */
export function daysBetweenKeys(from: string, to: string): number {
  return Math.round((keyToUtcDay(to) - keyToUtcDay(from)) / 86_400_000);
}

/** Weekday name ("Mon".."Sun") of a "YYYY-MM-DD" key. */
export function weekdayOfKey(key: string): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return names[new Date(keyToUtcDay(key)).getUTCDay()] ?? "Mon";
}

/** Monday key of the week containing the given "YYYY-MM-DD" key. */
export function weekStartKeyOf(key: string): string {
  const dow = new Date(keyToUtcDay(key)).getUTCDay(); // 0=Sun
  return addDaysToKey(key, dow === 0 ? -6 : 1 - dow);
}

/** Get the Monday (at local midnight) of the week containing the given date */
export function getWeekStart(date: Date): Date {
  return parseLocalDate(weekStartKeyOf(localDateKey(date)));
}

/** Add N days to a date (keeps the local wall-clock time across DST changes) */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Format a Date as its LOCAL calendar date, "YYYY-MM-DD" */
export function toDateString(date: Date): string {
  return localDateKey(date);
}

/** Generate a simple unique ID */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Get today's LOCAL date as "YYYY-MM-DD" (pass `now` from pure logic and tests) */
export function todayString(now: Date = new Date()): string {
  return localDateKey(now);
}

/** Get day-of-week label from "YYYY-MM-DD" */
export function getDayLabel(dateStr: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(dateStr + "T12:00:00");
  return days[d.getDay()] ?? "";
}

/** Format date as "Mon Feb 24" */
export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Format date as "February 24" */
export function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** Check if a date string is today */
export function isToday(dateStr: string, now: Date = new Date()): boolean {
  return dateStr === todayString(now);
}

/** Get duration in minutes between two "HH:MM" times */
export function getDurationMinutes(startTime: string, endTime: string): number {
  return timeToMinutes(endTime) - timeToMinutes(startTime);
}

/** Format duration in minutes as "Xh Ym" or "Ym" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
