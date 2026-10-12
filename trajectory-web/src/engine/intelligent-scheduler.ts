// ============================================================
// Trajectory Intelligent Scheduling Engine v6
// ============================================================
// Evidence-based scheduling using peer-reviewed cognitive science:
//
// SPACED REPETITION (Cepeda et al. 2006, 2008; Nature Rev Neurosci 2016)
//  - Optimal gap ≈ 10-20% of retention interval
//  - First session within 2 days of task creation
//  - Review intervals: 1, 3, 7 days preferred
//  - Never schedule all study in one block close to deadline
//
// INTERLEAVING (Taylor & Rohrer 2010; Rohrer 2012; Sana & Yan 2022)
//  - Mixing subjects produces 2× better retention than blocked practice
//  - Penalize same-course back-to-back scheduling
//
// CHRONOBIOLOGY (Evans, Kelley & Kelley 2017 — Frontiers Human Neurosci)
//  - Peak cognitive performance: 10 AM–12 PM and 5–9 PM for most students
//  - Post-lunch dip (1–3 PM): avoid hard cognitive work
//  - Evening chronotypes (50%+ of college students): peak after noon
//
// ULTRADIAN RHYTHMS (Lavie 1990s; Huberman 2021)
//  - 90-min focus cycles from wake time
//  - Breaks of 10-20 min between cycles
//  - Max 4-5 deep study blocks per day
//
// COGNITIVE LOAD THEORY (Sweller 1988)
//  - Hard tasks need peak energy windows
//  - Easy tasks can fill trough periods
//  - Single-subject blocks reduce extraneous load
//
// RETRIEVAL PRACTICE / TESTING EFFECT (Roediger & Karpicke 2006)
//  - Final sessions before an EXAM/QUIZ = retrieval practice, not re-reading
//  - Only tested tasks (exam / quiz / test) get "Practice Test" sessions;
//    assignments get Draft / Work on / Finalize sessions (see lib/task-kind.ts)
//
// SLEEP (Creswell et al. 2023 — PNAS)
//  - 1 hour lost sleep = 0.07 GPA reduction
//  - Never push study past midnight
//  - Sleep consolidates memory — adequate sleep > extra study
//
// BACKWARD PLANNING + PROCRASTINATION (Steel 2007; Jones 2021)
//  - Sessions are planned BACK from the deadline at kind-specific lead times
//    (lib/exam-prep-plan.ts runwayDaysFor): a quiz 2-4 days out, homework within
//    the week before, exams and projects across the 14-day prep window. Work is
//    never parked on the earliest free day just because it is free.
//  - Breaks between sessions are GAPS in the calendar, never extra "sessions"
//  - Sub-deadlines for large tasks
//
// HONESTY CONTRACT
//  - Every task reports how many of the requested minutes were actually placed.
//    Anything that does not fit before the deadline is returned as an explicit
//    shortfall - the plan never silently pretends to be complete.
//  - Overdue tasks are planned as soon as possible (today / tomorrow) and flagged. A quiz / exam whose time has
//    passed is NOT: it already happened, so it is reported (OverdueTask.missedAssessment) and nothing is planned.
//  - A quiz / exam with a date but no time happens in class: nothing is planned after the start of that day's class
//    (lib/task-kind.ts taskDeadline).
//  - All date keys are LOCAL calendar dates (lib/utils.ts localDateKey).
//
// LOAD CAPS (lib/workload-analysis.ts studyLoadCaps)
//  - Minutes-based daily / weekly caps. Sessions stay near their deadline; only when those days are at the cap does
//    work move earlier, never beyond twice the task's runway. Caps bend (never drop work) when nothing else fits,
//    except on a day the student moved or locked a session onto (SchedulingOptions.cappedDates): the work that does
//    not fit elsewhere is reported short instead, unless it is due within two days.
//  - Inside each free gap several start times are scored, not just the first minute of the gap.
// ============================================================

import {
  AppState,
  BLOCK_COLORS,
  GoogleCalendarEventLocal,
  PlannedStudySession,
  ScheduleBlock,
  Semester,
  StudySessionPurpose,
  Task,
} from "./types";
import {
  addDaysToKey,
  dateKeyOf,
  daysBetweenKeys,
  getWeekStart,
  localDateKey,
  minutesToTime,
  timeToMinutes,
  weekdayOfKey,
} from "./utils";
import { getPlanningWindow } from "./awake-window";
import { buildBusyMap, BusyMap, Interval } from "./busy-windows";
import { busyCalendarEvents } from "./calendar-events";
import { MIN_SESSION_MINUTES, planSessionChunks } from "./session-chunks";
import { classifyTaskKind, deadlinePassed as hasDeadlinePassed, isAssessmentTask, isTestedTask, isWritingTask, taskDeadline } from "./task-kind";
import { examPrepLeads, normalizeTopics, planExamTopics, runwayDaysFor } from "./exam-prep-plan";
import { blockMinutes, remainingMinutes } from "./task-progress";
import { describeMinutes, describeMoreTime, dueLabel } from "./plan-format";
import { isClassDay } from "./semester";
import { StudyLoadCaps, studyLoadCaps } from "./workload-analysis";

export interface ScheduledStudyBlock {
  taskId: string;
  taskName: string;
  courseName: string;
  courseId: string;
  courseColor: string;
  date: string;           // "YYYY-MM-DD" (local calendar date)
  dayLabel: string;       // "Monday", "Tuesday", etc.
  startTime: string;      // "HH:MM"
  endTime: string;        // "HH:MM"
  durationMinutes: number;
  reason: string;         // human-readable explanation of why this slot was chosen
  isPostClassReview: boolean;
  isRetrievalPractice: boolean; // only exam/quiz tasks: final sessions before the test (Testing Effect)
  sessionNumber: number;  // 1-based position among the REAL sessions of this task
  totalSessions: number;  // number of real sessions placed for this task
  /** What this session is for; drives the label ("Draft", "Finalize", "Practice Test", ...). */
  purpose: StudySessionPurpose;
  /** Exam prep only, when the syllabus says what the exam covers: the topics this session works through ("Topics 1-2"). */
  topicLabel?: string;
  /** Exam prep only, when the exam's topics are known: the last session of the runway, a review of everything. */
  isFinalReview?: boolean;
  /** True when the task's due date has already passed and this session is catch-up work. */
  isOverdue?: boolean;
  strategyLabel?: string;
  strategyPurpose?: string;
  strategyRationale?: string;
}

/** Work the planner could not fit before the deadline. */
export interface TaskShortfall {
  taskId: string;
  taskName: string;
  dueDate: string;
  requestedMinutes: number;
  placedMinutes: number;
  missingMinutes: number;
  overdue: boolean;
  reason: string;
}

export interface OverdueTask {
  taskId: string;
  taskName: string;
  dueDate: string;
  daysOverdue: number;
  /**
   * A quiz / exam whose time has passed without being marked done. It has already happened, so no catch-up or prep
   * is planned for it: the student only has to mark it done or skipped.
   */
  missedAssessment?: boolean;
}

export interface SchedulingResult {
  scheduledBlocks: ScheduledStudyBlock[];
  /** Tasks with ANY minutes that could not be placed (fully or partially). See `shortfalls` for numbers. */
  unscheduledTasks: Array<{ taskId: string; taskName: string; reason: string }>;
  shortfalls: TaskShortfall[];
  overdueTasks: OverdueTask[];
  summary: string;
  totalStudyMinutes: number;
  daysWithStudy: string[];
}

export interface SchedulingOptions {
  /** Clock injection (defaults to `new Date()`). */
  now?: Date;
  /** Minutes per task id that are already covered elsewhere (e.g. accepted blocks kept as-is). */
  coveredMinutes?: Record<string, number>;
  /**
   * The covering sessions themselves, per task id (their strategy label when they have one, and their minutes).
   * With this the solver keeps the OTHER named strategist sessions of a partly covered task instead of falling
   * back to unnamed chunks. Should describe the same sessions as `coveredMinutes`.
   */
  coveredSessions?: Record<string, Array<{ label?: string; minutes: number }>>;
  /** Longest planning window in days (default 112 = 16 weeks). A whole-semester plan raises it. */
  maxHorizonDays?: number;
  /** Dates on which no NEW study may be placed (e.g. a day the student just deferred with "Move to tomorrow"). */
  blockedDates?: string[];
  /** Daily / weekly study-load caps (default: studyLoadCaps(userPrefs), lib/workload-analysis.ts). */
  loadCaps?: StudyLoadCaps;
  /**
   * Tasks placed before every other one, whatever their priority (a stable re-plan that frees the days a task could
   * not fit into gives that task the first pick of them).
   */
  firstTaskIds?: ReadonlySet<string>;
  /**
   * Dates holding a session the student moved there or locked (lib/week-planner.ts): no new study takes such a day past
   * the daily cap, in any placement tier but the last resort for work due within two days. The stable re-plan lets
   * suggestions go from such a day while it is over the cap, so a last-resort tier that put them back made every other
   * re-plan undo the one before (1.0.9 audit); urgent work it puts back lands where it was.
   */
  cappedDates?: ReadonlySet<string>;
  /**
   * Busy time several solves share (lib/week-planner.ts solveWindow): the first `blocks` of `state.scheduleBlocks` and
   * the first `extra` of `extraOccupied` are the same in each of them, so their busy windows (with the classes,
   * commitments, calendar events and no-study zones) are built once into `occupied`, and each solve adds only what
   * follows them. The same busy time as without it.
   */
  sharedBusy?: SharedBusy;
}

