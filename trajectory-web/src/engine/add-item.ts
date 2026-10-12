/**
 * The one Add sheet (components/add-sheet.tsx): what its three short forms turn into, and what is missing before
 * they can be added. Pure, so the rules are unit-tested without the screen.
 *
 *  - Task:  a name, a class (or none), a due date and the time it needs.
 *  - Exam:  the same shape, saved as a task of kind "exam" with an optional start time, so the planner gives it
 *           study sessions the way it does for an exam read from a syllabus.
 *  - Event: a name, a day and a start and end time. One time = a block on that day. Every week = a recurring
 *           commitment on that weekday. Either way study sessions are planned around it.
 */
import { BLOCK_COLORS, type ClassBlock, type RecurringEvent, type ScheduleBlock, type Task } from "./types";
import { addDaysToKey, timeToMinutes, weekdayOfKey } from "./utils";

export type AddKind = "task" | "event" | "exam";

export interface AddTaskForm {
  name: string;
  /** "" = no class ("General"). */
  courseId: string;
  /** "YYYY-MM-DD" */
  dueDate: string;
  minutes: number;
}

export interface AddExamForm {
  name: string;
  courseId: string;
  date: string;
  /** "HH:MM", or "" when the time is not known. */
  time: string;
  studyMinutes: number;
}

export interface AddEventForm {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  repeatsWeekly: boolean;
}

export const TASK_MINUTE_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;
export const EXAM_STUDY_MINUTE_OPTIONS = [60, 120, 180, 240, 360, 480] as const;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export function defaultTaskForm(todayKey: string): AddTaskForm {
  return { name: "", courseId: "", dueDate: addDaysToKey(todayKey, 7), minutes: 60 };
}

export function defaultExamForm(todayKey: string): AddExamForm {
  return { name: "", courseId: "", date: addDaysToKey(todayKey, 14), time: "", studyMinutes: 180 };
}

/** `dateKey` = the day the sheet was opened for (a day on Week), when that day has not passed. */
export function defaultEventForm(todayKey: string, dateKey?: string): AddEventForm {
  const date = dateKey && DATE_KEY.test(dateKey) && dateKey >= todayKey ? dateKey : todayKey;
  return { name: "", date, startTime: "18:00", endTime: "20:00", repeatsWeekly: false };
}

/** What is still missing, in the words shown above the Add button; null when the form can be added. */
export function taskFormError(form: AddTaskForm, todayKey: string): string | null {
  if (!form.name.trim()) return "Give the task a name";
  if (!DATE_KEY.test(form.dueDate)) return "Pick a due date";
  if (form.dueDate < todayKey) return "The due date has already passed";
  if (!(form.minutes > 0)) return "Choose how long it needs";
  return null;
}

export function examFormError(form: AddExamForm, todayKey: string): string | null {
  if (!form.name.trim()) return "Give the exam a name";
  if (!DATE_KEY.test(form.date)) return "Pick the exam's date";
  if (form.date < todayKey) return "That date has already passed";
  if (form.time && !TIME.test(form.time)) return "Pick the exam's time again";
  return null;
}

export function eventFormError(form: AddEventForm, todayKey: string): string | null {
  if (!form.name.trim()) return "Give the event a name";
  if (!DATE_KEY.test(form.date)) return "Pick a day";
  if (!form.repeatsWeekly && form.date < todayKey) return "That day has already passed";
  if (!TIME.test(form.startTime) || !TIME.test(form.endTime)) return "Pick a start and an end time";
  if (timeToMinutes(form.endTime) <= timeToMinutes(form.startTime)) return "The end time must be after the start time";
  return null;
}

function courseNameOf(courseId: string, classes: readonly Pick<ClassBlock, "id" | "name">[]): string {
  return classes.find((cls) => cls.id === courseId)?.name ?? "General";
}

export function taskFromForm(form: AddTaskForm, classes: readonly Pick<ClassBlock, "id" | "name">[], id: string, createdAt: string): Task {
  const known = classes.some((cls) => cls.id === form.courseId);
  return {
    id,
    name: form.name.trim(),
    courseId: known ? form.courseId : "",
    courseName: courseNameOf(form.courseId, classes),
    dueDate: form.dueDate,
    estimatedMinutes: form.minutes,
    difficulty: 2,
    requiresOnCampus: false,
    status: "pending",
    createdAt,
    // Typed by the student: never a date the app worked out.
    dateConfidence: "user",
  };
}

export function examFromForm(form: AddExamForm, classes: readonly Pick<ClassBlock, "id" | "name">[], id: string, createdAt: string): Task {
  const known = classes.some((cls) => cls.id === form.courseId);
  return {
    id,
    name: form.name.trim(),
    courseId: known ? form.courseId : "",
    courseName: courseNameOf(form.courseId, classes),
    dueDate: form.date,
    ...(form.time ? { dueTime: form.time } : {}),
    estimatedMinutes: form.studyMinutes,
    difficulty: 3,
    requiresOnCampus: false,
    status: "pending",
    createdAt,
    kind: "exam",
    dateConfidence: "user",
  };
}

/** A one-time event: made by hand, so a re-plan never moves, replaces or drops it. */
export function blockFromEventForm(form: AddEventForm, id: string): ScheduleBlock {
  return {
    id,
    type: "free",
    title: form.name.trim(),
    date: form.date,
    startTime: form.startTime,
    endTime: form.endTime,
    locked: false,
    accepted: true,
    userEdited: true,
    color: BLOCK_COLORS.free,
    completionStatus: "pending",
  };
}

/** An event that repeats every week on the weekday of the day picked. */
export function recurringFromEventForm(form: AddEventForm, id: string): RecurringEvent {
  return {
    id,
    title: form.name.trim(),
    days: [weekdayOfKey(form.date)],
    startTime: form.startTime,
    endTime: form.endTime,
    color: BLOCK_COLORS.recurring,
    locked: true,
    doNotSchedule: false,
  };
}

/** "30m", "1h", "1h 30m": the choices under "Time needed". */
export function minutesChoiceLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
