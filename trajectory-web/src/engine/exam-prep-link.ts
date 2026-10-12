/**
 * Exam prep follows its exam (pure).
 *
 * An exam prep (ExamPrep) and its study-time task (lib/exam-runway.ts, id "exam-runway-<examId>") are linked by
 * `examTaskId` to the exam or quiz task they prepare for, usually one the syllabus import created. That task is the
 * one source of truth for the exam's date and time: when the exam moves (chat, the task editor, a re-import) the
 * countdown, the Study tab and the prep sessions follow it on the next plan, and undo (which restores the task)
 * moves them back. Preps saved before the link existed are matched once by course and date.
 *
 * Once a prep's study task is linked to its exam, the exam is planned ONLY through that task while it is open
 * (examsPlannedByPrep), and the task is sized to at least the exam's own estimate (sizePrepsToExams). A finished prep's
 * minutes count toward its exam (prepCredit).
 *
 * No planner imports here: lib/week-planner.ts calls followExamDates and sizePrepsToExams on every plan.
 */
import type { ExamPrep, PlannedStudySession, Task } from "./types";
import { classifyTaskKind, isTestedTask } from "./task-kind";
import { planSessionChunks } from "./session-chunks";
import { remainingMinutes } from "./task-progress";
import { dateKeyOf } from "./utils";

export const RUNWAY_TASK_PREFIX = "exam-runway-";

export function runwayTaskId(examId: string): string {
  return `${RUNWAY_TASK_PREFIX}${examId}`;
}

export function isRunwayTask(task: Pick<Task, "id">): boolean {
  return task.id.startsWith(RUNWAY_TASK_PREFIX);
}

/** An exam or quiz the student sits (never an exam prep's own study task). */
export function isExamTask(task: Pick<Task, "id" | "name" | "kind">): boolean {
  return !isRunwayTask(task) && isTestedTask(task);
}

/**
 * The exam or quiz task of `courseId` on `dateKey` when there is exactly one best candidate (an exam beats a quiz).
 * Undefined when there is none or it is ambiguous: a prep is never linked to a guess.
 */
export function matchExamTask<T extends Task>(tasks: readonly T[], courseId: string, dateKey: string): T | undefined {
  if (!courseId || !dateKey) return undefined;
  const candidates = tasks.filter((task) => task.courseId === courseId && dateKeyOf(task.dueDate) === dateKey && isExamTask(task));
  const exams = candidates.filter((task) => classifyTaskKind(task) === "exam");
  const pool = exams.length > 0 ? exams : candidates;
  return pool.length === 1 ? pool[0] : undefined;
}

/**
 * The exam task a prep is for: its own link, then its study task's link, then (preps saved before links existed)
 * the one exam of its class on its date. A link to a task that no longer exists is not replaced by a guess.
 */
export function findExamTask<T extends Task>(
  exam: Pick<ExamPrep, "id" | "classId" | "examDate" | "examTaskId">,
  tasks: readonly T[],
): T | undefined {
  const byId = (id: string | undefined) => (id ? tasks.find((task) => task.id === id && !isRunwayTask(task)) : undefined);
  if (exam.examTaskId) return byId(exam.examTaskId);
  return byId(tasks.find((task) => task.id === runwayTaskId(exam.id))?.examTaskId) ?? matchExamTask(tasks, exam.classId, dateKeyOf(exam.examDate));
}

/** "HH:MM" that means a real time ("00:00" reads as "no time", as in lib/task-kind.ts taskDeadline). */
function realTime(time: string | undefined): time is string {
  return typeof time === "string" && /^\d{1,2}:\d{2}$/.test(time) && time !== "00:00" && time !== "0:00";
}

/** The time that goes with the exam task's date: its own time, else the one kept so far while the day is unchanged. */
function followTime(exam: Pick<Task, "dueDate" | "dueTime">, previousDate: string, previousTime: string | undefined): string | undefined {
  if (realTime(exam.dueTime)) return exam.dueTime;
  return dateKeyOf(exam.dueDate) === dateKeyOf(previousDate) && realTime(previousTime) ? previousTime : undefined;
}

/**
 * The prep as the screens show it: date and time taken from its exam task, with the link filled in. Returns `exam`
 * itself when there is no exam task or nothing differs.
 */