/** See SchedulingOptions.sharedBusy; `dates` and `occupied` are filled in by the first solve. */
export interface SharedBusy {
  blocks: number;
  extra: number;
  dates?: string[];
  occupied?: BusyMap;
}

export type SchedulerState = Pick<AppState, "classes" | "recurringEvents" | "scheduleBlocks" | "healthPrefs" | "userPrefs"> & {
  googleCalendarEvents?: GoogleCalendarEventLocal[];
  /** Events from this iPhone's calendars; busy time merges them with Google events (busyCalendarEvents). */
  deviceCalendarEvents?: GoogleCalendarEventLocal[];
  /** When set, classes only occupy time between its start and end dates and never during a break. */
  semester?: Semester;
};

/** Gap kept free after every study session. This is the buffer: time between sessions, not extra work. */
export const SESSION_GAP_MINUTES = 10;
/** Stable cap on study sessions per day. */
export const DAILY_STUDY_CAP = 4;
const PREP_WINDOW_DAYS = 14;
/** Work due within this many days (or overdue) may take a day the student moved a session onto past the daily cap. */
export const URGENT_DAYS = 2;
/** Candidate start times inside a free gap are tried on this grid (plus the gap's own start and end). */
const START_GRID_MINUTES = 30;
/** Sessions starting after 21:00 score lower. */
const LATE_EVENING_MINUTES = 21 * 60;
const MAX_HORIZON_DAYS = 112; // 16 weeks = one full semester

interface TimeSlot {
  startMinutes: number;
  endMinutes: number;
}

function findFreeSlots(
  occupied: Interval[],
  windowStart: number,
  windowEnd: number,
  minDuration: number
): TimeSlot[] {
  const sorted = [...occupied].sort((a, b) => a.startMinutes - b.startMinutes);
  const free: TimeSlot[] = [];
  let cursor = windowStart;

  for (const slot of sorted) {
    if (slot.startMinutes >= windowEnd) break;
    if (slot.startMinutes - cursor >= minDuration) {
      free.push({ startMinutes: cursor, endMinutes: slot.startMinutes });
    }
    cursor = Math.max(cursor, slot.endMinutes);
  }

  if (windowEnd - cursor >= minDuration) {
    free.push({ startMinutes: cursor, endMinutes: windowEnd });
  }

  return free;
}

/** "Monday, Sep 7" per date key, remembered: formatting a date is the slowest step of turning a plan into blocks. */
const dayFullNames = new Map<string, string>();
function getDayFullName(dateStr: string): string {
  let name = dayFullNames.get(dateStr);
  if (name === undefined) {
    name = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    dayFullNames.set(dateStr, name);
  }
  return name;
}

interface PlacedSession {
  date: string;
  startMinutes: number;
  endMinutes: number;
  reason: string;
  isPostClassReview: boolean;
  strategist?: PlannedStudySession;
}

/**
 * Sessions covered by minutes the student has already completed are dropped from
 * the front of the strategist's plan (earliest lead time first); a partly covered
 * session is shortened. Sessions that end up under 15 minutes are dropped.
 */
function trimSessionsForProgress(sessions: PlannedStudySession[], completedMinutes: number): PlannedStudySession[] {
  let credit = Math.max(0, completedMinutes);
  const out: PlannedStudySession[] = [];
  for (const session of sessions) {
    if (credit >= session.minutes) {
      credit -= session.minutes;
      continue;
    }
    out.push(credit > 0 ? { ...session, minutes: session.minutes - credit } : session);
    credit = 0;
  }
  return out.filter((session) => session.minutes >= 15);
}

/** Length of a full study session for the student's study style (Albulescu et al. 2022; 90-min ultradian cycles). */
export function sessionLengthFor(userPrefs: Pick<AppState["userPrefs"], "studyStyle">): number {
  return userPrefs.studyStyle === "short_bursts" ? 45 : 90;
}

/**
 * Minutes of sessions a task settles at when nothing of it is planned yet: its remaining estimate, or its named
 * strategist sessions (what progress has not covered) when those add up to more. Kept sessions beyond this are surplus;
 * below the remaining estimate the solver plans more. 0 once nothing remains.
 */
export function plannedMinutesFor(task: Task): number {
  const remaining = remainingMinutes(task);
  if (remaining <= 0) return 0;
  const named = [...(task.planningStrategy?.sessions ?? [])]
    .filter((session) => session.minutes >= 15)
    .sort((a, b) => b.targetDaysBeforeDue - a.targetDaysBeforeDue);
  const left = trimSessionsForProgress(named, task.completedMinutes ?? 0).reduce((sum, session) => sum + session.minutes, 0);
  return Math.max(remaining, left);
}

/**
 * The farthest ahead of its deadline (in days) the solver puts a session of this task before its last resort: twice
 * the task's runway (lib/exam-prep-plan.ts runwayDaysFor, or the strategist's earliest session), and at least the
 * 14-day prep window.
 */
export function farthestLeadDays(task: Task, minutes: number, userPrefs: Pick<AppState["userPrefs"], "studyStyle">): number {
  const runway = runwayDaysFor(classifyTaskKind(task), Math.max(1, Math.ceil(minutes / sessionLengthFor(userPrefs))));
  const strategist = (task.planningStrategy?.sessions ?? [])
    .reduce((most, session) => Math.max(most, Number.isFinite(session.earliestDaysBeforeDue) ? session.earliestDaysBeforeDue : 0), 0);
  return Math.max(PREP_WINDOW_DAYS, 2 * Math.max(runway, strategist));
}

/**
 * Busy time per day of `dates` (the solve's window, from `weekStartKey`): classes, commitments, no-study zones, kept
 * blocks, calendar events and `extraOccupied`. With SchedulingOptions.sharedBusy the shared part is built once over the
 * longest window a solve can have and copied; intervals only add up, so their order does not matter.
 */
function busyMapFor(
  dates: string[],
  state: SchedulerState,
  extraOccupied: Array<{ date: string; startTime: string; endTime: string }>,
  weekStartKey: string,
  options: SchedulingOptions,
): BusyMap {
  const sources = {
    classes: state.classes,
    recurringEvents: state.recurringEvents,
    googleCalendarEvents: busyCalendarEvents(state),
    noGoZones: state.userPrefs.noGoZones ?? [],
    isClassDay: state.semester ? (date: string) => isClassDay(state.semester, date) : undefined,
  };
  const shared = options.sharedBusy;
  if (!shared) return buildBusyMap(dates, { ...sources, scheduleBlocks: state.scheduleBlocks, extraOccupied });
  if (!shared.occupied || !shared.dates) {
    const span = Math.max(14, options.maxHorizonDays ?? MAX_HORIZON_DAYS);
    shared.dates = Array.from({ length: span }, (_, index) => addDaysToKey(weekStartKey, index));
    shared.occupied = buildBusyMap(shared.dates, { ...sources, scheduleBlocks: state.scheduleBlocks.slice(0, shared.blocks), extraOccupied: extraOccupied.slice(0, shared.extra) });
  }
  // A window that starts elsewhere or runs longer (the first days of a map spill into the next) is built as usual.
  if (shared.dates[0] !== dates[0] || dates.length > shared.dates.length) {
    return buildBusyMap(dates, { ...sources, scheduleBlocks: state.scheduleBlocks, extraOccupied });
  }
  const own = buildBusyMap(dates, {
    classes: [],
    recurringEvents: [],
    noGoZones: [],
    scheduleBlocks: state.scheduleBlocks.slice(shared.blocks),
    extraOccupied: extraOccupied.slice(shared.extra),
  });
  for (const date of dates) own[date] = [...(shared.occupied[date] ?? []), ...(own[date] ?? [])];
  return own;
}

