// ============================================================
// Syllabus date resolution - pure, deterministic, timezone-proof.
//
// The model only REPORTS what a document says ("Week 5 Friday", "March 15",
// "10/20/2026"). Everything that turns that into a calendar date happens here,
// with plain calendar arithmetic (no `Date` in local time, no toISOString), so
// the same input gives the same date in every timezone.
//
// Rule number one: NEVER invent a date. Missing stays missing. A date that is
// not real ("Feb 30") is rejected, not "fixed". A date outside the term is
// flagged, not silently moved.
// ============================================================

import type { DayOfWeek } from "./types";

// ── Calendar primitives (self-contained: this file is also bundled into the server) ──

const DAY_MS = 86_400_000;
const WEEKDAYS: readonly DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface DateBreak {
  name: string;
  startDate: string; // "YYYY-MM-DD", inclusive
  endDate: string; // "YYYY-MM-DD", inclusive
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatDateKey(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1900 &&
    year <= 2200 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** True only for a real calendar date written exactly as "YYYY-MM-DD" ("2026-02-30" is not one). */
export function isRealDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(m && isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])));
}

function keyToUtcDay(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Add N calendar days to a date key (pure calendar math, DST-proof). */
export function addDaysKey(key: string, days: number): string {
  const t = keyToUtcDay(key);
  if (Number.isNaN(t)) return key;
  const d = new Date(t + days * DAY_MS);
  return formatDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((keyToUtcDay(toKey) - keyToUtcDay(fromKey)) / DAY_MS);
}

/** Index of the weekday, Monday = 0 ... Sunday = 6. */
export function weekdayIndex(key: string): number {
  const dow = new Date(keyToUtcDay(key)).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
}

export function weekdayOf(key: string): DayOfWeek {
  return WEEKDAYS[weekdayIndex(key)] ?? "Mon";
}

// ── Weekday / month names ─────────────────────────────────────

const WEEKDAY_ALIASES: Record<string, DayOfWeek> = {
  mon: "Mon", monday: "Mon", mondays: "Mon",
  tue: "Tue", tues: "Tue", tuesday: "Tue", tuesdays: "Tue",
  wed: "Wed", weds: "Wed", wednesday: "Wed", wednesdays: "Wed",
  thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu", thursdays: "Thu",
  fri: "Fri", friday: "Fri", fridays: "Fri",
  sat: "Sat", saturday: "Sat", saturdays: "Sat",
  sun: "Sun", sunday: "Sun", sundays: "Sun",
};

/** "Friday" / "fri" / "Fri." -> "Fri"; anything else -> null. */
export function normalizeWeekday(value: unknown): DayOfWeek | null {
  if (typeof value !== "string") return null;
  return WEEKDAY_ALIASES[value.trim().toLowerCase().replace(/[.,]/g, "")] ?? null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ── Parsing what a document / the model wrote ─────────────────

export interface ParsedDate {
  /** null when the text has no year ("March 15", "03-15"). Never guessed here. */
  year: number | null;
  month: number;
  day: number;
}

export type ParseDateResult =
  | { ok: true; date: ParsedDate }
  | { ok: false; reason: "empty" | "unparseable" | "impossible" };

function expandYear(raw: string): number {
  const n = Number(raw);
  if (raw.length === 2) return n < 70 ? 2000 + n : 1900 + n;
  return n;
}

function build(year: number | null, month: number, day: number): ParseDateResult {
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "impossible" };
  if (year !== null) {
    return isValidCalendarDate(year, month, day) ? { ok: true, date: { year, month, day } } : { ok: false, reason: "impossible" };
  }
  // Without a year Feb 29 is possible (in a leap year); every other day-of-month is checked against its longest month.
  const longest = month === 2 ? 29 : daysInMonth(2024, month);
  return day <= longest ? { ok: true, date: { year: null, month, day } } : { ok: false, reason: "impossible" };
}

/**
 * Normalise the many ways a date shows up into {year?, month, day}:
 *  2026-10-20, 2026/10/20, 10/20/2026, 10/20/26, 10/20, 10-20, --10-20,
 *  October 20, Oct. 20th, Fri, Oct 20, 2026, 20 October 2026, 20 Oct.
 * "M/D" is read US-style (month first); when the first number cannot be a month (25/12) it is read day-first.
 * Impossible dates (Feb 30, month 13) are reported as such - never repaired.
 */
export function parseDateInput(raw: unknown): ParseDateResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  let s = raw.trim();
  if (!s) return { ok: false, reason: "empty" };
  s = s.replace(/\s+/g, " ");

  // ISO with optional time part: 2026-10-20, 2026-10-20T23:59:00Z, 2026/10/20
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  // Year-less ISO ("--10-20") or bare "10-20"
  m = /^(?:--)?(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return build(null, Number(m[1]), Number(m[2]));

  // Numeric with slashes / dots / dashes: M/D, M/D/YY, M/D/YYYY, D/M/YYYY when unambiguous
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] !== undefined ? expandYear(m[3]) : null;
    if (a > 12 && b <= 12) return build(year, b, a);
    return build(year, a, b);
  }

  // Words. Drop weekday names, ordinals, "of", commas and periods; keep month names, day and year numbers.
  const cleaned = s
    .toLowerCase()
    .replace(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b\.?/g, " ")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/(\d)-([a-z])/g, "$1 $2") // "26-Aug", "2-Sep-2026"
    .replace(/([a-z])-(\d)/g, "$1 $2") // "Sep-2"
    .replace(/\bof\b/g, " ")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  let month: number | null = null;
  const numbers: string[] = [];
  for (const token of tokens) {
    if (MONTH_NAMES[token] !== undefined) {
      if (month !== null) return { ok: false, reason: "unparseable" };
      month = MONTH_NAMES[token] as number;
    } else if (/^\d{1,4}$/.test(token)) {
      numbers.push(token);
    } else {
      return { ok: false, reason: "unparseable" };
    }
  }
  if (month === null || numbers.length === 0 || numbers.length > 2) return { ok: false, reason: "unparseable" };
  let day: number;
  let year: number | null = null;
  if (numbers.length === 1) {
    if (numbers[0]!.length === 4) return { ok: false, reason: "unparseable" }; // "October 2026" has no day
    day = Number(numbers[0]);
  } else {
    const [first, second] = numbers as [string, string];
    if (first.length === 4) return { ok: false, reason: "unparseable" };
    day = Number(first);
    year = expandYear(second);
  }
  return build(year, month, day);
}

