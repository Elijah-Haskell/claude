/**
 * The Week tab's three views of the same plan (three days, seven days, a month), pure so their rules are unit-tested:
 *  - which dates are on screen, and where the back and forward buttons go;
 *  - the title ("Sep 30 – Oct 2", "October") and the line over it ("Fall 2026 · Week 6 of 16");
 *  - the month as rows of seven days, Monday first, and the marks under each day (an exam is a gold bar, anything
 *    else that is due is a dot in its class's colour);
 *  - the short labels the narrow seven-day columns can hold.
 */
import { isRunwayTask } from "./exam-prep-link";
import { classifyTaskKind } from "./task-kind";
import type { BadgeTone } from "./task-list";
import type { Semester, Task } from "./types";
import { addDaysToKey, dateKeyOf, daysBetweenKeys, weekStartKeyOf } from "./utils";
import { shortWord } from "./week-layout";

export type WeekView = "days" | "week" | "month";

export const WEEK_VIEWS: readonly { value: WeekView; label: string; accessibilityLabel: string }[] = [
  { value: "days", label: "3 days", accessibilityLabel: "Three days, with names on the blocks" },
  { value: "week", label: "Week", accessibilityLabel: "The whole week, seven days" },
  { value: "month", label: "Month", accessibilityLabel: "The month, with what is due each day" },
];