// ── Main intelligent scheduling function ─────────────────────

export function scheduleTasksIntelligently(
  tasks: Task[],
  state: SchedulerState,
  weekStartDate?: Date,
  extraOccupied?: Array<{ date: string; startTime: string; endTime: string }>,
  options: SchedulingOptions = {},
): SchedulingResult {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const weekStartKey = localDateKey(weekStartDate ?? getWeekStart(now));

  const planning = getPlanningWindow(state.healthPrefs.wakeTime, state.healthPrefs.bedtime);
  const wakeMinutes = timeToMinutes(state.healthPrefs.wakeTime);
  const dayWindowStart = planning.start;
  const dayWindowEnd = planning.end;

  // Keep daily workload limits stable. The planner protects a person's chosen
  // sleep window but never uses wearable or journal recovery scores to silently
  // reduce or expand their academic commitments.
  const studyBlocksPerDay: Record<string, number> = {};

  // ── Which work needs planning? ─────────────────────────────
  interface WorkItem {
    task: Task;
    requested: number;
    dueKey: string;
    /** Deadline on the due date in minutes (undefined: the whole day; 0: none of it). See lib/task-kind.ts taskDeadline. */
    cutoff: number | undefined;
    /** Catch-up work: the deadline has passed, or the student deferred the work past it (never a quiz / exam). */
    overdue: boolean;
    strategistSessions: PlannedStudySession[];
  }
  const unscheduledTasks: SchedulingResult["unscheduledTasks"] = [];
  const shortfalls: TaskShortfall[] = [];
  const overdueTasks: OverdueTask[] = [];
  const workItems: WorkItem[] = [];
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "scheduled") continue;
    const covered = options.coveredMinutes?.[task.id] ?? 0;
    const remaining = Math.max(0, remainingMinutes(task) - covered);
    if (remaining <= 0) {
      // Kept sessions cover it: nothing to place, but late work is still reported as overdue (never a quiz / exam:
      // its kept prep is released once it has taken place).
      const dueKey = dateKeyOf(task.dueDate);
      const notBefore = task.notBeforeDate ? task.notBeforeDate.slice(0, 10) : "";
      if (remainingMinutes(task) > 0 && !isAssessmentTask(task) && /^\d{4}-\d{2}-\d{2}$/.test(dueKey) &&
        (hasDeadlinePassed(taskDeadline(task, state.classes, state.semester), todayKey, nowMinutes) || notBefore > dueKey)) {
        overdueTasks.push({ taskId: task.id, taskName: task.name, dueDate: dueKey, daysOverdue: Math.max(0, daysBetweenKeys(dueKey, todayKey)) });
      }
      continue;
    }
    const strategistAll = [...(task.planningStrategy?.sessions ?? [])]
      .filter((session) => session.minutes >= 15)
      .sort((a, b) => b.targetDaysBeforeDue - a.targetDaysBeforeDue);
    // Named strategist sessions ("Learn: Topic", "Final review") are kept when part of the task is already covered:
    // a covered session that carries a strategy label cancels exactly that planned session, and any other covered
    // minutes are credited like completed progress. Without per-session information (`coveredSessions`), covered
    // minutes cannot be attributed to a named session, so the task falls back to plain chunks of what is left.
    const coveredSessions = options.coveredSessions?.[task.id];
    let strategistSessions: PlannedStudySession[] = [];
    if (strategistAll.length > 0 && (!covered || coveredSessions)) {
      let planned = strategistAll;
      let credit = task.completedMinutes ?? 0;
      for (const session of coveredSessions ?? []) {
        const at = session.label ? planned.findIndex((candidate) => candidate.label === session.label) : -1;
        if (at >= 0) planned = planned.filter((_, index) => index !== at);
        else credit += session.minutes;
      }
      strategistSessions = trimSessionsForProgress(planned, credit);
    }
    const requested = strategistSessions.length > 0
      ? strategistSessions.reduce((sum, session) => sum + session.minutes, 0)
      : remaining;
    const dueKey = dateKeyOf(task.dueDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueKey)) {
      // Without a due date there is nothing to plan backwards from: say so instead of guessing.
      const reason = "This task has no valid due date, so it could not be scheduled.";
      shortfalls.push({ taskId: task.id, taskName: task.name, dueDate: task.dueDate, requestedMinutes: requested, placedMinutes: 0, missingMinutes: requested, overdue: false, reason });
      unscheduledTasks.push({ taskId: task.id, taskName: task.name, reason });
      continue;
    }
    const deadline = taskDeadline(task, state.classes, state.semester);
    const cutoff = deadline.cutoffMinutes;
    const deadlinePassed = hasDeadlinePassed(deadline, todayKey, nowMinutes);
    const notBefore = task.notBeforeDate ? task.notBeforeDate.slice(0, 10) : "";
    const deferredPastDeadline = notBefore > dueKey;
    if (isAssessmentTask(task) && (deadlinePassed || deferredPastDeadline)) {
      if (deadlinePassed) {
        // A quiz / exam that already happened: "catch-up" prep after it would be meaningless. Report it, plan nothing.
        overdueTasks.push({ taskId: task.id, taskName: task.name, dueDate: dueKey, daysOverdue: Math.max(0, daysBetweenKeys(dueKey, todayKey)), missedAssessment: true });
      } else {
        const reason = `Its prep was moved past ${dueLabel(dueKey, todayKey)}, when it takes place, so none of it is planned.`;
        shortfalls.push({ taskId: task.id, taskName: task.name, dueDate: dueKey, requestedMinutes: requested, placedMinutes: 0, missingMinutes: requested, overdue: false, reason });
        unscheduledTasks.push({ taskId: task.id, taskName: task.name, reason });
      }
      continue;
    }
    workItems.push({ task, requested, dueKey, cutoff, overdue: deadlinePassed || deferredPastDeadline, strategistSessions });
  }

  // ── Build dynamic window: from weekStart to latest due date (max 16 weeks) ──
  const effectiveDueKeys = workItems.map((item) => {
    if (!item.overdue) return item.dueKey;
    const notBefore = item.task.notBeforeDate ? item.task.notBeforeDate.slice(0, 10) : "";
    return addDaysToKey(notBefore > todayKey ? notBefore : todayKey, 1);
  });
  const latestDueKey = effectiveDueKeys.reduce(
    (latest, key) => (key > latest ? key : latest),
    addDaysToKey(weekStartKey, 13),
  );
  const windowDays = Math.max(14, Math.min(options.maxHorizonDays ?? MAX_HORIZON_DAYS, daysBetweenKeys(weekStartKey, latestDueKey) + 1));
  const allDates: string[] = [];
  for (let i = 0; i < windowDays; i++) allDates.push(addDaysToKey(weekStartKey, i));
  const lastDateKey = allDates[allDates.length - 1]!;

  // ── Busy time per day: classes, recurring, no-go zones, blocks, Google and iPhone calendar events ──
  const occupied = busyMapFor(allDates, state, extraOccupied ?? [], weekStartKey, options);
  for (const date of options.blockedDates ?? []) occupied[date]?.push({ startMinutes: 0, endMinutes: 24 * 60 });

  // Meals are no longer a product feature: the solver no longer reads meal preferences. Lunch and dinner hours
  // are only discouraged by the soft "meal time" signal below, never reserved.

  // Class-adjacent windows: a 15-min transition after class, a review window after it, and a prep window before
  const postClassWindows: Record<string, Array<{ startMinutes: number; endMinutes: number; courseId: string; courseName: string }>> = {};
  const preClassWindows: Record<string, Array<{ startMinutes: number; endMinutes: number; courseId: string; courseName: string }>> = {};
  /** End of every class meeting per date (any course), for the short "breather after class" preference. */
  const classEnds: Record<string, number[]> = {};
  for (const dateStr of allDates) {
    postClassWindows[dateStr] = [];
    preClassWindows[dateStr] = [];
    classEnds[dateStr] = [];
    const weekday = weekdayOfKey(dateStr);
    const classesMeet = isClassDay(state.semester, dateStr);
    for (const cls of state.classes) {
      if (!classesMeet || !cls.startTime || !cls.endTime || !cls.days.includes(weekday)) continue;
      const startMin = timeToMinutes(cls.startTime);
      const endMin = timeToMinutes(cls.endTime);
      if (endMin <= startMin) continue;
      classEnds[dateStr]!.push(endMin);
      const bufferEnd = Math.min(endMin + 15, dayWindowEnd);
      if (bufferEnd > endMin) occupied[dateStr]!.push({ startMinutes: endMin, endMinutes: bufferEnd });
      const reviewStart = bufferEnd;
      const reviewEnd = Math.min(reviewStart + 60, dayWindowEnd);
      if (reviewEnd > reviewStart + 20) {
        postClassWindows[dateStr]!.push({ startMinutes: reviewStart, endMinutes: reviewEnd, courseId: cls.id, courseName: cls.name });
      }
      const prepEnd = startMin - 5; // 5-min buffer before class
      const prepStart = Math.max(dayWindowStart, startMin - 60);
      if (prepEnd > prepStart + 20) {
        preClassWindows[dateStr]!.push({ startMinutes: prepStart, endMinutes: prepEnd, courseId: cls.id, courseName: cls.name });
      }
    }
  }

  // ── Ultradian rhythm peaks ────────────────────────────────────
  // Humans have ~90-min focus cycles. Peaks occur at:
  // wake+0, wake+100, wake+200, wake+300, wake+400 (minutes)
  // Each peak window is 90 min wide.
  function getUltradianScore(startMinutes: number): number {
    const peakOffsets = [0, 100, 200, 300, 400];
    let best = 0;
    for (const offset of peakOffsets) {
      const peakStart = wakeMinutes + offset;
      const dist = Math.abs(startMinutes - peakStart);
      if (dist < 45) best = Math.max(best, 25 - Math.floor(dist / 5) * 2); // max +25 at peak center
      else if (dist < 90) best = Math.max(best, 10 - Math.floor((dist - 45) / 5));
    }
    return best;
  }

  // ── Completion history signal ─────────────────────────────────
  // Build a map of hour → skip rate from past schedule blocks
  const hourSkipCount: Record<number, number> = {};
  const hourTotalCount: Record<number, number> = {};
  for (const block of state.scheduleBlocks) {
    if (block.type !== "study") continue;
    const hour = Math.floor(timeToMinutes(block.startTime) / 60);
    hourTotalCount[hour] = (hourTotalCount[hour] ?? 0) + 1;
    if (block.completionStatus === "skipped") {
      hourSkipCount[hour] = (hourSkipCount[hour] ?? 0) + 1;
    }
  }
  function getSkipPenalty(startMinutes: number): number {
    const hour = Math.floor(startMinutes / 60);
    const total = hourTotalCount[hour] ?? 0;
    if (total < 3) return 0; // not enough data
    const skipRate = (hourSkipCount[hour] ?? 0) / total;
    return -Math.round(skipRate * 30); // up to -30 for 100% skip rate
  }

  // ── Day / week load tracking ──────────────────────────────────
  // Study already on the calendar that this plan keeps (accepted, locked, started or finished sessions) counts
  // toward each day's and week's load, so the caps below see the real total.
  const caps = options.loadCaps ?? studyLoadCaps(state.userPrefs);
  const dayStudyMinutes: Record<string, number> = {};
  const weekStudyMinutes: number[] = [];
  const weekIndexes = new Map<string, number>();
  const weekIndexOf = (date: string) => {
    let index = weekIndexes.get(date);
    if (index === undefined) {
      index = Math.floor(daysBetweenKeys(weekStartKey, date) / 7);
      weekIndexes.set(date, index);
    }
    return index;
  };
  const addLoad = (date: string, minutes: number) => {
    dayStudyMinutes[date] = (dayStudyMinutes[date] ?? 0) + minutes;
    const week = weekIndexOf(date);
    weekStudyMinutes[week] = (weekStudyMinutes[week] ?? 0) + minutes;
  };
  for (const block of state.scheduleBlocks) {
    if (block.type !== "study" || occupied[block.date] === undefined) continue;
    const kept = block.completionStatus === "done" ||
      (block.completionStatus === "pending" && Boolean(block.accepted || block.locked || block.startedAt || block.userEdited));
    if (!kept) continue;
    addLoad(block.date, blockMinutes(block));
    studyBlocksPerDay[block.date] = (studyBlocksPerDay[block.date] ?? 0) + 1;
  }
  const lastCourseOnDay: Record<string, string> = {};
  const lastStudyDatePerCourse: Record<string, string> = {};
  for (const block of state.scheduleBlocks) {
    if (block.type === "study" && block.courseId) {
      const prev = lastStudyDatePerCourse[block.courseId];
      if (!prev || block.date > prev) {
        lastStudyDatePerCourse[block.courseId] = block.date;
      }
    }
  }

  // ── Sort tasks by evidence-based priority score ────────────
  // Deadline proximity (40%), difficulty (20%), estimated time (15%), staleness (10%),
  // exam proximity (5%) (Cepeda et al. 2008; Steel 2007 meta-analysis). Overdue work counts as due today, so it outranks anything due later.
  const priority = new Map<WorkItem, number>();
  for (const item of workItems) {
    const { task } = item;
    const daysToDue = item.overdue ? 0 : Math.max(0, daysBetweenKeys(todayKey, item.dueKey) + 1);
    const urgency = Math.exp(-daysToDue / 7) * 40; // e^(-days/7): 1 day ~0.87, 7 days ~0.37, 14 days ~0.14
    const difficulty = (task.difficulty / 5) * 20;
    const timeScore = Math.min(1, item.requested / 180) * 15;
    const lastStudied = lastStudyDatePerCourse[task.courseId];
    const staleness = lastStudied
      ? Math.min(1, Math.max(0, daysBetweenKeys(lastStudied, todayKey) / 7)) * 10
      : 10; // never studied = max staleness
    const examBonus = isTestedTask(task) ? 5 : 0;
    priority.set(item, urgency + difficulty + timeScore + staleness + examBonus);
  }
  const first = (item: WorkItem) => (options.firstTaskIds?.has(item.task.id) ? 1 : 0);
  const ordered = [...workItems].sort((a, b) => first(b) - first(a) || priority.get(b)! - priority.get(a)!);

  // ── Determine session duration based on study style ───────
  // Research: 45-90 min blocks optimal (Albulescu et al. 2022 meta-analysis)
  // Pomodoro (25 min) is good for procrastination but too short for deep learning
  // 90-min aligns with ultradian focus cycles (Lavie 1990s)
  const baseSessionDuration = sessionLengthFor(state.userPrefs);

  // ── Energy profile preferred start time ───────────────────
  const energyPreferredStart =
    state.userPrefs.energyProfile === "morning"
      ? timeToMinutes("08:30")
      : state.userPrefs.energyProfile === "afternoon"
      ? timeToMinutes("13:00")
      : timeToMinutes("19:00");

  type ScoredSlot = { slot: TimeSlot; score: number; reason: string; isPostClassReview: boolean };

  // Today's plan starts 15 minutes from now, on the quarter hour: a start of "now + 15" (14:22) moved every minute, so
  // each automatic re-plan reported "1 session moved" for a session nobody touched.
  const todayEarliest = Math.ceil((nowMinutes + 15) / 15) * 15;

  /** Free slots on a date that can hold `duration` minutes (nothing before now; nothing after `endCap`). */
  function freeSlotsFor(date: string, duration: number, endCap?: number): TimeSlot[] {
    const windowStart = date === todayKey ? Math.max(dayWindowStart, todayEarliest) : dayWindowStart;
    const windowEnd = endCap === undefined ? dayWindowEnd : Math.min(dayWindowEnd, endCap);
    return findFreeSlots(occupied[date] ?? [], windowStart, windowEnd, duration);
  }

  function scoreSlots(
    task: Task,
    dueKey: string,
    date: string,
    freeSlots: TimeSlot[],
    blockDuration: number,
    strategistSession: PlannedStudySession | undefined,
  ): ScoredSlot[] {
    // ── Day load penalty (balance across the week) ─────────────────────
    const dayLoadMinutes = dayStudyMinutes[date] ?? 0;
    const dayLoadPenalty = -Math.floor(dayLoadMinutes / 30) * 3; // -3 per 30 min already placed
    const slotDayOfWeek = weekdayOfKey(date);
    const weekend = slotDayOfWeek === "Sat" || slotDayOfWeek === "Sun";

    // Every free gap offers many start times, not just its first minute (which put weekend sessions at 7:30 AM and
    // study right on the heels of class): the gap's start and end, and every half hour in between.
    const candidates: Array<{ gap: TimeSlot; s: TimeSlot }> = [];
    for (const gap of freeSlots) {
      const latest = gap.endMinutes - blockDuration;
      if (latest < gap.startMinutes) continue;
      const starts = new Set<number>([gap.startMinutes, latest]);
      for (let t = Math.ceil((gap.startMinutes + 1) / START_GRID_MINUTES) * START_GRID_MINUTES; t < latest; t += START_GRID_MINUTES) starts.add(t);
      for (const start of starts) candidates.push({ gap, s: { startMinutes: start, endMinutes: start + blockDuration } });
    }

    // What depends on the day only is worked out once, not for every start time (the same scores and reasons).
    let timingBonus = 0;
    if (strategistSession) {
      const targetDate = addDaysToKey(dueKey, -strategistSession.targetDaysBeforeDue);
      timingBonus = Math.max(0, 42 - Math.abs(daysBetweenKeys(targetDate, date)) * 9);
    }
    const lastDate = lastStudyDatePerCourse[task.courseId];
    let spacingBonus = 0;
    let spacingReason = "";
    if (lastDate) {
      const daysSinceLast = daysBetweenKeys(lastDate, date);
      const daysUntilDueFromHere = Math.max(1, daysBetweenKeys(date, dueKey) + 1);
      const optimalGap = Math.max(1, Math.round(daysUntilDueFromHere * 0.15));
      const gapDist = Math.abs(daysSinceLast - optimalGap);
      const classicBonus = [1, 3, 7].reduce((best, interval) => {
        const dist = Math.abs(daysSinceLast - interval);
        if (dist === 0) return Math.max(best, 15);
        if (dist === 1) return Math.max(best, 8);
        return best;
      }, 0);
      const optimalGapBonus = gapDist === 0 ? 20 : gapDist <= 1 ? 12 : gapDist <= 2 ? 6 : 0;
      spacingBonus = Math.max(classicBonus, optimalGapBonus);
      if (spacingBonus >= 15) spacingReason = `Optimal review interval — ${daysSinceLast} day${daysSinceLast !== 1 ? "s" : ""} since last ${task.courseName} session (spaced repetition)`;
    }
    const dayFromToday = lastDate ? 0 : daysBetweenKeys(todayKey, date);
    const sameCourseBefore = lastCourseOnDay[date] === task.courseId;

    return candidates
      .map(({ gap, s }) => {
        let score = 0;
        let reason = "";
        let isPostClassReview = false;

        // Strategist timing is a preference, not an unsafe calendar command.
        // This deliberately leaves conflict checks and exact slot placement here.
        if (strategistSession) {
          score += timingBonus;
          if (timingBonus >= 24) reason = `${strategistSession.label} — planned at the recommended lead time`;
        }

        // Signal 1: Post-class review window (same course, right after class)
        const postClassMatch = postClassWindows[date]?.find(
          (w) =>
            w.courseId === task.courseId &&
            s.startMinutes >= w.startMinutes &&
            s.startMinutes < w.endMinutes &&
            s.endMinutes - s.startMinutes >= blockDuration
        );
        if (postClassMatch) {
          score += 20;
          reason = `Soon after ${postClassMatch.courseName} class — while it is fresh`;
          isPostClassReview = true;
        }

        // Signal 1b: A short breather after ANY class: starting the minute the 15-min transition ends is avoided.
        if (classEnds[date]?.some((end) => s.startMinutes >= end && s.startMinutes - end < 30)) score -= 12;

        // Signal 2: Pre-class prep window (same course, 30-60 min before class)
        const preClassMatch = preClassWindows[date]?.find(
          (w) =>
            w.courseId === task.courseId &&
            s.startMinutes >= w.startMinutes &&
            s.startMinutes < w.endMinutes &&
            s.endMinutes - s.startMinutes >= blockDuration
        );
        if (preClassMatch && !isPostClassReview) {
          score += 15;
          if (!reason) reason = `Before ${preClassMatch.courseName} class — great for pre-lecture review`;
        }

        // Signal 3: Ultradian rhythm peaks (90-min focus cycles from wake time)
        const ultradianBonus = getUltradianScore(s.startMinutes);
        score += ultradianBonus;
        if (ultradianBonus >= 20 && !reason) reason = "Aligns with your natural 90-min focus cycle peak";

        // Signal 4: Energy profile alignment (broad preference window)
        const distFromEnergy = Math.abs(s.startMinutes - energyPreferredStart);
        if (distFromEnergy < 60) { score += 25; if (!reason) reason = "Aligns with your peak energy time"; }
        else if (distFromEnergy < 120) { score += 15; }
        else if (distFromEnergy < 180) { score += 8; }

        // Signal 5: Cognitive load matrix (difficulty × time-of-day)
        // Based on Evans, Kelley & Kelley 2017 (Frontiers Human Neurosci) + Sweller 1988 CLT
        // Peak cognitive performance: 10 AM–12 PM and 5–9 PM for most college students
        // Post-lunch dip (1–3 PM): universal circadian trough — avoid hard cognitive work
        const hour = Math.floor(s.startMinutes / 60);
        if (hour >= 13 && hour < 15) {
          score -= 20; // strong penalty for post-lunch trough (circadian science)
          if (!reason) reason = "Post-lunch dip (1–3 PM) — better for lighter tasks";
        }
        if (task.difficulty >= 4) {
          if (hour >= 10 && hour < 13) { score += 25; if (!reason) reason = "Late morning peak — ideal for your hardest work"; }
          else if (hour >= 7 && hour < 10) { score += 15; if (!reason) reason = "Morning — good for demanding work"; }
          else if (hour >= 17 && hour < 21) { score += 20; if (!reason) reason = "Evening peak — great for hard cognitive work"; }
          else if (hour >= 21) { score -= 20; if (!reason) reason = "Late night — not ideal for hard work"; }
        } else if (task.difficulty <= 2) {
          if (hour >= 13 && hour < 17) { score += 15; if (!reason) reason = "Afternoon slot — good for lighter work during the dip"; }
          else if (hour >= 10 && hour < 13) { score += 8; }
          else if (hour >= 17 && hour < 21) { score += 10; }
        } else {
          // Medium difficulty (3): prefer late morning or evening
          if (hour >= 10 && hour < 13) { score += 15; if (!reason) reason = "Late morning peak — good for focused work"; }
          else if (hour >= 17 && hour < 21) { score += 12; if (!reason) reason = "Evening focus window"; }
        }

        // Signal 6: Evidence-based spaced repetition spacing
        // Cepeda et al. 2008 (Psychological Science): optimal gap ≈ 10-20% of retention interval
        if (lastDate) {
          score += spacingBonus;
          if (spacingReason && !reason) reason = spacingReason;
        } else {
          // Never studied this course yet — bonus for scheduling first session soon
          if (dayFromToday <= 2) { score += 18; if (!reason) reason = "First study session — starting early is the strongest predictor of success"; }
          else if (dayFromToday <= 4) { score += 8; }
        }

        // Signal 7: Task interleaving (penalize same-course back-to-back on same day)
        if (sameCourseBefore) score -= 18;

        // Signal 8: Day-of-week load balancing
        score += dayLoadPenalty;

        // Signal 9: Completion history (avoid time slots user historically skips)
        score += getSkipPenalty(s.startMinutes);

        // Signal 10: Avoid late night (after 21:00)
        if (s.startMinutes > LATE_EVENING_MINUTES) {
          score -= 25;
          if (!reason) reason = "Late evening slot";
        }

        // Signal 10b: College social pattern awareness
        // - Friday evening (after 6 PM): strong social time — heavily penalize
        // - Saturday: lower-priority study day — moderate penalty all day
        // - Sunday morning (before noon): recovery / slow start — mild penalty
        if (slotDayOfWeek === "Fri" && hour >= 18) {
          score -= 40;
          if (!reason) reason = "Friday evening — social time, not ideal for studying";
        } else if (slotDayOfWeek === "Fri" && hour >= 15) {
          score -= 20;
          if (!reason) reason = "Friday afternoon — weekend is starting";
        } else if (slotDayOfWeek === "Sat") {
          score -= 15;
          if (!reason) reason = "Saturday — weekday slots preferred when available";
          if (hour >= 21) { score -= 20; }
        } else if (slotDayOfWeek === "Sun" && hour < 10) {
          score -= 20;
          if (!reason) reason = "Sunday morning — recovery time after the weekend";
        }

        // Signal 10c: Thursday social night awareness
        if (slotDayOfWeek === "Thu" && hour >= 20) {
          score -= 25;
          if (!reason) reason = "Thursday night — often social time";
        } else if (slotDayOfWeek === "Thu" && hour >= 18) {
          score -= 10;
        }

        // Signal 10d: Sunday afternoon productivity boost
        if (slotDayOfWeek === "Sun" && hour >= 14 && hour < 18) {
          score += 18;
          if (!reason) reason = "Sunday afternoon — high motivation window before the week starts";
        } else if (slotDayOfWeek === "Sun" && hour >= 18) {
          score += 10;
          if (!reason) reason = "Sunday evening — good prep for the week ahead";
        }

        // Signal 10e: Meal time avoidance (7-8, 12:00-12:59, 18:00-18:59)
        if ((hour === 7 && s.startMinutes < 8 * 60) || hour === 12 || hour === 18) {
          score -= 15;
          if (!reason) reason = "Meal time — better to eat first, then study";
        }

        // Signal 10f: Early morning penalty for college students
        // Hershner & Chervin 2014: average college student sleep = 5.7 hrs; delayed circadian phase
        if (hour < 8) {
          score -= 30;
          if (!reason) reason = "Very early — most students are still sleep-deprived at this hour";
        } else if (hour === 8) {
          score -= 15;
          if (!reason) reason = "Early morning — consider a later slot if you're sleep-deprived";
        }

        // Signal 10g: Not first thing after waking up - above all on a weekend morning.
        if (s.startMinutes < dayWindowStart + 60) {
          score -= weekend ? 25 : 8;
          if (!reason && weekend) reason = "Weekend morning — better after you have had time to wake up";
        }

        // Signal 11: Breathing room (prefer gaps with buffer space)
        if (gap.endMinutes - gap.startMinutes >= blockDuration + 30) score += 6;

        // Signal 12: Avoid back-to-back study blocks (need a break)
        const justAfterStudy = occupied[date]?.some((o) => Math.abs(o.endMinutes - s.startMinutes) <= 5);
        if (justAfterStudy) score -= 12;

        // Signal 13: Earlier-in-day tiebreaker
        score -= s.startMinutes / 150;

        if (!reason) {
          if (hour < 12) reason = "Good morning study slot";
          else if (hour < 17) reason = "Productive afternoon slot";
          else reason = "Evening study slot";
        }

        return { slot: s, score, reason, isPostClassReview };
      })
      .sort((a, b) => b.score - a.score || a.slot.startMinutes - b.slot.startMinutes);
  }

  function commit(task: Task, date: string, startMin: number, duration: number): void {
    // The gap after a session stays free, so back-to-back sessions never touch.
    occupied[date]!.push({ startMinutes: startMin, endMinutes: startMin + duration + SESSION_GAP_MINUTES });
    studyBlocksPerDay[date] = (studyBlocksPerDay[date] ?? 0) + 1;
    addLoad(date, duration);
    lastCourseOnDay[date] = task.courseId;
    if (!lastStudyDatePerCourse[task.courseId] || date > lastStudyDatePerCourse[task.courseId]!) {
      lastStudyDatePerCourse[task.courseId] = date;
    }
  }

  /** Load limits for one placement attempt (see the tiers in the main pass). */
  interface LoadLimit { daily: number; weekly: number }

  /** Work due by this date (or overdue) is urgent: see cappedRoom. */
  const urgentUntil = addDaysToKey(todayKey, URGENT_DAYS);

  /**
   * Minutes a capped date (SchedulingOptions.cappedDates) can still take for `item`; unlimited for any other date. The
   * last resort (no `limit`) for urgent work, due within URGENT_DAYS days, may go past it, as on any other day: a dragged
   * session cut a quiz due the next morning to 30 of its 90 minutes (1.0.9 audit). The 4-session cap stays.
   */
  function cappedRoom(date: string, item: WorkItem, limit: LoadLimit | undefined): number {
    if (!options.cappedDates?.has(date) || (!limit && item.dueKey <= urgentUntil)) return Number.POSITIVE_INFINITY;
    return Math.max(0, caps.dailyMinutes - (dayStudyMinutes[date] ?? 0));
  }

  /** True when `duration` more minutes on `date` stay within `limit` (always true without a limit) and its capped room. */
  function withinLimit(date: string, duration: number, item: WorkItem, limit: LoadLimit | undefined): boolean {
    if (duration > cappedRoom(date, item, limit)) return false;
    if (!limit) return true;
    if ((dayStudyMinutes[date] ?? 0) + duration > limit.daily) return false;
    return (weekStudyMinutes[weekIndexOf(date)] ?? 0) + duration <= limit.weekly;
  }

  /** Place ONE session of `duration` minutes on the first day in `days` that can hold it (within `limit`). */
  function placeSession(
    item: WorkItem,
    days: string[],
    duration: number,
    strategistSession: PlannedStudySession | undefined,
    limit?: LoadLimit,
  ): PlacedSession | null {
    for (const date of days) {
      if ((studyBlocksPerDay[date] ?? 0) >= DAILY_STUDY_CAP) continue;
      if (!withinLimit(date, duration, item, limit)) continue;
      const endCap = !item.overdue && date === item.dueKey ? item.cutoff : undefined;
      const slots = freeSlotsFor(date, duration, endCap);
      if (slots.length === 0) continue;
      const best = scoreSlots(item.task, item.dueKey, date, slots, duration, strategistSession)[0];
      if (!best) continue;
      commit(item.task, date, best.slot.startMinutes, duration);
      return {
        date,
        startMinutes: best.slot.startMinutes,
        endMinutes: best.slot.startMinutes + duration,
        reason: best.reason,
        isPostClassReview: best.isPostClassReview,
        strategist: strategistSession,
      };
    }
    return null;
  }

  /** Days this task may use: due-date-relative window, then progressively earlier days as a last resort. */
  function datesInRange(fromKey: string, toKey: string): string[] {
    const from = Math.max(0, daysBetweenKeys(weekStartKey, fromKey));
    const to = Math.min(allDates.length - 1, daysBetweenKeys(weekStartKey, toKey));
    return from > to ? [] : allDates.slice(from, to + 1);
  }

  const scheduledBlocks: ScheduledStudyBlock[] = [];

  for (const item of ordered) {
    const { task, dueKey, overdue, strategistSessions, requested } = item;
    const notBefore = task.notBeforeDate ? task.notBeforeDate.slice(0, 10) : "";
    const earliestKey = [weekStartKey, todayKey, notBefore].sort().at(-1)!;

    // ── Determine the scheduling window for this task ──────
    // Backward planning: start from the deadline, work backward; first session early.
    // An overdue task has no deadline left to plan against: plan it ASAP (today / tomorrow).
    let windowStartKey: string;
    let windowEndKey: string;
    if (overdue) {
      const startFrom = [todayKey, notBefore].sort().at(-1)!;
      windowStartKey = startFrom;
      windowEndKey = addDaysToKey(startFrom, 1);
      overdueTasks.push({
        taskId: task.id,
        taskName: task.name,
        dueDate: dueKey,
        // 0 for work the student deferred past a deadline that has not arrived yet (it WILL be late).
        daysOverdue: Math.max(0, daysBetweenKeys(dueKey, todayKey)),
      });
    } else {
      const daysUntilDue = Math.max(0, daysBetweenKeys(todayKey, dueKey));
      const prepWindowDays = Math.min(PREP_WINDOW_DAYS, daysUntilDue);
      windowStartKey = [addDaysToKey(dueKey, -prepWindowDays), todayKey, notBefore].sort().at(-1)!;
      windowEndKey = dueKey;
    }

    // Far-future work outside this planning horizon is not due for planning yet; work due before the
    // horizon starts belongs to an earlier week's plan. Neither is a shortfall.
    if (windowStartKey > lastDateKey) continue;
    if (!overdue && dueKey < weekStartKey) continue;

    const cls = state.classes.find((c) => c.id === task.courseId);
    const courseColor = cls?.color ?? BLOCK_COLORS.study;
    const courseName = task.courseName || cls?.name || "General";

    const availableDays = datesInRange(windowStartKey, windowEndKey);
    const placed: PlacedSession[] = [];
    // Days before the deadline, per date (asked for again and again while the candidate days are sorted).
    const leads = new Map<string, number>();
    const leadOf = (date: string) => {
      let lead = leads.get(date);
      if (lead === undefined) {
        lead = daysBetweenKeys(date, dueKey);
        leads.set(date, lead);
      }
      return lead;
    };

    // ── Load caps: where the work may go, in order of preference ──
    // Sessions stay close to their deadline (the per-kind runway, lib/exam-prep-plan.ts runwayDaysFor). Only when
    // the days there are at the daily / weekly cap does work move EARLIER, never more than twice the runway ahead.
    // Only when nothing in that reach has room is a cap exceeded (placing work beats silently dropping it).
    const softLimit: LoadLimit = { daily: caps.dailyTargetMinutes, weekly: caps.weeklyMinutes };
    const hardLimit: LoadLimit = { daily: caps.dailyMinutes, weekly: caps.weeklyMinutes };
    const dailyOnlyLimit: LoadLimit = { daily: caps.dailyMinutes, weekly: Number.POSITIVE_INFINITY };
    const baseRunway = runwayDaysFor(classifyTaskKind(task), Math.max(1, Math.ceil(requested / baseSessionDuration)));
    const strategistReach = strategistSessions.reduce((most, session) => Math.max(most, Number.isFinite(session.earliestDaysBeforeDue) ? session.earliestDaysBeforeDue : 0), 0);
    const reach = Math.max(baseRunway, strategistReach);
    const wideDays = overdue
      ? []
      : datesInRange([addDaysToKey(dueKey, -2 * reach), earliestKey].sort().at(-1)!, addDaysToKey(windowStartKey, -1)).reverse();
    /** The same candidate days in three reaches: inside the runway, up to twice the runway, and anything allowed. */
    const reaches = (days: string[]) => {
      const runway = overdue ? days : days.filter((date) => leadOf(date) <= reach);
      const widened = [...days.filter((date) => leadOf(date) <= 2 * reach), ...wideDays.filter((date) => !days.includes(date))];
      return { runway, widened, all: days };
    };
    const placeWithinCaps = (days: string[], minutes: number, strategist: PlannedStudySession | undefined): PlacedSession | null => {
      const { runway, widened, all } = reaches(days);
      return placeSession(item, runway, minutes, strategist, softLimit)
        ?? placeSession(item, runway, minutes, strategist, hardLimit)
        ?? placeSession(item, widened, minutes, strategist, hardLimit)
        ?? placeSession(item, runway, minutes, strategist, dailyOnlyLimit)
        ?? placeSession(item, widened, minutes, strategist, dailyOnlyLimit)
        ?? placeSession(item, all, minutes, strategist);
    };

    if (availableDays.length > 0) {
      // ── Main pass: chunk deterministically, one session per day where possible ──
      const plannedSessions: Array<{ minutes: number; strategist?: PlannedStudySession }> = strategistSessions.length > 0
        ? strategistSessions.map((session) => ({ minutes: session.minutes, strategist: session }))
        : planSessionChunks(requested, baseSessionDuration).map((minutes) => ({ minutes }));

      // Every task without a strategist plan is placed back from its deadline: the runway (days before due) depends
      // on the kind and size of the work, and the sessions spread across it with the last one 1-2 days out.
      const leadPlanned = !overdue && strategistSessions.length === 0;
      const runwayDays = Math.min(
        runwayDaysFor(classifyTaskKind(task), plannedSessions.length),
        Math.max(1, daysBetweenKeys(availableDays[0]!, dueKey)),
      );
      const chunkLeads = leadPlanned ? examPrepLeads(plannedSessions.length, runwayDays) : [];

      /**
       * Candidate days for one session, best first: the days nearest its target lead time (distinct from days this
       * task already uses, and inside the strategist's "earliest useful" limit), then the rest, and the due date
       * itself only as a last resort for anything targeted before it.
       */
      const usedDays = new Set<string>();
      const daysForTarget = (targetLead: number, maxLead?: number): string[] => {
        const byDistance = (a: string, b: string) =>
          Math.abs(leadOf(a) - targetLead) - Math.abs(leadOf(b) - targetLead) || leadOf(b) - leadOf(a);
        const dueDay = targetLead >= 1 ? availableDays.filter((date) => leadOf(date) === 0) : [];
        const usable = availableDays.filter((date) => !dueDay.includes(date));
        const preferred = usable.filter((date) => !usedDays.has(date) && (maxLead === undefined || leadOf(date) <= maxLead)).sort(byDistance);
        const rest = usable.filter((date) => !preferred.includes(date)).sort(byDistance);
        return [...preferred, ...rest, ...dueDay];
      };

      for (const [index, planned] of plannedSessions.entries()) {
        let days: string[];
        if (planned.strategist) {
          // Begin every named learning step at its own preferred lead time; widen out from there.
          const earliest = planned.strategist.earliestDaysBeforeDue;
          days = daysForTarget(
            planned.strategist.targetDaysBeforeDue,
            Number.isFinite(earliest) && earliest >= planned.strategist.targetDaysBeforeDue ? earliest : undefined,
          );
        } else if (leadPlanned) {
          // Spaced across the runway with gaps that tighten, the last session 1-2 days before the deadline.
          days = daysForTarget(chunkLeads[index] ?? 2);
        } else {
          days = availableDays; // overdue: ASAP, earliest day first
        }
        const session = placeWithinCaps(days, planned.minutes, planned.strategist);
        if (session) {
          placed.push(session);
          usedDays.add(session.date);
        }
      }
    }

    // ── Fill pass: whatever did not fit at full size is placed in smaller sessions (never stubs) ──
    let placedMinutes = placed.reduce((sum, p) => sum + (p.endMinutes - p.startMinutes), 0);
    const minChunk = Math.min(MIN_SESSION_MINUTES, requested);
    if (placedMinutes < requested) {
      let fillOrder: string[];
      if (overdue) {
        fillOrder = [...availableDays];
      } else {
        // Nearest the deadline first (the due day itself last, and only then earlier days: the prep window is a
        // preference, not a capacity limit), so a task that did not fit is still not pushed weeks early.
        const before = datesInRange(earliestKey, addDaysToKey(windowStartKey, -1)).reverse();
        fillOrder = [...availableDays.filter((date) => date !== dueKey).reverse(), ...availableDays.filter((date) => date === dueKey), ...before];
      }
      const fill = (order: string[], limit: LoadLimit | undefined) => {
        let progress = true;
        while (progress && requested - placedMinutes >= minChunk && requested - placedMinutes > 0) {
          progress = false;
          for (const date of order) {
            const left = requested - placedMinutes;
            if (left < minChunk || left <= 0) break;
            if ((studyBlocksPerDay[date] ?? 0) >= DAILY_STUDY_CAP) continue;
            const endCap = !overdue && date === dueKey ? item.cutoff : undefined;
            const slots = freeSlotsFor(date, minChunk, endCap);
            if (slots.length === 0) continue;
            const biggest = Math.max(...slots.map((s) => s.endMinutes - s.startMinutes));
            const room = Math.min(limit ? Math.max(0, limit.daily - (dayStudyMinutes[date] ?? 0)) : Number.POSITIVE_INFINITY, cappedRoom(date, item, limit));
            let chunk = Math.min(left, biggest, baseSessionDuration, room);
            if (chunk < left) chunk = Math.floor(chunk / 5) * 5; // stay on the 5-minute grid unless this finishes the task
            const rest = left - chunk;
            if (rest > 0 && rest < MIN_SESSION_MINUTES) chunk = left - MIN_SESSION_MINUTES; // never leave a stub behind
            if (chunk < minChunk || (chunk < left && chunk < MIN_SESSION_MINUTES)) continue;
            const session = placeSession(item, [date], chunk, undefined, limit);
            if (!session) continue;
            placed.push(session);
            placedMinutes += chunk;
            progress = true;
          }
        }
      };
      // Within the caps and twice the runway first; then anything that still fits.
      fill(overdue ? fillOrder : fillOrder.filter((date) => leadOf(date) <= 2 * reach), hardLimit);
      fill(fillOrder, undefined);
    }

    // ── Number the REAL sessions chronologically and derive their purpose ──
    placed.sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes);
    const total = placed.length;
    const tested = isTestedTask(task);
    const writing = isWritingTask(task);
    const examLike = classifyTaskKind(task) === "exam";
    const examTopics = examLike && !overdue ? normalizeTopics(task.coversTopics) : [];
    const topicPlan = examTopics.length > 0 ? planExamTopics(examTopics, total) : [];
    placed.forEach((session, index) => {
      const duration = session.endMinutes - session.startMinutes;
      const daysUntilDueFromBlock = daysBetweenKeys(session.date, dueKey);
      // The last sessions before an EXAM are retrieval practice. A quiz's short review (now planned 1-2 days out
      // like everything else) stays a review: a weekly 25-minute quiz is not a practice-test occasion.
      const nearTest = examLike && !overdue && daysUntilDueFromBlock <= 2 && index >= total - 2;
      const purpose: StudySessionPurpose = session.strategist
        ? session.strategist.purpose
        : tested
        ? (nearTest ? "practice" : "review")
        : writing && total > 1
        ? (index === 0 ? "draft" : index === total - 1 ? "submit" : "learn")
        : "learn";
      const isRetrievalPractice = tested && (session.strategist ? session.strategist.purpose === "practice" : nearTest);
      scheduledBlocks.push({
        taskId: task.id,
        taskName: task.name,
        courseName,
        courseId: task.courseId,
        courseColor,
        date: session.date,
        dayLabel: getDayFullName(session.date),
        startTime: minutesToTime(session.startMinutes),
        endTime: minutesToTime(session.endMinutes),
        durationMinutes: duration,
        reason: overdue
          ? dueKey < todayKey
            ? `Overdue since ${dueKey} — placed in the first free slot. ${session.reason}`
            : `Moved past its deadline (${dueKey}) at your request — it will be late. ${session.reason}`
          : session.reason,
        isPostClassReview: session.isPostClassReview,
        isRetrievalPractice,
        sessionNumber: index + 1,
        totalSessions: total,
        purpose,
        isOverdue: overdue || undefined,
        ...(!session.strategist && topicPlan[index]
          ? { topicLabel: topicPlan[index]!.label ?? undefined, isFinalReview: topicPlan[index]!.isFinalReview || undefined }
          : {}),
        strategyLabel: session.strategist?.label,
        strategyPurpose: session.strategist?.purpose,
        strategyRationale: session.strategist ? task.planningStrategy?.rationale : undefined,
      });
    });

    // ── Be honest about what did not fit ──
    const missing = requested - placedMinutes;
    if (missing > 0) {
      const when = overdue ? "in the next two days" : `before ${dueLabel(dueKey, todayKey)}`;
      const reason = availableDays.length === 0
        ? "No available days found in the scheduling window."
        : placedMinutes === 0
        ? `No free time slots found ${when}. Consider adjusting your no-go zones or recurring events.`
        : `Only ${describeMinutes(placedMinutes)} of ${describeMinutes(requested)} fit ${when} — you need ${describeMoreTime(missing)}.`;
      shortfalls.push({
        taskId: task.id,
        taskName: task.name,
        dueDate: dueKey,
        requestedMinutes: requested,
        placedMinutes,
        missingMinutes: missing,
        overdue,
        reason,
      });
      unscheduledTasks.push({ taskId: task.id, taskName: task.name, reason });
    }
  }

  // ── Build summary ─────────────────────────────────────────
  const daysWithStudy = Array.from(new Set(scheduledBlocks.map((b) => b.date))).sort();
  const totalStudyMinutes = scheduledBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
  const totalHours = Math.floor(totalStudyMinutes / 60);
  const totalMins = totalStudyMinutes % 60;
  const timeStr = totalHours > 0
    ? `${totalHours}h${totalMins > 0 ? ` ${totalMins}m` : ""}`
    : `${totalMins}m`;

  const postClassCount = scheduledBlocks.filter((b) => b.isPostClassReview).length;
  const postClassNote = postClassCount > 0
    ? ` ${postClassCount} session${postClassCount > 1 ? "s" : ""} placed right after class for maximum retention.`
    : "";

  const missingTotal = shortfalls.reduce((sum, s) => sum + s.missingMinutes, 0);
  const unscheduledNote = shortfalls.length > 0
    ? ` ${shortfalls.length} task${shortfalls.length > 1 ? "s" : ""} won't fully fit in time (${describeMinutes(missingTotal)} short).`
    : "";
  const catchUp = overdueTasks.filter((task) => !task.missedAssessment).length;
  const missedTests = overdueTasks.length - catchUp;
  const overdueNote = (catchUp > 0
    ? ` ${catchUp} overdue task${catchUp > 1 ? "s were" : " was"} planned for the next two days.`
    : "") + (missedTests > 0
    ? ` ${missedTests} quiz${missedTests > 1 ? "zes or exams have" : " or exam has"} already taken place: no catch-up is planned (mark ${missedTests > 1 ? "them" : "it"} done or skipped).`
    : "");

  const summary = scheduledBlocks.length > 0
    ? `Scheduled ${scheduledBlocks.length} study session${scheduledBlocks.length > 1 ? "s" : ""} across ${daysWithStudy.length} day${daysWithStudy.length > 1 ? "s" : ""} (${timeStr} total).${postClassNote}${overdueNote}${unscheduledNote}`
    : `No study sessions could be scheduled.${unscheduledNote}`;

  return {
    scheduledBlocks,
    unscheduledTasks,
    shortfalls,
    overdueTasks,
    summary,
    totalStudyMinutes,
    daysWithStudy,
  };
}

