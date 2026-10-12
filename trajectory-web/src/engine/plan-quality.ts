import { AppState, ScheduleBlock, Task } from "./types";
import { blockMinutes, remainingMinutes } from "./task-progress";
import { addDaysToKey, dateKeyOf, timeToMinutes } from "./utils";
import { describeMoreTime, dueLabel } from "./plan-format";
import { buildBusyMap } from "./busy-windows";
import { busyCalendarEvents } from "./calendar-events";
import { isClassDay } from "./semester";
import { isAssessmentTask } from "./task-kind";
import { isRegeneratedStructural } from "./week-planner";
import { examsPlannedByPrep } from "./exam-prep-link";

/** Local due date of a task; a missing/invalid date reads as "never due" so it can never look overdue. */
const dueKeyOf = (task: Task): string => dateKeyOf(task.dueDate) || "9999-12-31";

export interface PlanShortfall {
  taskId: string;
  taskName: string;
  dueDate: string;
  requestedMinutes: number;
  placedMinutes: number;
  missingMinutes: number;
}

export interface PlanQualityReport {
  severity: "healthy" | "watch" | "high";
  /** Active tasks with no study session on the calendar at all. */
  unplannedTaskIds: string[];
  /** Days from today on with more than five hours of study still to do (informational: see assessPlanQuality). */
  overloadedDates: string[];
  /** Tasks whose remaining minutes exceed the study time on the calendar before their deadline. */
  shortfalls: PlanShortfall[];
  /** Active tasks whose due date has already passed. */
  overdueTaskIds: string[];
  /**
   * Active tasks the student deferred ("Move to tomorrow") past their own deadline: their work cannot be done on
   * time any more. Always a problem, never "healthy".
   */
  deferredPastDeadlineTaskIds?: string[];
  /** Minutes of open work with no session before its deadline (shortfalls + deferred past the deadline). 0 when healthy. */
  unscheduledMinutes?: number;
  message: string;
}

export interface PlanQualityOptions {
  /**
   * Shortfalls reported by the solver for the same plan (SchedulingResult.shortfalls / WeekPlanResult.shortfalls).
   * They are authoritative about capacity: the time truly does not exist before the deadline.
   */
  solverShortfalls?: Array<Pick<PlanShortfall, "taskId" | "requestedMinutes" | "placedMinutes" | "missingMinutes"> & { taskName?: string; dueDate?: string }>;
}

/** A task counts as short once at least this many minutes are missing (ignores small manual trims). */
const SHORTFALL_TOLERANCE_MINUTES = 15;

/**
 * Deterministic post-plan quality gate. It explains whether active work is
 * represented on the calendar - including whether there are ENOUGH sessions
 * before each deadline. Days carrying too much study are listed (overloadedDates)
 * but left to Today's workload card, so the same warning is not shown four times.
 */