export function isWeekView(value: unknown): value is WeekView {
  return value === "days" || value === "week" || value === "month";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(key: string): { year: number; month: number; day: number } | null {
  const match = DATE_KEY.exec(key);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthStartKey = (year: number, month: number) => `${String(year).padStart(4, "0")}-${pad(month)}-01`;
const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

// ── What is on screen, and paging ─────────────────────────────

/** The days a time grid shows: three from the anchor, or the anchor's week from Monday. */
export function visibleDates(view: "days" | "week", anchorKey: string): string[] {
  const start = view === "days" ? anchorKey : weekStartKeyOf(anchorKey);
  return Array.from({ length: view === "days" ? 3 : 7 }, (_, index) => addDaysToKey(start, index));
}

/** First day of the month `offset` months from the anchor's. */
function shiftMonth(anchorKey: string, offset: number): string {
  const at = parts(anchorKey);
  if (!at) return anchorKey;
  const index = at.year * 12 + (at.month - 1) + offset;
  return monthStartKey(Math.floor(index / 12), (((index % 12) + 12) % 12) + 1);
}

/**
 * Where the back / forward buttons go: three days, a week or a month on.
 *  - Three days: exactly three days, so consecutive pages never skip or repeat a day (today may then sit in the
 *    middle of a page; from today, stepping away and back still ends on today).
 *  - A week or a month that holds today is anchored ON today, so switching to three days from there starts today.
 */
export function stepAnchor(view: WeekView, anchorKey: string, direction: 1 | -1, todayKey: string): string {
  if (view === "days") return addDaysToKey(anchorKey, direction * 3);
  if (view === "month") {
    const next = shiftMonth(anchorKey, direction);
    return sameMonth(next, todayKey) ? todayKey : next;
  }
  const next = addDaysToKey(anchorKey, direction * 7);
  return visibleDates("week", next).includes(todayKey) ? todayKey : next;
}

/** Is today on the page the anchor shows? */
export function showsToday(view: WeekView, anchorKey: string, todayKey: string): boolean {
  return view === "month" ? sameMonth(anchorKey, todayKey) : visibleDates(view, anchorKey).includes(todayKey);
}

// ── Title and the line over it ────────────────────────────────

const shortMonth = (month: number) => (MONTHS[month - 1] ?? "").slice(0, 3);

/** "Sep 30 – Oct 2", "Oct 7 – 9", "Dec 30 – Jan 1". */
export function dateRangeTitle(firstKey: string, lastKey: string): string {
  const first = parts(firstKey);
  const last = parts(lastKey);
  if (!first || !last) return "";
  const start = `${shortMonth(first.month)} ${first.day}`;
  return first.month === last.month && first.year === last.year ? `${start} – ${last.day}` : `${start} – ${shortMonth(last.month)} ${last.day}`;
}

/** "October", or "January 2027" when it is not this year. */
export function monthTitle(anchorKey: string, todayKey: string): string {
  const at = parts(anchorKey);
  if (!at) return "";
  const name = MONTHS[at.month - 1] ?? "";
  return anchorKey.slice(0, 4) === todayKey.slice(0, 4) ? name : `${name} ${at.year}`;
}

type Term = Pick<Semester, "name" | "startDate" | "endDate">;

/** Week number of a date inside the term (1-based, weeks start on Monday), or null outside it. */
function termWeek(dateKey: string, term: Term): number | null {
  if (!DATE_KEY.test(term.startDate) || !DATE_KEY.test(term.endDate)) return null;
  if (dateKey > term.endDate) return null;
  const week = Math.floor(daysBetweenKeys(weekStartKeyOf(term.startDate), weekStartKeyOf(dateKey)) / 7) + 1;
  return week >= 1 ? week : null;
}

/**
 * The line over the title: "Fall 2026 · Week 6 of 16" for days inside the term, "Fall 2026 · Weeks 6 to 10" for a
 * month, the term's name alone when the page is outside it, and "Your week" / "Your month" before a term is set.
 * It has to fit on one line beside the Ask AI button. A term whose name would not fit in its last weeks (the longest
 * line, "Weeks 16 to 16") is left out for the whole term ("Week 6 of 16"), so the line does not change shape as the
 * weeks go by.
 */
export function periodEyebrow(view: WeekView, firstKey: string, lastKey: string, term: Term | null | undefined, maxLength = 30): string {
  const fallback = view === "month" ? "Your month" : "Your week";
  if (!term) return fallback;
  const name = term.name?.trim() || "This term";
  const total = termWeek(term.endDate, term);
  // A page that starts before the term or ends after it still counts the weeks it shares with it.
  const from = termWeek(firstKey < term.startDate ? term.startDate : firstKey, term);
  const to = termWeek(lastKey > term.endDate ? term.endDate : lastKey, term);
  if (!total || !from || !to || lastKey < term.startDate || firstKey > term.endDate) return name.length > maxLength ? fallback : name;
  const weeks = from === to ? `Week ${from} of ${total}` : `Weeks ${from} to ${to}`;
  const fits = `${name} · Weeks ${total} to ${total}`.length <= maxLength;
  return fits ? `${name} · ${weeks}` : weeks;
}

// ── The month ─────────────────────────────────────────────────

export interface MonthCell {
  key: string;
  day: number;
  /** False for the days of the months before and after that fill the first and last row. */
  inMonth: boolean;
}

/** The anchor's month as whole weeks, Monday first (28, 35 or 42 days). */
export function monthCells(anchorKey: string): MonthCell[] {
  const at = parts(anchorKey);
  if (!at) return [];
  const first = monthStartKey(at.year, at.month);
  const lastDay = addDaysToKey(shiftMonth(first, 1), -1);
  const start = weekStartKeyOf(first);
  const count = daysBetweenKeys(start, addDaysToKey(weekStartKeyOf(lastDay), 6)) + 1;
  return Array.from({ length: count }, (_, index) => {
    const key = addDaysToKey(start, index);
    return { key, day: Number(key.slice(8, 10)), inMonth: sameMonth(key, first) };
  });
}

/**
 * Is this task a deadline of its own? An exam prep's study-time task is not: it only follows its exam's date
 * (lib/exam-prep-link.ts), and the exam is already on that day.
 */
export function isDeadline(task: Pick<Task, "id">): boolean {
  return !isRunwayTask(task);
}

export interface DayMark {
  /** An exam is drawn as a gold bar; anything else that is due is a dot. */
  exam: boolean;
  /** The class's colour, for a dot. */
  color?: string;
}

/** How many marks fit under a day. */
export const MAX_DAY_MARKS = 3;

/**
 * The marks under each day that has open work due: exams first (a gold bar each), then one dot per other deadline in
 * its class's colour, at most three in all. Finished and skipped work leaves no mark.
 */
export function monthMarks(
  tasks: readonly Pick<Task, "id" | "name" | "kind" | "dueDate" | "status" | "courseId">[],
  classes: readonly { id: string; color?: string }[],
): Map<string, DayMark[]> {
  const colorOf = new Map(classes.map((cls) => [cls.id, cls.color]));
  const byDay = new Map<string, DayMark[]>();
  for (const task of tasks) {
    const day = dateKeyOf(task.dueDate ?? "");
    if (task.status === "done" || task.status === "skipped" || !DATE_KEY.test(day) || !isDeadline(task)) continue;
    const mark: DayMark = { exam: classifyTaskKind(task) === "exam", color: colorOf.get(task.courseId) };
    byDay.set(day, [...(byDay.get(day) ?? []), mark]);
  }
  for (const [day, marks] of byDay) {
    byDay.set(day, [...marks.filter((mark) => mark.exam), ...marks.filter((mark) => !mark.exam)].slice(0, MAX_DAY_MARKS));
  }
  return byDay;
}

/** The day the month opens on: today when it is in the month, else the first day with something due, else the 1st. */
export function defaultMonthDay(anchorKey: string, todayKey: string, hasMarks: (dateKey: string) => boolean): string {
  if (sameMonth(anchorKey, todayKey)) return todayKey;
  const days = monthCells(anchorKey).filter((cell) => cell.inMonth);
  return days.find((cell) => hasMarks(cell.key))?.key ?? days[0]?.key ?? anchorKey;
}

/** What the term says about one day ("No classes: Fall break", "First day of classes"), or "". */
export function termDayNote(dateKey: string, term: Pick<Semester, "startDate" | "endDate" | "breaks"> | null | undefined): string {
  if (!term) return "";
  const brk = (term.breaks ?? []).find((candidate) => dateKey >= candidate.startDate && dateKey <= candidate.endDate);
  if (brk) return `No classes: ${brk.name}`;
  if (dateKey === term.startDate) return "First day of classes";
  if (dateKey === term.endDate) return "Last day of the term";
  return "";
}

/** How far a day is, counted in days ("13 days"): red today and tomorrow, gold inside a week, quiet after. */
export function countdownBadge(dateKey: string, todayKey: string): { label: string; tone: BadgeTone } | null {
  const days = daysBetweenKeys(todayKey, dateKey);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return { label: "Today", tone: "red" };
  if (days === 1) return { label: "Tomorrow", tone: "red" };
  return { label: `${days} days`, tone: days < 7 ? "gold" : "neutral" };
}

// ── Labels for the grids ──────────────────────────────────────

/** "8 AM" beside the three-day grid, "8a" beside the seven-day one (hour 0 and 24 are midnight). */
export function hourRailLabel(hour: number, short: boolean): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 || 12;
  return short ? `${twelve}${h < 12 ? "a" : "p"}` : `${twelve} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * What a seven-day column can hold for a block: the class's short name, cut to its first part when there is only
 * room for one line ("CHEM 101" -> "CHEM"), or for something with no class the first word of its name, shortened
 * the way a class's is ("Work shift" -> "WORK", "Volleyball" -> "VOLL": lib/week-layout.ts shortWord).
 */
export function narrowBlockLabel(courseLabel: string | undefined, title: string, lines: 1 | 2): string {
  if (courseLabel) return lines === 1 ? (courseLabel.split(" ")[0] ?? courseLabel) : courseLabel;
  return shortWord(title.trim().split(/[^A-Za-z0-9]+/).filter(Boolean)[0] ?? "");
}

const EXAM_PREP = /^exam prep\s*[—–-]\s*(.+)$/i;
const PREP_STAGE = /^(?:Learn|Review|Quiz yourself|Practice test|Practice)\s*:\s*(?:Topic\s+\d+\s*:\s*)?(.+)$/i;

/**
 * A study session's name for a narrow column, given its name without the class ("Exam prep — Learn: Topic 3:
 * Short-Term Forecasting"). An exam-prep session is named by its topic, with "Exam prep" as the line under it; the
 * stage (Learn, Review, Quiz yourself) stays on Today and in the session's sheet, where there is room for it.
 */
export function gridSessionText(displayTitle: string): { title: string; sub?: string } {
  const prep = EXAM_PREP.exec(displayTitle.trim());
  if (!prep) return { title: displayTitle };
  const rest = prep[1]!.trim();
  return { title: PREP_STAGE.exec(rest)?.[1]?.trim() || rest, sub: "Exam prep" };
}

/** "9:30–10:45" (no AM / PM: the hour rail beside the block says it). */
export function compactTimeRange(startTime: string, endTime: string): string {
  const clock = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return `${(h ?? 0) % 12 || 12}:${pad(m ?? 0)}`;
  };
  return `${clock(startTime)}–${clock(endTime)}`;
}
