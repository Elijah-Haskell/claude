// ============================================================
// Semester — the term being planned (pure helpers, no React)
// ============================================================
// Every date is a LOCAL calendar date key ("YYYY-MM-DD"), inclusive at both ends.

import type { AppState, Semester, SemesterBreak, Task } from "./types";
import { addDaysToKey, dateKeyOf, localDateKey, weekStartKeyOf } from "./utils";

/** Longest span the planner plans ahead when a Semester is set (about six months). */
export const MAX_SEMESTER_PLAN_WEEKS = 26;
/** Longest span the planner plans ahead when it has to infer the horizon from task due dates. */
export const MAX_INFERRED_PLAN_WEEKS = 20;
/** The plan always covers at least this many days from today (so next week always exists). */
export const MIN_PLAN_DAYS = 14;

/** True for a real calendar date written as "YYYY-MM-DD" ("2026-02-30" is not one). */
export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDaysToKey(value, 0) === value;
}

export type SemesterValidation =
  | { ok: true; semester: Semester }
  | { ok: false; error: string };

/**
 * Check a semester and return its normalised form (trimmed names, breaks sorted by start date).
 * Rules: valid date keys, startDate <= endDate, and every break lies inside the semester with start <= end.
 */
export function validateSemester(input: Semester): SemesterValidation {
  if (!input || typeof input !== "object") return { ok: false, error: "Semester is missing." };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the semester a name." };
  if (typeof input.id !== "string" || !input.id) return { ok: false, error: "Semester needs an id." };
  if (!isDateKey(input.startDate)) return { ok: false, error: "The start date is not a valid date." };
  if (!isDateKey(input.endDate)) return { ok: false, error: "The end date is not a valid date." };
  if (input.startDate > input.endDate) return { ok: false, error: "The semester must start on or before the day it ends." };

  const breaks: SemesterBreak[] = [];
  for (const brk of Array.isArray(input.breaks) ? input.breaks : []) {
    const label = (typeof brk?.name === "string" && brk.name.trim()) || "Break";
    if (!isDateKey(brk?.startDate) || !isDateKey(brk?.endDate)) return { ok: false, error: `${label}: the dates are not valid.` };
    if (brk.startDate > brk.endDate) return { ok: false, error: `${label} must start on or before the day it ends.` };
    if (brk.startDate < input.startDate || brk.endDate > input.endDate) {
      return { ok: false, error: `${label} must fall inside the semester (${input.startDate} to ${input.endDate}).` };
    }
    breaks.push({ name: label, startDate: brk.startDate, endDate: brk.endDate });
  }
  breaks.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
  return { ok: true, semester: { id: input.id, name, startDate: input.startDate, endDate: input.endDate, breaks } };
}

/** True when `key` falls inside one of the semester's breaks. */
export function isBreakDay(semester: Pick<Semester, "breaks"> | undefined, key: string): boolean {
  return Boolean(semester?.breaks?.some((brk) => key >= brk.startDate && key <= brk.endDate));
}

/**
 * Do class meetings happen on this date? Without a semester every day counts (older saves).
 * With one, only days from startDate to endDate that are not inside a break do.
 */
export function isClassDay(semester: Pick<Semester, "startDate" | "endDate" | "breaks"> | undefined, key: string): boolean {
  if (!semester) return true;
  if (key < semester.startDate || key > semester.endDate) return false;
  return !isBreakDay(semester, key);
}

export interface PlanningHorizon {
  /** First day the plan may place work on: today (the past is history and is never re-planned). */
  startKey: string;
  /** Last day covered by the plan (inclusive). */
  endKey: string;
}

/**
 * How far ahead the planner plans.
 *  - With a semester: through its end date (extended to the latest active task due date when a task falls
 *    after it), capped at MAX_SEMESTER_PLAN_WEEKS from today.
 *  - Without one: the latest active task due date + 7 days, capped at MAX_INFERRED_PLAN_WEEKS.
 *  - Never before today, and always at least MIN_PLAN_DAYS ahead.
 */
export function getPlanningHorizon(
  state: Pick<AppState, "tasks"> & { semester?: Pick<Semester, "endDate"> },
  now: Date = new Date(),
): PlanningHorizon {
  const startKey = localDateKey(now);
  const floor = addDaysToKey(startKey, MIN_PLAN_DAYS - 1);

  let latestDue = "";
  for (const task of state.tasks ?? []) {
    if (!isActive(task)) continue;
    const due = dateKeyOf(task.dueDate);
    if (isDateKey(due) && due >= startKey && due > latestDue) latestDue = due;
  }

  const semesterEnd = state.semester && isDateKey(state.semester.endDate) && state.semester.endDate >= startKey
    ? state.semester.endDate
    : "";
  let endKey: string;
  let capWeeks: number;
  if (semesterEnd) {
    endKey = latestDue > semesterEnd ? latestDue : semesterEnd;
    capWeeks = MAX_SEMESTER_PLAN_WEEKS;
  } else {
    endKey = latestDue ? addDaysToKey(latestDue, 7) : floor;
    capWeeks = MAX_INFERRED_PLAN_WEEKS;
  }
  if (endKey < floor) endKey = floor;
  const cap = addDaysToKey(startKey, capWeeks * 7 - 1);
  if (endKey > cap) endKey = cap;
  return { startKey, endKey };
}

/** Monday keys of every week from the week containing `startKey` through the week containing `endKey`. */
export function weekStartsInRange(startKey: string, endKey: string): string[] {
  const weeks: string[] = [];
  const last = weekStartKeyOf(endKey);
  for (let week = weekStartKeyOf(startKey); week <= last; week = addDaysToKey(week, 7)) weeks.push(week);
  return weeks;
}

function isActive(task: Task): boolean {
  return task.status === "pending" || task.status === "scheduled";
}

/** A new semester id (the caller may pass its own for tests). */
export function newSemesterId(now: number = Date.now()): string {
  return `semester-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
