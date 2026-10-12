/**
 * The Classes tab and Settings, as pure functions (app/(tabs)/profile.tsx, components/settings-sheet.tsx): what each
 * class's row says, the line over "Classes", and the values at the right of the Settings rows. Nothing here claims
 * more than the app knows: a class with no syllabus says so, and a row whose state is unknown shows no value.
 */
import { isRunwayTask } from "./exam-prep-link";
import { newSemesterId } from "./semester";
import { timeRangeLabel } from "./study-view";
import { semesterNameFor } from "./syllabus-dates";
import type { ClassBlock, DayOfWeek, RecurringEvent, Semester, SemesterBreak, SyllabusImport } from "./types";
import { addDaysToKey, daysBetweenKeys, formatTime, parseLocalDate, timeToMinutes, weekStartKeyOf } from "./utils";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DAY_ORDER: readonly DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const shortDay = (key: string) => {
  const date = parseLocalDate(key);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ── Classes ───────────────────────────────────────────────────────────────────

/** "Mon Wed Fri · 10:00 – 10:50 AM", or what is true of a class with no set time or no days yet. */
export function classScheduleLine(cls: Pick<ClassBlock, "days" | "startTime" | "endTime" | "isAsynchronous">): string {
  if (cls.isAsynchronous) return "No set class time";
  const days = DAY_ORDER.filter((day) => cls.days.includes(day)).join(" ");
  if (!days) return "No class days yet";
  if (!cls.startTime || !cls.endTime) return days;
  return `${days} · ${timeRangeLabel(cls.startTime, cls.endTime)}`;
}

/** The newest syllabus imported for a class, or undefined. */
export function latestImportFor(classId: string, imports: readonly SyllabusImport[] | undefined): SyllabusImport | undefined {
  return (imports ?? []).filter((entry) => entry.linkedClassId === classId).sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
}

/**
 * The quiet third line of a class's row: how many of its deadlines are still to do, the same ones Tasks lists, and
 * when its syllabus was added ("44 deadlines to do · syllabus added Aug 22"), or that it has no syllabus yet. Done
 * and skipped work is not counted, nor an exam prep's own study-time task (it is not a deadline: lib/week-view.ts).
 */
export function classPlanLine(input: {
  classId: string;
  className: string;
  tasks: readonly { id: string; courseId: string; courseName: string; status: string }[];
  imports: readonly SyllabusImport[] | undefined;
}): string {
  const ofClass = input.tasks.filter((task) => !isRunwayTask(task) && (task.courseId === input.classId || (task.courseId === "" && task.courseName === input.className)));
  const open = ofClass.filter((task) => task.status !== "done" && task.status !== "skipped").length;
  const latest = latestImportFor(input.classId, input.imports);
  const added = latest ? `syllabus added ${new Date(latest.importedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "no syllabus yet";
  if (open > 0) return `${count(open, "deadline")} to do · ${added}`;
  if (ofClass.length > 0) return `Every deadline done · ${added}`;
  return latest ? `No deadlines · ${added}` : "No syllabus yet";
}

/**
 * Can Ask AI read this syllabus? Only when its text was kept with the import (an old import, or one whose text
 * could not be read, has none): then the class's sheet says so and offers to add it again.
 */
export function syllabusReadableByAi(entry: Pick<SyllabusImport, "rawText"> | undefined): boolean {
  return Boolean(entry?.rawText && entry.rawText.trim().length > 0);
}

/** The line over "Classes": "Fall 2026 · Aug 26 to Dec 15", or what is missing. */
export function termEyebrow(semester: Pick<Semester, "name" | "startDate" | "endDate"> | null | undefined): string {
  if (!semester) return "No term dates yet";
  const range = `${shortDay(semester.startDate)} to ${shortDay(semester.endDate)}`;
  return semester.name ? `${semester.name} · ${range}` : range;
}

/** Under "Term dates and breaks": "16 weeks · 3 breaks", or "Not set yet". */
export function termRowLine(semester: Pick<Semester, "startDate" | "endDate" | "breaks"> | null | undefined): string {
  if (!semester) return "Not set yet";
  const days = daysBetweenKeys(semester.startDate, semester.endDate);
  const weeks = Number.isFinite(days) ? Math.max(1, Math.round((days + 1) / 7)) : 0;
  const breaks = semester.breaks.length === 0 ? "no breaks" : count(semester.breaks.length, "break");
  return weeks > 0 ? `${count(weeks, "week")} · ${breaks}` : breaks;
}

// ── The class sheet and the term sheet ────────────────────────────────────────

export interface ClassForm {
  name: string;
  isAsynchronous: boolean;
  days: readonly DayOfWeek[];
  startTime: string;
  endTime: string;
}

/** What is still missing before a class can be saved, in the words shown over Save; null when it can. */
export function classFormError(form: ClassForm): string | null {
  if (!form.name.trim()) return "Give the class a name";
  if (form.isAsynchronous) return null;
  if (form.days.length === 0) return "Choose at least one class day";
  if (!form.startTime || !form.endTime) return "Choose when the class starts and ends";
  if (timeToMinutes(form.endTime) <= timeToMinutes(form.startTime)) return "The class has to end after it starts";
  return null;
}

export interface ActivityForm {
  title: string;
  days: readonly DayOfWeek[];
  startTime: string;
  endTime: string;
}

/** What is still missing before work or an activity can be saved, in the words shown over the button; null when it can. */
export function activityFormError(form: ActivityForm): string | null {
  if (!form.title.trim()) return "Give it a name";
  if (form.days.length === 0) return "Choose at least one day";
  if (!form.startTime || !form.endTime) return "Choose when it starts and ends";
  // The plan holds it inside one day: something that runs past midnight is two entries.
  if (timeToMinutes(form.endTime) <= timeToMinutes(form.startTime)) return "It has to end after it starts";
  return null;
}

/** The quiet line of its row, when it is not the usual kind (drawn in the plan as a block): "" otherwise. */
export function activityPlanLine(event: Pick<RecurringEvent, "doNotSchedule">): string {
  return event.doNotSchedule ? "Only keeps the time clear" : "";
}

/** A starting point for a student who has not set a term yet: from today for about 15 weeks. */
export function defaultTerm(today: string, name = ""): Semester {
  return { id: newSemesterId(), name: name || semesterNameFor(today), startDate: today, endDate: addDaysToKey(today, 104), breaks: [] };
}

/** A new break: the Monday to Friday around the middle of the term, kept inside it. */
export function suggestBreak(term: Pick<Semester, "startDate" | "endDate">): SemesterBreak {
  const middle = addDaysToKey(term.startDate, Math.floor(daysBetweenKeys(term.startDate, term.endDate) / 2));
  const monday = weekStartKeyOf(middle);
  const startDate = monday < term.startDate ? term.startDate : monday;
  const friday = addDaysToKey(startDate, 4);
  return { name: "Break", startDate, endDate: friday > term.endDate ? term.endDate : friday };
}

// ── Settings ──────────────────────────────────────────────────────────────────

/** "11 PM", "7:30 AM": the hour without ":00". */
function shortClock(time: string): string {
  return formatTime(time).replace(":00", "");
}

/** "11 PM – 7 AM" */
export function sleepHoursLabel(bedtime: string, wakeTime: string): string {
  return `${shortClock(bedtime)} – ${shortClock(wakeTime)}`;
}

export interface SettingsValues {
  sleep: string;
  commitments: string;
  /** "" where the iPhone's calendars cannot be read (the browser preview): the row is then left out. */
  calendars: string;
  feeds: string;
  appleCalendar: string;
  reminders: string;
  appearance: string;
}

/** The value at the right of each Settings row. */
export function settingsValues(input: {
  bedtime: string;
  wakeTime: string;
  recurringEvents: number;
  calendarsSupported: boolean;
  calendarsOn: boolean;
  feeds: number;
  appleCalendarSupported: boolean;
  appleCalendarOn: boolean;
  /** null while it is not known whether iOS allows notifications. */
  remindersOn: boolean | null;
  dark: boolean;
}): SettingsValues {
  return {
    sleep: sleepHoursLabel(input.bedtime, input.wakeTime),
    commitments: input.recurringEvents === 0 ? "None" : String(input.recurringEvents),
    calendars: input.calendarsSupported ? (input.calendarsOn ? "On" : "Off") : "",
    feeds: input.feeds === 0 ? "Off" : count(input.feeds, "link"),
    appleCalendar: input.appleCalendarSupported ? (input.appleCalendarOn ? "On" : "Off") : "",
    reminders: input.remindersOn === null ? "" : input.remindersOn ? "On" : "Off",
    appearance: input.dark ? "Dark" : "Light",
  };
}