export function assessPlanQuality(
  tasks: Task[],
  scheduleBlocks: ScheduleBlock[],
  today: string,
  options: PlanQualityOptions = {},
): PlanQualityReport {
  const isActive = (task: Task) => task.status === "pending" || task.status === "scheduled";
  const overdueTaskIds = tasks.filter((task) => isActive(task) && dueKeyOf(task) < today).map((task) => task.id);
  // "Move to tomorrow" on (or after) the due date used to hide the task from this check while the solver dropped it:
  // the report said "healthy" with the work gone. Work deferred past its own deadline is always reported.
  const deferredPastDeadline = tasks.filter((task) =>
    isActive(task) && remainingMinutes(task) > 0 && Boolean(task.notBeforeDate) && task.notBeforeDate!.slice(0, 10) > dueKeyOf(task) && dueKeyOf(task) >= today);
  const deferredPastDeadlineTaskIds = deferredPastDeadline.map((task) => task.id);
  const activeTasks = tasks.filter((task) =>
    isActive(task) &&
    (!task.notBeforeDate || task.notBeforeDate <= today) &&
    !deferredPastDeadlineTaskIds.includes(task.id)
  );

  const openStudy = scheduleBlocks.filter((block) => block.type === "study" && block.taskId && block.completionStatus === "pending");
  // An exam planned through its open Exam Prep has no sessions of its own (lib/exam-prep-link.ts): its prep's sessions
  // are its plan (1.0.9 screenshot run: every exam with a prep read "Not planned yet").
  const plannedBy = examsPlannedByPrep(tasks);
  // Sessions that count toward a deadline: from today until the due date (overdue work has no upper bound).
  const placedFor = (task: Task): number => {
    const dueKey = dueKeyOf(task);
    const ids = new Set([task.id, plannedBy.get(task.id)]);
    return openStudy
      .filter((block) => ids.has(block.taskId) && block.date >= today && (dueKey < today || block.date <= dueKey))
      .reduce((sum, block) => sum + blockMinutes(block), 0);
  };
  const unplannedTaskIds = activeTasks.filter((task) => remainingMinutes(task) > 0 && placedFor(task) === 0).map((task) => task.id);
  // Study still to do, from today on: a session moved to tomorrow (skipped), missed or finished no longer loads its day.
  const studyMinutesByDate = scheduleBlocks.filter((block) => block.type === "study" && block.completionStatus === "pending" && block.date >= today).reduce<Record<string, number>>((totals, block) => {
    totals[block.date] = (totals[block.date] ?? 0) + blockMinutes(block);
    return totals;
  }, {});
  const overloadedDates = Object.entries(studyMinutesByDate).filter(([, minutes]) => minutes > 300).map(([date]) => date).sort();

  // ── Enough time before each deadline? ──
  const solverByTask = new Map((options.solverShortfalls ?? []).map((shortfall) => [shortfall.taskId, shortfall]));
  const shortfalls: PlanShortfall[] = [];
  // Tasks deferred to a later day (not past their deadline) are checked too, but only against the solver's word:
  // their sessions start later, so "nothing on the calendar yet" is expected for them.
  const deferredLater = tasks.filter((task) =>
    isActive(task) && Boolean(task.notBeforeDate) && task.notBeforeDate! > today && !deferredPastDeadlineTaskIds.includes(task.id));
  for (const task of [...activeTasks, ...deferredLater]) {
    const dueKey = dueKeyOf(task);
    const requested = remainingMinutes(task);
    if (requested <= 0) continue;
    const placed = placedFor(task);
    const solver = solverByTask.get(task.id);
    const deferred = deferredLater.includes(task);
    if (deferred && !solver) continue;
    const missing = solver ? Math.max(solver.missingMinutes, deferred ? 0 : requested - placed) : requested - placed;
    // The solver's own shortfall is exact (the time does not exist); the calendar-derived one tolerates small trims.
    if (missing <= 0 || (!solver && missing < SHORTFALL_TOLERANCE_MINUTES)) continue;
    // A task with no sessions at all is reported as "not yet on the calendar" unless the solver says there is no room for it.
    if (placed === 0 && !solver) continue;
    shortfalls.push({ taskId: task.id, taskName: task.name, dueDate: dueKey, requestedMinutes: requested, placedMinutes: placed, missingMinutes: missing });
  }
  for (const task of deferredPastDeadline) {
    if (shortfalls.some((shortfall) => shortfall.taskId === task.id)) continue;
    const requested = remainingMinutes(task);
    shortfalls.push({ taskId: task.id, taskName: task.name, dueDate: dueKeyOf(task), requestedMinutes: requested, placedMinutes: 0, missingMinutes: requested });
  }
  shortfalls.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.missingMinutes - a.missingMinutes);
  const unscheduledMinutes = shortfalls.reduce((sum, shortfall) => sum + shortfall.missingMinutes, 0);

  // A day over the study cap is reported in `overloadedDates` but does not make the plan unhealthy and is not in the
  // message: Today's workload card (lib/workload-analysis.ts) is the ONE place that says so, with the action to fix it.
  const problems = unplannedTaskIds.length > 0 || shortfalls.length > 0 || overdueTaskIds.length > 0;
  if (!problems) {
    return { severity: "healthy", unplannedTaskIds, overloadedDates, shortfalls, overdueTaskIds, deferredPastDeadlineTaskIds, unscheduledMinutes, message: "Your active work is represented on the calendar." };
  }

  const shortfallMessage = (shortfall: PlanShortfall): string =>
    deferredPastDeadlineTaskIds.includes(shortfall.taskId)
      ? `${shortfall.taskName} was moved past ${dueLabel(shortfall.dueDate, today)}, its deadline: ${describeMoreTime(shortfall.missingMinutes)} of it is not planned in time`
      : `You need ${describeMoreTime(shortfall.missingMinutes)} before ${dueLabel(shortfall.dueDate, today)} to finish ${shortfall.taskName}`;
  const notOnCalendar = unplannedTaskIds.filter((id) => !shortfalls.some((shortfall) => shortfall.taskId === id));
  const tested = new Set(tasks.filter((task) => isAssessmentTask(task)).map((task) => task.id));
  const missedTests = overdueTaskIds.filter((id) => tested.has(id)).length;
  const lateWork = overdueTaskIds.length - missedTests;
  const details = [
    ...shortfalls.slice(0, 2).map(shortfallMessage),
    shortfalls.length > 2 ? `${shortfalls.length - 2} more task${shortfalls.length - 2 === 1 ? "" : "s"} are also short on time` : "",
    notOnCalendar.length > 0 ? `${notOnCalendar.length} active task${notOnCalendar.length === 1 ? " is" : "s are"} not yet on the calendar` : "",
    lateWork > 0 ? `${lateWork} task${lateWork === 1 ? " is" : "s are"} overdue` : "",
    missedTests > 0 ? `${missedTests} quiz${missedTests === 1 ? " or exam has" : "zes or exams have"} passed without being marked done` : "",
  ].filter(Boolean).join("; ");

  const imminent = shortfalls.some((shortfall) => shortfall.dueDate <= addDaysToKey(today, 2));
  const severity: PlanQualityReport["severity"] =
    unscheduledMinutes >= 120 || imminent || deferredPastDeadline.length > 0 ? "high" : "watch";
  const closing = shortfalls.length > 0
    ? "Free up study time, move a deadline, or trim the estimate."
    : "Review these tasks or replan before relying on the plan.";
  return { severity, unplannedTaskIds, overloadedDates, shortfalls, overdueTaskIds, deferredPastDeadlineTaskIds, unscheduledMinutes, message: `${details}. ${closing}` };
}

