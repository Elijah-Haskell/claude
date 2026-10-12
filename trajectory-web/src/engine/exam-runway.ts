/**
 * Exam runway: how an exam-prep entry turns into planned study time (pure).
 *
 * An exam is ONE Task (id "exam-runway-<examId>", kind "exam") whose planningStrategy lists a named
 * session per weak topic. That task is handed to the same deterministic solver as every other task
 * (lib/week-planner.ts -> scheduleTasksIntelligently), so exam sessions respect classes, recurring
 * commitments, Google Calendar events, the sleep window and other tasks' sessions and can never
 * double-book. This module never places a block itself.
 *
 * Honesty rules: an exam that is over is not planned; an exam today with no start time is not planned
 * (sessions could land after it); and before anything is committed, previewRunway asks the real
 * planner whether the requested time fits so the student is told about any shortfall.
 *
 * An exam linked to its exam task (ExamPrep.examTaskId) passes the link on to this task, and every plan then takes
 * the due date and time from the exam task (lib/exam-prep-link.ts followExamDates), so the prep follows a moved exam.
 * From then on the exam is planned ONLY through this task, which plans at least the exam's own remaining estimate
 * (examsPlannedByPrep / withExamTopUp): the exam's suggested sessions are replaced, never added to.
 */
import type { AppState, ExamPrep, PlannedStudySession, ScheduleBlock, Task } from "./types";
import { buildWeekPlan } from "./week-planner";
import { daysBetweenKeys, localDateKey, timeToMinutes } from "./utils";
import { MIXED_PRACTICE_LABEL, runwayTaskId, withExamTopUp } from "./exam-prep-link";

export { RUNWAY_TASK_PREFIX, isRunwayTask, runwayTaskId } from "./exam-prep-link";
/** The solver starts an exam's sessions at most this many days before it (PREP_WINDOW_DAYS in lib/intelligent-scheduler.ts). */
export const RUNWAY_LEAD_DAYS = 14;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// ── Exam timing ────────────────────────────────────────────────────────────

export type ExamTimingStatus = "upcoming" | "today" | "past" | "invalid";

export interface ExamTiming {
  status: ExamTimingStatus;
  /** Whole calendar days until the exam (negative once it is over; 0 today). */
  daysLeft: number;
  label: string;
}

/** Both arguments are LOCAL "YYYY-MM-DD" keys (see lib/utils.ts). */
export function examTiming(examDate: string, todayKey: string): ExamTiming {
  if (!DATE_KEY.test(examDate) || !DATE_KEY.test(todayKey)) return { status: "invalid", daysLeft: 0, label: "Date unknown" };
  const daysLeft = daysBetweenKeys(todayKey, examDate);
  if (daysLeft === 0) return { status: "today", daysLeft, label: "Today" };
  if (daysLeft === 1) return { status: "upcoming", daysLeft, label: "Tomorrow" };
  if (daysLeft > 1) return { status: "upcoming", daysLeft, label: `${daysLeft} days` };
  if (daysLeft === -1) return { status: "past", daysLeft, label: "Yesterday" };
  return { status: "past", daysLeft, label: `${Math.abs(daysLeft)} days ago` };
}

// ── Session plan ───────────────────────────────────────────────────────────

export type RunwayStatus =
  | "ready"
  | "exam_passed"
  | "exam_today_no_time"
  | "invalid_date"
  | "all_mastered"
  | "no_topics";

export interface RunwayPlan {
  status: RunwayStatus;
  /** Present only when status is "ready". */
  task: Task | null;
  sessions: PlannedStudySession[];
  totalMinutes: number;
  weakTopics: number;
  /** Plain-language reason when status is not "ready". */
  message: string;
}

const MINUTES = { learn: 60, review: 30, quiz: 30, final: 45 } as const;

function shortTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t;
}

/**
 * Spreads `count` sessions from `maxLead` days before the exam down to 1 day before (0 when the exam is
 * today). Earlier sessions get bigger leads; the final one lands the day before.
 */