// ── Convert ScheduledStudyBlock → ScheduleBlock ───────────────

/**
 * Deterministic block id: the same task session on the same date always gets
 * the same id, so regenerating a plan never invents new identities for it.
 */
export function stableStudyBlockId(block: Pick<ScheduledStudyBlock, "taskId" | "sessionNumber" | "date">): string {
  return `study-${block.taskId}-${block.sessionNumber}-${block.date}`;
}

const PURPOSE_VERB: Record<StudySessionPurpose, string> = {
  preview: "Work on",
  learn: "Work on",
  practice: "Work on",
  draft: "Draft",
  review: "Review",
  submit: "Finalize",
};

/** Human label for a session: driven by its purpose, and only tested tasks ever say "Practice Test". */
export function studyBlockTitle(sb: ScheduledStudyBlock): string {
  const count = sb.totalSessions > 1 ? ` (${sb.sessionNumber}/${sb.totalSessions})` : "";
  if (sb.strategyLabel) return `Study: ${sb.taskName} — ${sb.strategyLabel}`;
  if (sb.isOverdue) return `Catch up: ${sb.taskName}${count}`;
  if (sb.isFinalReview) return `${sb.taskName} final review: all topics`;
  if (sb.topicLabel) return `${sb.taskName} prep: ${sb.topicLabel}`;
  const verb = sb.isRetrievalPractice ? "Practice Test" : PURPOSE_VERB[sb.purpose] ?? "Work on";
  return `${verb}: ${sb.taskName}${count}`;
}