// ── Year inference ────────────────────────────────────────────

export interface YearContext {
  termStart?: string | null;
  termEnd?: string | null;
  /** A weekday printed with the date, used to pick the year whose calendar agrees with it. */
  weekday?: DayOfWeek | null;
  /** Local date key of "today". */
  today: string;
}

/** Longest a term is assumed to last when only one of its ends is known (year inference only). */
const ASSUMED_TERM_DAYS = 250;

function termWindow(ctx: YearContext): { start: string; end: string; complete: boolean } | null {
  const start = isRealDateKey(ctx.termStart) ? ctx.termStart : null;
  const end = isRealDateKey(ctx.termEnd) ? ctx.termEnd : null;
  if (start && end) return start <= end ? { start, end, complete: true } : null;
  if (start) return { start, end: addDaysKey(start, ASSUMED_TERM_DAYS), complete: false };
  if (end) return { start: addDaysKey(end, -ASSUMED_TERM_DAYS), end, complete: false };
  return null;
}

export interface InferredYear {
  year: number;
  key: string;
  /** true = inside the (complete) term; false = the term is known and no year lands inside it; null = no complete term to compare with. */
  insideTerm: boolean | null;
}

/**
 * Pick the year for a month/day that has none:
 *  1. the year that puts the date inside [termStart, termEnd] (the earliest, if two do),
 *  2. otherwise the year that puts it nearest to today (a tie goes to the later one).
 * Returns null when the month/day exists in none of the candidate years.
 */