export function withLinkedExam(exam: ExamPrep, tasks: readonly Task[]): ExamPrep {
  const task = findExamTask(exam, tasks);
  if (!task) return exam;
  const examDate = dateKeyOf(task.dueDate) || exam.examDate;
  const examTime = followTime(task, exam.examDate, exam.examTime);
  if (exam.examTaskId === task.id && exam.examDate === examDate && exam.examTime === examTime) return exam;
  const linked: ExamPrep = { ...exam, examTaskId: task.id, examDate };
  if (examTime) linked.examTime = examTime;
  else delete linked.examTime;
  return linked;
}

/**
 * Exam prep study tasks with their due date and time taken from the exam they prepare for, so every plan puts the
 * prep before the exam's CURRENT date. A study task saved before links existed is linked by course and date,
 * matched in `before` (the tasks as they were before a change moved the exam; defaults to `tasks`).
 * Pure: returns `tasks` itself when nothing changes, and unchanged tasks are the same objects.
 */
export function followExamDates<T extends Task>(tasks: readonly T[], before: readonly Task[] = tasks): T[] {
  let changed = false;
  const next = tasks.map((task) => {
    if (!isRunwayTask(task)) return task;
    const examTaskId = task.examTaskId ?? matchExamTask(before, task.courseId, dateKeyOf(task.dueDate))?.id;
    const exam = examTaskId ? tasks.find((candidate) => candidate.id === examTaskId && !isRunwayTask(candidate)) : undefined;
    if (!exam) return task;
    const dueDate = dateKeyOf(exam.dueDate) || task.dueDate;
    const dueTime = followTime(exam, task.dueDate, task.dueTime);
    if (task.examTaskId === exam.id && task.dueDate === dueDate && task.dueTime === dueTime) return task;
    changed = true;
    const moved: T = { ...task, examTaskId: exam.id, dueDate };
    if (dueTime) moved.dueTime = dueTime;
    else delete moved.dueTime;
    return moved;
  });
  return changed ? next : (tasks as T[]);
}

// ── One plan per exam ─────────────────────────────────────────

const isOpen = (task: Pick<Task, "status">) => task.status === "pending" || task.status === "scheduled";
const newer = (a: Task, b: Task) => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/** The newest prep study task linked to each exam (any status), by the exam's task id. */
function newestPreps(tasks: readonly Task[]): Map<string, Task> {
  const exams = new Set(tasks.filter((task) => !isRunwayTask(task)).map((task) => task.id));
  const newest = new Map<string, Task>();
  for (const task of tasks) {
    if (!isRunwayTask(task) || !task.examTaskId || !exams.has(task.examTaskId)) continue;
    const current = newest.get(task.examTaskId);
    if (!current || newer(task, current)) newest.set(task.examTaskId, task);
  }
  return newest;
}

/**
 * The tasks planned only through an exam prep, each mapped to the id of the prep study task that plans for them. Once a
 * prep's study task is linked to its exam, the exam gets no sessions of its own while that prep is open: the 1.0.8 plan
 * gave FINC Exam 1 its own 240 minutes AND its prep's 405. With two preps for one exam only the newest plans, and the
 * older one is planned through it too. Once the newest prep is finished or skipped, its exam is planned on its own again
 * for what its preps' finished minutes do not cover (prepCredit): a prep that covered the exam brings nothing back, an
 * exam whose estimate grew after its prep was done gets the difference (1.0.9 audit: it got no time and no alert).
 * Deleting the prep unlinks the exam, so its own sessions come back. Call after followExamDates (it links tasks saved
 * before links).
 */
export function examsPlannedByPrep(tasks: readonly Task[]): Map<string, string> {
  const newest = newestPreps(tasks);
  const plannedBy = new Map<string, string>();
  for (const [examId, prep] of newest) if (isOpen(prep)) plannedBy.set(examId, prep.id);
  for (const task of tasks) {
    const prep = isRunwayTask(task) && task.examTaskId ? newest.get(task.examTaskId) : undefined;
    if (prep && prep.id !== task.id) plannedBy.set(task.id, prep.id);
  }
  return plannedBy;
}

/**
 * Minutes of study each exam already had through its preps, for the exams whose newest prep is finished or skipped (so
 * planned on their own again, examsPlannedByPrep): the finished minutes of every prep linked to it. The planner counts
 * them as covered, so only what the exam's estimate asks for beyond them is planned (FINC Exam 1 raised from 240 to
 * 360 minutes after its 240-minute prep was done: 120).
 */
export function prepCredit(tasks: readonly Task[]): Map<string, number> {
  const credit = new Map<string, number>();
  for (const [examId, prep] of newestPreps(tasks)) {
    if (isOpen(prep)) continue;
    const minutes = tasks.reduce((sum, task) => sum + (isRunwayTask(task) && task.examTaskId === examId ? task.completedMinutes ?? 0 : 0), 0);
    if (minutes > 0) credit.set(examId, minutes);
  }
  return credit;
}

