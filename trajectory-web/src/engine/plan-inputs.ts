import { busyCalendarEvents } from "./calendar-events";
import { followExamDates, sizePrepsToExams } from "./exam-prep-link";
import { sessionLengthFor } from "./intelligent-scheduler";
import type { AppState, GoogleCalendarEventLocal } from "./types";

/**
 * What the plan reads from outside calendar events (Google and iPhone together): their ids and times. Titles and read
 * times are left out, so reading the same events again (or a renamed event) is no change.
 */
export function calendarEventsKey(events: readonly GoogleCalendarEventLocal[] | undefined): string {
  return (events ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => [e.id, e.startDate, e.endDate ?? "", e.startTime ?? "", e.endTime ?? "", e.isAllDay ? 1 : 0].join("~"))
    .join("|");
}

/**
 * A string that changes exactly when something the semester plan is built from changes: open tasks, classes,
 * recurring commitments, the semester, the sleep window, study preferences, outside calendar events (synced Google
 * events and the events read from the iPhone's calendars) - and the calendar day (so the plan rolls forward when the
 * app is opened on a new day).
 *
 * It deliberately ignores everything the plan does not read or produces itself: block completion / acceptance,
 * a task flipping pending -> scheduled, priority scores, notes, grades. The provider re-plans only when this
 * key changes, so ordinary use never triggers a re-plan and a plan never triggers another one. What every plan writes
 * into an exam prep's study task (its exam's date, the mixed practice sizing it to the exam: lib/exam-prep-link.ts) is
 * keyed as the planner reads it, so a task saved with or without it is the same input (1.0.9 audit: a plan that sized a
 * prep triggered a second one, and after an update from 1.0.8 every Undo of the clean-up was cleaned up again).
 */
export function planInputsKey(
  state: Pick<AppState, "tasks" | "classes" | "recurringEvents" | "semester" | "healthPrefs" | "userPrefs" | "googleCalendarEvents"> & Partial<Pick<AppState, "deviceCalendarEvents">>,
  dayKey: string,
): string {
  const tasks = sizePrepsToExams(followExamDates(state.tasks), sessionLengthFor(state.userPrefs))
    .filter((task) => task.status === "pending" || task.status === "scheduled")
    .map((task) => [
      task.id, task.dueDate, task.dueTime ?? "", task.notBeforeDate ?? "", task.estimatedMinutes, task.completedMinutes ?? 0,
      task.difficulty, task.courseId, task.courseName, task.kind ?? "", task.name,
      (task.planningStrategy?.sessions ?? []).map((s) => `${s.minutes}/${s.targetDaysBeforeDue}/${s.purpose}`).join(","),
    ].join("~"))
    .join("|");
  const classes = state.classes
    .map((c) => [c.id, c.days.join(","), c.startTime, c.endTime, c.isAsynchronous ? 1 : 0, c.name, c.color].join("~"))
    .join("|");
  const recurring = (state.recurringEvents ?? [])
    .map((e) => [e.id, e.days.join(","), e.startTime, e.endTime, e.doNotSchedule ? 1 : 0, e.locked ? 1 : 0, e.title].join("~"))
    .join("|");
  const semester = state.semester
    ? [state.semester.id, state.semester.startDate, state.semester.endDate, state.semester.breaks.map((b) => `${b.startDate}..${b.endDate}`).join(",")].join("~")
    : "";
  const sleep = `${state.healthPrefs.bedtime}~${state.healthPrefs.wakeTime}`;
  const prefs = [
    state.userPrefs.studyStyle,
    state.userPrefs.energyProfile,
    (state.userPrefs.noGoZones ?? []).map((z) => `${z.startTime}-${z.endTime}`).join(","),
    // The study-load caps (lib/workload-analysis.ts studyLoadCaps) follow these.
    state.userPrefs.scheduleIntensity ?? "",
    state.userPrefs.dailyStudyCapMinutes ?? "",
    state.userPrefs.weeklyStudyCapMinutes ?? "",
  ].join("~");
  const calendar = calendarEventsKey(busyCalendarEvents(state));
  return [dayKey, tasks, classes, recurring, semester, sleep, prefs, calendar].join("##");
}