export function inferYear(month: number, day: number, ctx: YearContext): InferredYear | null {
  const anchors = [ctx.today, ctx.termStart, ctx.termEnd]
    .filter((k): k is string => isRealDateKey(k))
    .map((k) => Number(k.slice(0, 4)));
  if (anchors.length === 0) return null;
  const candidates: string[] = [];
  // Feb 29 exists only every fourth year, so look further out for it.
  const spread = month === 2 && day === 29 ? 4 : 1;
  for (let year = Math.min(...anchors) - spread; year <= Math.max(...anchors) + spread; year += 1) {
    if (isValidCalendarDate(year, month, day)) candidates.push(formatDateKey(year, month, day));
  }
  if (candidates.length === 0) return null;

  // A weekday printed next to the date ("Wed 2-Sep") tells which year is right: only 2026 has a Wednesday 2 September.
  const sameWeekday = ctx.weekday ? candidates.filter((key) => weekdayOf(key) === ctx.weekday) : [];
  if (sameWeekday.length > 0) candidates.splice(0, candidates.length, ...sameWeekday);

  const window = termWindow(ctx);
  if (window) {
    const inside = candidates.filter((key) => key >= window.start && key <= window.end).sort();
    if (inside.length > 0) {
      const key = inside[0]!;
      return { year: Number(key.slice(0, 4)), key, insideTerm: window.complete ? true : null };
    }
  }
  let best = candidates[0]!;
  let bestDistance = Math.abs(daysBetween(ctx.today, best));
  for (const key of candidates.slice(1)) {
    const distance = Math.abs(daysBetween(ctx.today, key));
    if (distance < bestDistance || (distance === bestDistance && key > best)) {
      best = key;
      bestDistance = distance;
    }
  }
  return { year: Number(best.slice(0, 4)), key: best, insideTerm: window?.complete ? false : null };
}

// ── Week-number dates ─────────────────────────────────────────

/** Monday that starts week 1: the Monday of the week the term starts in (a Saturday/Sunday start rolls to the next Monday). */
export function weekOneMonday(termStart: string): string | null {
  if (!isRealDateKey(termStart)) return null;
  const index = weekdayIndex(termStart);
  return index >= 5 ? addDaysKey(termStart, 7 - index) : addDaysKey(termStart, -index);
}

function findBreak(date: string, breaks: readonly DateBreak[] | undefined): DateBreak | null {
  return breaks?.find((b) => isRealDateKey(b.startDate) && isRealDateKey(b.endDate) && date >= b.startDate && date <= b.endDate) ?? null;
}

/** A week whose Monday-Friday are all inside breaks has no instruction ("Spring Break week"). */
function isBreakWeek(monday: string, breaks: readonly DateBreak[] | undefined): boolean {
  if (!breaks || breaks.length === 0) return false;
  for (let i = 0; i < 5; i += 1) if (!findBreak(addDaysKey(monday, i), breaks)) return false;
  return true;
}

export interface WeekNumberingOptions {
  /**
   * "calendar" (default): week N is N-1 calendar weeks after week 1, break weeks included.
   * "instructional": weeks that are entirely break are not counted (Week 8 comes after Spring Break).
   */
  numbering?: "calendar" | "instructional";
}

export interface WeekDate {
  date: string;
  /** Monday of that week. */
  weekStart: string;
  /** The break the date falls inside, if any (the date is NOT moved). */
  inBreak: DateBreak | null;
}

const MAX_WEEK_NUMBER = 60;