/** Label of the sessions that size an exam prep to its exam (never a topic session's: those start Learn / Review / Quiz / Final). */
export const MIXED_PRACTICE_LABEL = "Mixed practice: all topics";
/** A top-up smaller than this is noise, and the solver plans no named session under it anyway. */
const MIN_TOP_UP_MINUTES = 15;

const isTopUp = (session: Pick<PlannedStudySession, "label">) => session.label === MIXED_PRACTICE_LABEL;
const sumMinutes = (sessions: readonly PlannedStudySession[]) => sessions.reduce((sum, session) => sum + session.minutes, 0);

/**
 * An exam prep's study task sized to its exam: it plans the larger of its own sessions and the exam's remaining estimate.
 * When the exam needs more, "Mixed practice" sessions of at most `maxSessionMinutes` make up the difference, in the
 * second half of the runway (before the final review), so creating a prep never silently cuts the exam's study time.
 * Earlier top-ups are recomputed, never stacked. Returns `prep` itself when nothing changes (and for a closed prep).
 */
export function withExamTopUp<T extends Task>(prep: T, exam: Pick<Task, "estimatedMinutes" | "completedMinutes" | "status"> | undefined, maxSessionMinutes: number): T {
  const sessions = prep.planningStrategy?.sessions ?? [];
  if (!isOpen(prep) || sessions.length === 0) return prep;
  const own = sessions.filter((session) => !isTopUp(session));
  const before = sessions.filter(isTopUp);
  const ownMinutes = own.length > 0 ? sumMinutes(own) : Math.max(0, prep.estimatedMinutes - sumMinutes(before));
  const missing = (exam && isOpen(exam) ? remainingMinutes(exam) : 0) - ownMinutes;
  const chunks = missing >= MIN_TOP_UP_MINUTES ? planSessionChunks(missing, maxSessionMinutes) : [];
  const runway = own.reduce((most, session) => Math.max(most, session.targetDaysBeforeDue, Number.isFinite(session.earliestDaysBeforeDue) ? session.earliestDaysBeforeDue : 0), 0);
  const high = Math.max(1, Math.round(runway / 2));
  const low = Math.min(high, runway >= 2 ? 2 : runway);
  const topUp: PlannedStudySession[] = chunks.map((minutes, index) => ({
    label: MIXED_PRACTICE_LABEL,
    purpose: "practice",
    minutes,
    targetDaysBeforeDue: runway === 0 ? 0 : Math.round(chunks.length === 1 ? (high + low) / 2 : high - (index * (high - low)) / (chunks.length - 1)),
    earliestDaysBeforeDue: runway,
  }));
  const estimatedMinutes = ownMinutes + sumMinutes(topUp);
  const same = before.length === topUp.length && before.every((session, index) => {
    const next = topUp[index]!;
    return session.minutes === next.minutes && session.targetDaysBeforeDue === next.targetDaysBeforeDue && session.earliestDaysBeforeDue === next.earliestDaysBeforeDue;
  });
  if (same && estimatedMinutes === prep.estimatedMinutes) return prep;
  return { ...prep, estimatedMinutes, planningStrategy: { ...prep.planningStrategy!, sessions: [...own, ...topUp] } };
}

/**
 * Every prep that plans for an exam (examsPlannedByPrep) sized to that exam (withExamTopUp). Pure: returns `tasks`
 * itself when nothing changes, and unchanged tasks are the same objects.
 */
export function sizePrepsToExams<T extends Task>(tasks: readonly T[], maxSessionMinutes: number): T[] {
  const plannedBy = examsPlannedByPrep(tasks);
  if (plannedBy.size === 0) return tasks as T[];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let changed = false;
  const next = tasks.map((task) => {
    if (!isRunwayTask(task) || !task.examTaskId || plannedBy.get(task.examTaskId) !== task.id) return task;
    const sized = withExamTopUp(task, byId.get(task.examTaskId), maxSessionMinutes);
    if (sized !== task) changed = true;
    return sized;
  });
  return changed ? next : (tasks as T[]);
}

/** Preps whose stored link, date or time is behind their exam task (to be saved), each already updated. */
export function examPrepsToRelink(examPreps: readonly ExamPrep[] | undefined, tasks: readonly Task[]): ExamPrep[] {
  return (examPreps ?? []).flatMap((exam) => {
    const linked = withLinkedExam(exam, tasks);
    return linked === exam ? [] : [linked];
  });
}