function topicScope(sb: ScheduledStudyBlock): string {
  if (sb.isFinalReview) return "Final review of all topics. ";
  if (sb.topicLabel) return `${sb.topicLabel}: `;
  return "";
}

function whatCountsAsDone(sb: ScheduledStudyBlock): string {
  const scope = topicScope(sb);
  return scope ? `${scope}${whatCountsAsDoneBase(sb)}` : whatCountsAsDoneBase(sb);
}

function whatCountsAsDoneBase(sb: ScheduledStudyBlock): string {
  if (sb.strategyPurpose) {
    return `${sb.strategyPurpose[0]!.toUpperCase()}${sb.strategyPurpose.slice(1)}: complete ${sb.durationMinutes} min for ${sb.strategyLabel ?? sb.taskName}.`;
  }
  if (sb.isRetrievalPractice) {
    return `Do NOT re-read notes. Instead: close your notes and write down everything you know, then check. This retrieval practice produces 2× better retention than re-reading (Roediger & Karpicke 2006).`;
  }
  if (sb.purpose === "review") return `Review your notes and weak spots for "${sb.taskName}" (${sb.durationMinutes} min), then quiz yourself on one section`;
  if (sb.purpose === "draft") return `Get a rough draft of "${sb.taskName}" down — imperfect is fine (${sb.durationMinutes} min)`;
  if (sb.purpose === "submit") return `Proofread and finish "${sb.taskName}" so it is ready to hand in`;
  return `Complete ${sb.durationMinutes} min of focused work on "${sb.taskName}"`;
}