function mondayOfWeek(weekNumber: number, termStart: string, breaks: readonly DateBreak[] | undefined, opts: WeekNumberingOptions): string | null {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > MAX_WEEK_NUMBER) return null;
  const first = weekOneMonday(termStart);
  if (!first) return null;
  if (opts.numbering !== "instructional") return addDaysKey(first, (weekNumber - 1) * 7);
  let monday = first;
  let counted = 0;
  for (let guard = 0; guard < MAX_WEEK_NUMBER * 3; guard += 1) {
    if (!isBreakWeek(monday, breaks)) {
      counted += 1;
      if (counted === weekNumber) return monday;
    }
    monday = addDaysKey(monday, 7);
  }
  return null;
}

/**
 * The calendar date of "Week N <weekday>" in a term that starts on `termStart`.
 * Returns null when the week number, weekday or term start is unusable (never guesses a fallback).
 */
export function resolveWeekDate(
  weekNumber: number,
  weekday: DayOfWeek | string,
  termStart: string,
  breaks: readonly DateBreak[] = [],
  opts: WeekNumberingOptions = {},
): WeekDate | null {
  const day = normalizeWeekday(weekday);
  if (!day) return null;
  const monday = mondayOfWeek(weekNumber, termStart, breaks, opts);
  if (!monday) return null;
  const date = addDaysKey(monday, WEEKDAYS.indexOf(day));
  return { date, weekStart: monday, inBreak: findBreak(date, breaks) };
}

/** Monday-Sunday range of "Week N", for hints when the document names a week but no weekday. */
export function weekRange(
  weekNumber: number,
  termStart: string,
  breaks: readonly DateBreak[] = [],
  opts: WeekNumberingOptions = {},
): { start: string; end: string } | null {
  const monday = mondayOfWeek(weekNumber, termStart, breaks, opts);
  return monday ? { start: monday, end: addDaysKey(monday, 6) } : null;
}

// ── Range clamping ────────────────────────────────────────────

/**
 * Move a date inside [start, end]. Only for explicit "fix it" actions in the UI: resolution itself never
 * moves a date, it flags it (see `outOfRange`).
 */
export function clampDateToRange(
  date: string,
  start?: string | null,
  end?: string | null,
): { date: string; clamped: boolean; direction: "before" | "after" | null } {
  if (isRealDateKey(start) && date < start) return { date: start, clamped: true, direction: "before" };
  if (isRealDateKey(end) && date > end) return { date: end, clamped: true, direction: "after" };
  return { date, clamped: false, direction: null };
}

// ── Resolving one deliverable ─────────────────────────────────

export type DateConfidence = "explicit" | "inferred" | "missing";
export type DateSource = "explicit" | "year-inferred" | "week" | "none";

export interface RawDateFields {
  /** As reported by the model: a full date, a year-less date ("03-15" / "March 15"), or null. */
  dueDate: string | null;
  weekNumber: number | null;
  weekday: DayOfWeek | null;
  dateConfidence: DateConfidence;
  dateEvidence: string;
}

export interface DateResolutionContext extends YearContext {
  breaks?: readonly DateBreak[];
  weekNumbering?: WeekNumberingOptions["numbering"];
}

export interface ResolvedDate {
  /** The calendar date, or null when the document did not give one that can be trusted. */
  dueDate: string | null;
  source: DateSource;
  confidence: DateConfidence;
  isUndated: boolean;
  /** Strictly before today. An item due today is not past. */
  isPast: boolean;
  outOfRange: "before-term" | "after-term" | null;
  /** Name of the break the date falls in (informational; the date is not moved). */
  inBreak: string | null;
  problem: null | "impossible-date" | "unparseable-date" | "needs-term-start" | "week-without-weekday" | "week-out-of-range";
  /** For "Week 5" without a weekday: the range the student can pick a day from. */
  weekHint: { start: string; end: string } | null;
}

const CONFIDENCE_RANK: Record<DateConfidence, number> = { missing: 0, inferred: 1, explicit: 2 };
const RANK_TO_CONFIDENCE: DateConfidence[] = ["missing", "inferred", "explicit"];