export function leadDays(count: number, maxLead: number): number[] {
  if (count <= 0) return [];
  if (maxLead <= 0) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, k) => {
    const fraction = count === 1 ? 1 : k / (count - 1);
    return Math.max(1, Math.round(maxLead - fraction * (maxLead - 1)));
  });
}

/**
 * The exam's study task. Pass the exam as the screens show it (lib/exam-prep-link.ts withLinkedExam) so its date is
 * the exam task's current one. With `examTask` (the exam it is linked to) the plan is sized to it up front: when the
 * exam's own remaining estimate is more than the topic sessions add up to, "Mixed practice" sessions (at most
 * `maxSessionMinutes` each, default 90) make up the difference. Without it every plan does the same
 * (lib/exam-prep-link.ts sizePrepsToExams).
 */
export function buildExamRunway(
  exam: Pick<ExamPrep, "id" | "classId" | "className" | "examDate" | "examTime" | "topics" | "examTaskId">,
  opts: { todayKey: string; now: Date; existing?: Task; examTask?: Pick<Task, "estimatedMinutes" | "completedMinutes" | "status">; maxSessionMinutes?: number },
): RunwayPlan {
  const none = (status: RunwayStatus, message: string): RunwayPlan => ({ status, task: null, sessions: [], totalMinutes: 0, weakTopics: 0, message });

  const timing = examTiming(exam.examDate, opts.todayKey);
  if (timing.status === "invalid") return none("invalid_date", "This exam doesn't have a valid date. Edit the exam and pick one.");
  if (timing.status === "past") return none("exam_passed", `This exam was ${timing.label === "Yesterday" ? "yesterday" : timing.label}. Trajectory doesn't schedule study time for exams that are over.`);
  if (exam.topics.length === 0) return none("no_topics", "Add at least one topic so there is something to plan.");

  const weak = exam.topics
    .filter((t) => t.mastery !== "mastered")
    .sort((a, b) => Number(b.mastery === "needs_review") - Number(a.mastery === "needs_review"));
  if (weak.length === 0) return none("all_mastered", "Every topic is marked mastered, so there is nothing left to schedule.");

  if (timing.status === "today") {
    const start = exam.examTime && /^\d{1,2}:\d{2}$/.test(exam.examTime) ? timeToMinutes(exam.examTime) : null;
    if (start === null) {
      return none("exam_today_no_time", "Your exam is today and it has no start time, so Trajectory can't tell which hours are still before it. Use the flashcards and quiz now.");
    }
    if (start <= opts.now.getHours() * 60 + opts.now.getMinutes()) {
      return none("exam_passed", "This exam's start time has already passed today, so there is nothing left to schedule.");
    }
  }

  const maxLead = timing.status === "today" ? 0 : Math.min(timing.daysLeft, RUNWAY_LEAD_DAYS);
  const items: Array<{ label: string; purpose: PlannedStudySession["purpose"]; minutes: number }> = [
    ...weak.map((t) =>
      t.mastery === "needs_review"
        ? { label: `Learn: ${shortTitle(t.title)}`, purpose: "learn" as const, minutes: MINUTES.learn }
        : { label: `Review: ${shortTitle(t.title)}`, purpose: "review" as const, minutes: MINUTES.review },
    ),
    ...weak.map((t) => ({ label: `Quiz yourself: ${shortTitle(t.title)}`, purpose: "practice" as const, minutes: MINUTES.quiz })),
    { label: "Final review before the exam", purpose: "practice" as const, minutes: MINUTES.final },
  ];
  const leads = leadDays(items.length, maxLead);
  const sessions: PlannedStudySession[] = items.map((item, i) => ({
    label: item.label,
    purpose: item.purpose,
    minutes: item.minutes,
    targetDaysBeforeDue: leads[i]!,
    earliestDaysBeforeDue: Math.min(Math.max(maxLead, leads[i]!), leads[i]! + 2),
  }));
  const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);

  const named: Task = {
    id: runwayTaskId(exam.id),
    name: `${exam.className} exam prep`,
    courseId: exam.classId,
    courseName: exam.className,
    dueDate: exam.examDate,
    dueTime: exam.examTime && /^\d{1,2}:\d{2}$/.test(exam.examTime) ? exam.examTime : undefined,
    estimatedMinutes: totalMinutes,
    difficulty: weak.some((t) => t.mastery === "needs_review") ? 5 : 4,
    requiresOnCampus: false,
    status: "pending",
    createdAt: opts.existing?.createdAt ?? opts.now.toISOString(),
    importance: 3,
    kind: "exam",
    completedMinutes: opts.existing?.completedMinutes,
    ...(exam.examTaskId ? { examTaskId: exam.examTaskId } : {}),
    planningStrategy: {
      rationale: `Study plan for ${weak.length} topic${weak.length === 1 ? "" : "s"} that still need work, ending with a final review the day before the exam.`,
      priority: timing.daysLeft <= 3 ? 5 : 4,
      sessions,
    },
  };
  const task = opts.examTask ? withExamTopUp(named, opts.examTask, opts.maxSessionMinutes ?? 90) : named;
  return { status: "ready", task, sessions: task.planningStrategy?.sessions ?? sessions, totalMinutes: task.estimatedMinutes, weakTopics: weak.length, message: "" };
}