// ── Conflicts ─────────────────────────────────────────────────

export type ConflictKind = "class" | "commitment" | "calendar" | "event" | "study";

export interface PlanConflict {
  /** The study session that overlaps something. */
  blockId: string;
  date: string;
  startTime: string;
  endTime: string;
  kind: ConflictKind;
  /** What it overlaps: the class / commitment / event title, or the other session's title. */
  withLabel: string;
  /** Set when it overlaps another study session. */
  withBlockId?: string;
}

/** The commitments study time must never overlap (a subset of AppState). */
export type ConflictSources = Pick<AppState, "classes" | "recurringEvents"> & Partial<Pick<AppState, "semester" | "googleCalendarEvents" | "deviceCalendarEvents">>;

export interface ConflictOptions {
  /** Only sessions on or after this date count (default: all). Pass today's key for "upcoming conflicts". */
  fromDate?: string;
}

/**
 * Every REAL double booking in the plan: a study session that overlaps a class meeting (only on days the class meets,
 * semester breaks respected), a recurring commitment, a Google Calendar event (all-day events cover the day), one of
 * the student's own events, or another study session. Open (pending) sessions only; sleep, transitions and no-study
 * zones are not double bookings. Each overlapping PAIR of study sessions is reported once.
 */
export function findConflicts(blocks: readonly ScheduleBlock[], sources: ConflictSources, options: ConflictOptions = {}): PlanConflict[] {
  const study = blocks.filter((block) => block.type === "study" && block.completionStatus === "pending" && (!options.fromDate || block.date >= options.fromDate));
  if (study.length === 0) return [];
  const dates = [...new Set(study.map((block) => block.date))].sort();
  const recurring = sources.recurringEvents ?? [];
  // The student's own events (anything that is not study, sleep, a transition or a generated class / commitment).
  const ownEvents = blocks.filter((block) =>
    block.type !== "study" && block.type !== "sleep" && block.type !== "buffer" && !isRegeneratedStructural(block, recurring) &&
    block.completionStatus !== "skipped" && block.completionStatus !== "missed");
  const busy = buildBusyMap(dates, {
    classes: sources.classes,
    recurringEvents: recurring,
    scheduleBlocks: ownEvents.map((block) => ({ ...block, accepted: true })),
    googleCalendarEvents: busyCalendarEvents(sources),
    noGoZones: [],
    isClassDay: sources.semester ? (date) => isClassDay(sources.semester, date) : undefined,
  }, { labels: true });
  const kindOf = (source: string | undefined): ConflictKind =>
    source === "class" ? "class" : source === "recurring" ? "commitment" : source === "calendar" ? "calendar" : "event";

  const span = (block: Pick<ScheduleBlock, "startTime" | "endTime">): [number, number] => {
    const start = timeToMinutes(block.startTime);
    const end = timeToMinutes(block.endTime);
    return [start, end > start ? end : 24 * 60];
  };
  const conflicts: PlanConflict[] = [];
  const byDate = new Map<string, ScheduleBlock[]>();
  for (const block of study) byDate.set(block.date, [...(byDate.get(block.date) ?? []), block]);
  for (const [date, list] of byDate) {
    list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i += 1) {
      const block = list[i]!;
      const [start, end] = span(block);
      const ref = { blockId: block.id, date, startTime: block.startTime, endTime: block.endTime };
      for (const interval of busy[date] ?? []) {
        if (start < interval.endMinutes && interval.startMinutes < end) conflicts.push({ ...ref, kind: kindOf(interval.source), withLabel: interval.label ?? "a commitment" });
      }
      for (let j = i + 1; j < list.length; j += 1) {
        const other = list[j]!;
        const [otherStart, otherEnd] = span(other);
        if (start < otherEnd && otherStart < end) conflicts.push({ ...ref, kind: "study", withLabel: other.title, withBlockId: other.id });
      }
    }
  }
  return conflicts.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.blockId.localeCompare(b.blockId));
}

/**
 * The number of real double bookings in the plan (see findConflicts). This is the ONLY number the UI / website may
 * show as "N conflicts"; "0 conflicts" is true exactly when this returns 0.
 */
export function countConflicts(blocks: readonly ScheduleBlock[], sources: ConflictSources, options: ConflictOptions = {}): number {
  return findConflicts(blocks, sources, options).length;
}
