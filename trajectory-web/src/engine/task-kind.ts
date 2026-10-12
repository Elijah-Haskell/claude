import type { ClassBlock, Semester, Task, TaskKind } from "./types";
import { isClassDay } from "./semester";
import { dateKeyOf, timeToMinutes, weekdayOfKey } from "./utils";

/**
 * How the planner decides what kind of work a task is. The rule is explicit so
 * the labels students see ("Practice Test", "Draft", ...) are never a surprise:
 *
 *  1. An explicit `task.kind` always wins (e.g. set from a syllabus item type).
 *  2. Otherwise the NAME is inspected. A name that contains a work-product noun
 *     (paper, essay, report, project, assignment, homework, ...) is an
 *     assignment even if it also says "final" or "test" ("Final paper",
 *     "Midterm essay").
 *  3. Otherwise exam / midterm / quiz / test (and a bare "final") is an exam-type
 *     task; a "quiz" is reported as kind "quiz".
 *  4. Everything else is "other" (treated as an assignment for labels).
 */
const WORK_PRODUCT = /\b(paper|essay|report|project|presentation|assignment|homework|draft|reading|readings|lab|portfolio|thesis|proposal|worksheet|problem set|pset|discussion|journal|reflection|case study|annotated)\b/i;
const QUIZ = /\bquiz(zes)?\b/i;
const EXAM = /\b(exam|exams|midterm|mid-term|test|final)\b/i;
// Phrases that are unambiguously exam preparation even when topic titles in the name mention a "report", "lab", ...
const STRONG_EXAM = /\bexam (runway|prep|review)\b|\b(midterm|mid-term|final) exam\b|\b(exam|test|quiz) (review|prep)\b|\bstudy for\b.*\b(exam|midterm|final|quiz|test)\b/i;

export function classifyTaskKind(task: Pick<Task, "name" | "kind">): TaskKind {
  if (task.kind) return task.kind;
  const name = task.name ?? "";
  if (STRONG_EXAM.test(name)) return QUIZ.test(name) ? "quiz" : "exam";
  if (WORK_PRODUCT.test(name)) {
    if (/\b(reading|readings)\b/i.test(name)) return "reading";
    if (/\b(project|presentation|portfolio|thesis)\b/i.test(name)) return "project";
    return "assignment";
  }
  if (QUIZ.test(name)) return "quiz";
  if (EXAM.test(name)) return "exam";
  return "other";
}

/** Only exam/quiz/test tasks are tested (retrieval practice) rather than worked on. */
export function isTestedTask(task: Pick<Task, "name" | "kind">): boolean {
  const kind = classifyTaskKind(task);
  return kind === "exam" || kind === "quiz";
}

/**
 * Assessments (quiz, exam, midterm, final, test) happen AT their deadline: prep after it is useless and a missed one
 * cannot be caught up. Same rule as isTestedTask; the separate name says why a caller asks.
 */
export function isAssessmentTask(task: Pick<Task, "name" | "kind">): boolean {
  return isTestedTask(task);
}

export interface TaskDeadline {
  /** Local due date ("YYYY-MM-DD"), "" when the task has no valid date. */
  dueKey: string;
  /**
   * Minutes after midnight on the due date by which the work must be finished; undefined = the whole due date is usable.
   * 0 means none of the due date is usable (a time-less quiz/exam on a day its course does not meet).
   */
  cutoffMinutes: number | undefined;
  /** Where the cutoff came from. */
  source: "due-time" | "class-start" | "start-of-day" | "none";
}

/**
 * When a task's deadline really is. An explicit due time always wins. A quiz or exam with a date but NO time happens
 * in class: its deadline is the start of that day's meeting of its course (the earliest one), or the start of the
 * day when the course does not meet that day, so no prep is ever planned after the class where the quiz is taken.
 * Other work without a time may use its whole due date (homework is usually due at the end of the day).
 */
export function taskDeadline(
  task: Pick<Task, "name" | "kind" | "dueDate" | "dueTime" | "courseId">,
  classes: ReadonlyArray<Pick<ClassBlock, "id" | "days" | "startTime" | "endTime">> = [],
  semester?: Pick<Semester, "startDate" | "endDate" | "breaks">,
): TaskDeadline {
  const dueKey = dateKeyOf(task.dueDate ?? "");
  if (task.dueTime && /^\d{1,2}:\d{2}$/.test(task.dueTime)) {
    const cutoff = timeToMinutes(task.dueTime);
    // "00:00" reads as "no time given" (end of the day), as it always has.
    return { dueKey, cutoffMinutes: cutoff > 0 ? cutoff : undefined, source: cutoff > 0 ? "due-time" : "none" };
  }
  if (!dueKey || !isAssessmentTask(task)) return { dueKey, cutoffMinutes: undefined, source: "none" };
  const weekday = weekdayOfKey(dueKey);
  const meets = isClassDay(semester, dueKey);
  const starts = classes
    .filter((cls) => cls.id === task.courseId && meets && cls.startTime && cls.endTime && cls.days.includes(weekday))
    .map((cls) => timeToMinutes(cls.startTime));
  if (starts.length > 0) return { dueKey, cutoffMinutes: Math.min(...starts), source: "class-start" };
  return { dueKey, cutoffMinutes: 0, source: "start-of-day" };
}

/**
 * Has the deadline passed at `nowMinutes` on `todayKey`? A "start-of-day" cutoff (a time-less quiz / exam on a day its
 * course does not meet) only says no prep fits that day: the assessment happens at some unknown time during it, so
 * it has not "already taken place" until the day is over.
 */
export function deadlinePassed(deadline: TaskDeadline, todayKey: string, nowMinutes: number): boolean {
  if (!deadline.dueKey) return false;
  if (deadline.dueKey < todayKey) return true;
  if (deadline.dueKey !== todayKey || deadline.cutoffMinutes === undefined || deadline.source === "start-of-day") return false;
  return deadline.cutoffMinutes <= nowMinutes;
}

/** Tasks whose deliverable is written/built, so sessions read Draft -> Work on -> Finalize. */
export function isWritingTask(task: Pick<Task, "name" | "kind">): boolean {
  if (isTestedTask(task)) return false;
  return /\b(paper|essay|report|draft|presentation|project|thesis|proposal|portfolio|lab|reflection|journal|case study)\b/i.test(task.name ?? "");
}