// ── Does it fit? ───────────────────────────────────────────────────────────

export interface RunwayPreview {
  requestedMinutes: number;
  /** Minutes the planner found room for before the exam. */
  placedMinutes: number;
  missingMinutes: number;
  /** The planner's own explanation when something doesn't fit. */
  reason: string;
  /** What the plan holds for this prep: `plan.sessions` plus the mixed practice every plan adds to size it to its exam. */
  planned?: { sessions: number; minutes: number; mixedMinutes: number };
  /**
   * The exam it is linked to (it is then planned only through this prep): its name, the minutes its own estimate still
   * asks for, and the flexible sessions already planned for it that this plan replaces.
   */
  exam?: { name: string; minutes: number; replacedSessions: number; replacedMinutes: number };
}

const mixedMinutesOf = (task: Pick<Task, "planningStrategy">) => (task.planningStrategy?.sessions ?? [])
  .filter((session) => session.label === MIXED_PRACTICE_LABEL)
  .reduce((sum, session) => sum + session.minutes, 0);

/**
 * Runs the REAL planner on the state plus this runway task (nothing is dispatched) and reports whether
 * the requested time fits before the exam, what the plan holds for it and which of its exam's sessions it replaces.
 */
export function previewRunway(
  plan: RunwayPlan,
  state: Pick<AppState, "classes" | "recurringEvents" | "tasks" | "scheduleBlocks" | "healthPrefs" | "userPrefs"> & Partial<Pick<AppState, "googleCalendarEvents" | "deviceCalendarEvents">>,
  now: Date,
): RunwayPreview | null {
  const task = plan.task;
  if (plan.status !== "ready" || !task) return null;
  const tasks = [...state.tasks.filter((t) => t.id !== task.id), task];
  const result = buildWeekPlan({ ...state, tasks }, undefined, { now });
  // As every plan holds it: linked to its exam and sized to it (lib/exam-prep-link.ts).
  const sized = result.tasks.find((t) => t.id === task.id) ?? task;
  const shortfall = result.shortfalls.find((s) => s.taskId === task.id);
  const missing = shortfall?.missingMinutes ?? 0;
  const examTask = sized.examTaskId ? state.tasks.find((t) => t.id === sized.examTaskId) : undefined;
  const todayKey = localDateKey(now);
  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // The exam's suggestions still to come: the prep's plan replaces them (confirmed ones stay and count toward it).
  const replaced = examTask
    ? state.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === examTask.id && b.completionStatus === "pending" &&
      !b.accepted && !b.locked && !b.userEdited && !b.startedAt && (b.date > todayKey || (b.date === todayKey && b.endTime > nowHHMM)))
    : [];
  return {
    requestedMinutes: shortfall?.requestedMinutes ?? sized.estimatedMinutes,
    placedMinutes: shortfall?.placedMinutes ?? sized.estimatedMinutes,
    missingMinutes: missing,
    reason: shortfall?.reason ?? "",
    planned: { sessions: sized.planningStrategy?.sessions.length ?? plan.sessions.length, minutes: sized.estimatedMinutes, mixedMinutes: mixedMinutesOf(sized) },
    ...(examTask ? {
      exam: {
        name: examTask.name,
        minutes: Math.max(0, examTask.estimatedMinutes - (examTask.completedMinutes ?? 0)),
        replacedSessions: replaced.length,
        replacedMinutes: replaced.reduce((sum, b) => sum + blockMinutes(b), 0),
      },
    } : {}),
  };
}