export function convertToScheduleBlocks(
  scheduledBlocks: ScheduledStudyBlock[]
): ScheduleBlock[] {
  return scheduledBlocks.map((sb) => ({
    id: stableStudyBlockId(sb),
    type: "study" as const,
    title: studyBlockTitle(sb),
    date: sb.date,
    startTime: sb.startTime,
    endTime: sb.endTime,
    locked: false,
    accepted: false, // suggested — user must accept
    taskId: sb.taskId,
    courseId: sb.courseId,
    color: sb.courseColor,
    completionStatus: "pending" as const,
    whatCountsAsDone: whatCountsAsDone(sb),
    startRitual: sb.isPostClassReview
      ? "Review your class notes from today before starting"
      : sb.isRetrievalPractice
      ? "Close your notes and textbook. This is a practice test — no peeking."
      : "Close all tabs, put phone face-down, set a timer",
    ifThenPlan: {
      obstacle: "too_hard" as const,
      copingAction: "Start with just 5 minutes. Any progress counts.",
    },
    ...(sb.strategyLabel ? { strategyLabel: sb.strategyLabel } : {}),
    schedulingReason: (sb.isFinalReview ? "Final review of all topics. " : sb.topicLabel ? `Covers ${sb.topicLabel}. ` : "") + (sb.strategyRationale
      ? [sb.reason, sb.strategyRationale].filter(Boolean).join(" — ")
      : sb.isRetrievalPractice
      ? `${sb.reason} — Retrieval practice session: testing yourself is 2× more effective than re-reading for exam prep`
      : sb.reason),
  }));
}