function undated(problem: ResolvedDate["problem"], weekHint: ResolvedDate["weekHint"] = null): ResolvedDate {
  return {
    dueDate: null,
    source: "none",
    confidence: "missing",
    isUndated: true,
    isPast: false,
    outOfRange: null,
    inBreak: null,
    problem,
    weekHint,
  };
}

/** Turn what the model reported for one deliverable into a date - or honestly into "no date". */
export function resolveItemDate(raw: RawDateFields, ctx: DateResolutionContext): ResolvedDate {
  const reported = raw.dateConfidence;
  const hasEvidence = raw.dateEvidence.trim().length > 0;
  const breaks = ctx.breaks ?? [];
  const opts: WeekNumberingOptions = { numbering: ctx.weekNumbering };

  let dueDate: string | null = null;
  let source: DateSource = "none";
  let problem: ResolvedDate["problem"] = null;
  let weekHint: ResolvedDate["weekHint"] = null;

  // A model that says "missing" but still hands back a date with no quote to support it guessed: drop it.
  const trustDueDate = raw.dueDate !== null && raw.dueDate.trim() !== "" && !(reported === "missing" && !hasEvidence);

  if (trustDueDate) {
    const parsed = parseDateInput(raw.dueDate);
    if (!parsed.ok) {
      problem = parsed.reason === "impossible" ? "impossible-date" : "unparseable-date";
    } else if (parsed.date.year !== null) {
      dueDate = formatDateKey(parsed.date.year, parsed.date.month, parsed.date.day);
      source = "explicit";
    } else {
      const inferred = inferYear(parsed.date.month, parsed.date.day, { ...ctx, weekday: raw.weekday });
      if (inferred) {
        dueDate = inferred.key;
        source = "year-inferred";
      } else {
        problem = "impossible-date";
      }
    }
  }

  if (dueDate === null && raw.weekNumber !== null) {
    if (!isRealDateKey(ctx.termStart)) {
      problem = problem ?? "needs-term-start";
    } else if (raw.weekday) {
      const week = resolveWeekDate(raw.weekNumber, raw.weekday, ctx.termStart, breaks, opts);
      if (week) {
        dueDate = week.date;
        source = "week";
      } else {
        problem = problem ?? "week-out-of-range";
      }
    } else {
      // "Week 5" alone: due sometime that week. Offer the range; do not pick a day for the student.
      weekHint = weekRange(raw.weekNumber, ctx.termStart, breaks, opts);
      problem = problem ?? (weekHint ? "week-without-weekday" : "week-out-of-range");
    }
  }

  if (dueDate === null) return undated(problem, weekHint);

  const sourceRank = source === "explicit" ? 2 : 1;
  const confidenceRank = Math.min(CONFIDENCE_RANK[reported === "missing" ? "inferred" : reported], sourceRank);
  const start = isRealDateKey(ctx.termStart) ? ctx.termStart : null;
  const end = isRealDateKey(ctx.termEnd) ? ctx.termEnd : null;
  return {
    dueDate,
    source,
    confidence: RANK_TO_CONFIDENCE[confidenceRank] ?? "inferred",
    isUndated: false,
    isPast: dueDate < ctx.today,
    outOfRange: start && dueDate < start ? "before-term" : end && dueDate > end ? "after-term" : null,
    inBreak: findBreak(dueDate, breaks)?.name ?? null,
    problem: null,
    weekHint: null,
  };
}

// ── Season name ───────────────────────────────────────────────

/** "Fall 2026" for a term that starts on the given date. A guess at a LABEL only; the student can rename it. */
export function semesterNameFor(startKey: string): string {
  if (!isRealDateKey(startKey)) return "This semester";
  const month = Number(startKey.slice(5, 7));
  const year = startKey.slice(0, 4);
  const season = month >= 8 ? "Fall" : month >= 6 ? "Summer" : month >= 1 && month <= 5 ? "Spring" : "Term";
  return `${season} ${year}`;
}