export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/**
 * What to tell the student after (or before) planning an exam runway. With a preview of a prep linked to its exam it
 * also says the plan REPLACES the flexible sessions already planned for the exam (the exam is planned only through its
 * prep) and, when mixed practice tops the plan up to the exam's own estimate, that the exam keeps all of its time.
 */
export function runwayOutcomeMessage(plan: RunwayPlan, preview: RunwayPreview | null): { title: string; body: string; tone: "ok" | "warning" | "blocked" } {
  if (plan.status !== "ready") {
    return { title: "Nothing to schedule", body: plan.message, tone: "blocked" };
  }
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const sessions = preview?.planned?.sessions ?? plan.sessions.length;
  const minutes = preview?.planned?.minutes ?? plan.totalMinutes;
  const mixed = preview?.planned?.mixedMinutes ?? (plan.task ? mixedMinutesOf(plan.task) : 0);
  const exam = preview?.exam;
  const including = mixed > 0
    ? `, including ${formatMinutes(mixed)} of mixed practice so ${exam ? `${exam.name} keeps the ${formatMinutes(exam.minutes)}` : "the exam keeps the time"} its own estimate asks for`
    : "";
  const replacing = exam && exam.replacedSessions > 0
    ? `They replace the ${count(exam.replacedSessions, "session")} (${formatMinutes(exam.replacedMinutes)}) already planned as flexible sessions for ${exam.name}, so its study time is not planned twice, and show up as flexible sessions you can keep or move.`
    : "They show up as flexible sessions you can keep or move.";
  const base = `Trajectory will place ${count(sessions, "study session")} (${formatMinutes(minutes)}) for ${count(plan.weakTopics, "topic")} around your classes, commitments and sleep window${including}. ${replacing}`;
  if (preview && preview.missingMinutes > 0) {
    return {
      title: "Not everything fits before the exam",
      body: `${base}\n\nOnly ${formatMinutes(preview.placedMinutes)} of ${formatMinutes(preview.requestedMinutes)} fits before the exam (${formatMinutes(preview.missingMinutes)} short). ${preview.reason}`.trim(),
      tone: "warning",
    };
  }
  return { title: "Exam plan added", body: base, tone: "ok" };
}

// ── What is on the calendar for an exam ───────────────────────────────────────

export interface RunwaySummary {
  sessions: number;
  minutes: number;
  done: number;
  upcoming: number;
  next: ScheduleBlock | null;
}

function blockMinutes(block: Pick<ScheduleBlock, "startTime" | "endTime">): number {
  return Math.max(0, timeToMinutes(block.endTime) - timeToMinutes(block.startTime));
}

/**
 * Sessions currently on the calendar for one exam (any week): its runway task's and, when the exam is linked to its
 * exam task, that task's own (the ones confirmed, started or done before the prep: from then on the exam is planned
 * only through its prep, and they count toward it), so every screen counts the same sessions the calendar shows.
 */
export function runwayScheduleSummary(blocks: readonly ScheduleBlock[], examId: string, todayKey: string, examTaskId?: string): RunwaySummary {
  const ids = new Set([runwayTaskId(examId), ...(examTaskId ? [examTaskId] : [])]);
  const mine = blocks
    .filter((b) => b.type === "study" && b.taskId !== undefined && ids.has(b.taskId) && b.completionStatus !== "skipped")
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const done = mine.filter((b) => b.completionStatus === "done").length;
  const upcoming = mine.filter((b) => b.completionStatus === "pending" && b.date >= todayKey);
  return {
    sessions: mine.length,
    minutes: mine.reduce((sum, b) => sum + blockMinutes(b), 0),
    done,
    upcoming: upcoming.length,
    next: upcoming[0] ?? null,
  };
}
