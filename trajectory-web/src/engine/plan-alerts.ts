// ============================================================
// One plan status for Today, Week and Tasks (pure)
// ============================================================
// The whole-semester plan records what it could not fit (AppState.planAlerts). This module turns that, the drift
// (missed sessions, overdue work) and the calendar into ONE status: a headline, a line of counts and one item per
// problem with its own fix (`planStatusFor`). Today shows it as a card, Week as a "N to review" pill, both open the
// same review sheet, so "4 overdue · ~9 h behind · Quiz 4 to record" reads the same everywhere. A quiz or exam whose
// date passed already took place: it is listed to record (done / skipped), never called overdue.

import type { AppState, PlanAlerts, Task } from "./types";
import { assessPlanQuality, PlanQualityReport } from "./plan-quality";
import { describeMinutes, describeMoreTime, dueLabel } from "./plan-format";
import { detectDrift } from "./replan";
import { isAssessmentTask } from "./task-kind";
import { blockMinutes, remainingMinutes } from "./task-progress";
import { relativeDayLabel } from "./due-label";
import { getSemesterWorkloadWarnings } from "./workload-analysis";
import { dateKeyOf, localDateKey, weekStartKeyOf } from "./utils";

type AlertState = Pick<AppState, "tasks" | "scheduleBlocks" | "planAlerts">;

/**
 * The solver's shortfalls, kept honest between plans: only for tasks that are still open, and never more minutes
 * than the task still needs (completing a session after the plan was made must not leave a stale, larger number).
 */
export function currentSolverShortfalls(state: Pick<AppState, "tasks" | "planAlerts">): PlanAlerts["shortfalls"] {
  const alerts = state.planAlerts;
  if (!alerts) return [];
  const open = new Map(state.tasks.filter((task) => task.status === "pending" || task.status === "scheduled").map((task) => [task.id, task]));
  const out: PlanAlerts["shortfalls"] = [];
  for (const shortfall of alerts.shortfalls) {
    const task = open.get(shortfall.taskId);
    if (!task) continue;
    const missingMinutes = Math.min(shortfall.missingMinutes, remainingMinutes(task));
    if (missingMinutes > 0) out.push({ ...shortfall, missingMinutes });
  }
  return out;
}

/** The plan-quality report for the current calendar, including what the solver says cannot fit. */
export function planQualityFor(state: AlertState, today: string): PlanQualityReport {
  return assessPlanQuality(state.tasks, state.scheduleBlocks, today, { solverShortfalls: currentSolverShortfalls(state) });
}

export interface PlanAlert {
  severity: "warning" | "critical";
  message: string;
  /** The task to open when the alert is tapped (the most urgent one it is about). */
  taskId?: string;
}

/**
 * The plan-quality report as one sentence: null when the plan is healthy. The screens show `planStatusFor` (below),
 * which lists the same problems one by one, each with its fix.
 */
export function planAlertFor(state: AlertState, now: Date = new Date()): PlanAlert | null {
  const report = planQualityFor(state, localDateKey(now));
  if (report.severity === "healthy") return null;
  return {
    severity: report.severity === "high" ? "critical" : "warning",
    message: report.message,
    taskId: report.overdueTaskIds[0] ?? report.shortfalls[0]?.taskId ?? report.unplannedTaskIds[0],
  };
}

// ── The plan status (Today's card, Week's pill, the review sheet) ──

/** What fixes one item; each screen maps it to the handler it already had. */
export type PlanFix =
  /** Move the deadline or trim the estimate: Tasks' edit sheet (it previews the replan before saving). */
  | { kind: "editTask"; taskId: string }
  /** A quiz / exam that took place: mark it done or skipped. */
  | { kind: "record"; taskId: string }
  /** Missed sessions: replan the semester ("Catch up"). */
  | { kind: "catchUp" }
  /** Work with no session on the calendar: replan the semester. */
  | { kind: "replan" }
  /** A heavy week ahead: look at what is due. */
  | { kind: "viewTasks" };

export type PlanStatusItemKind = "overdue" | "missed" | "short" | "record" | "unplanned" | "heavyWeek";

export interface PlanStatusItem {
  key: string;
  kind: PlanStatusItemKind;
  /** The task's name ("Missed sessions" / "Heavy week ahead" for the two summary items). */
  title: string;
  /** One plain line: "Was due yesterday · ~2 hours of work left". */
  detail: string;
  taskId?: string;
  fix: PlanFix;
}

export interface PlanStatusCounts {
  /** Open work past its due date (never a quiz / exam). */
  overdue: number;
  /** Minutes of work that should be done by now and is not (overdue work + missed sessions). */
  behindMinutes: number;
  /** Tasks that need more time than the calendar has before their deadline. */
  short: number;
  /** Quizzes / exams that took place without being marked done or skipped. */
  toRecord: number;
  /** Open work with no session on the calendar. */
  unplanned: number;
  heavyWeeks: number;
}

export interface PlanStatus {
  severity: "warning" | "critical";
  /** "Behind plan", "Short on time", "Not planned yet", "Quiz 4 took place", "Heavy week ahead". */
  headline: string;
  /** The counts in one line: "4 overdue · ~9 h behind · Quiz 4 to record". */
  summary: string;
  counts: PlanStatusCounts;
  /** Most urgent first: overdue, missed sessions, short on time, to record, not planned, heavy week. */
  items: PlanStatusItem[];
  /** Replanning the semester catches up (the student is behind): Today's card offers "Catch up". */
  canCatchUp: boolean;
}

/** "45 min" / "~1 h" / "~9 h": time in the compact counts line. */
function compactMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  return hours < 1.75 ? "~1 h" : `~${Math.round(hours)} h`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Everything about the plan that needs the student, merged into one status (null when there is nothing): overdue
 * work and missed sessions (from the drift), quizzes / exams that took place (to record, never "overdue"), tasks
 * short on time before their deadline and work not on the calendar (from the plan-quality report and the solver's
 * shortfalls), and with `userPrefs` a week ahead where the estimated work clusters. A task is listed once, under
 * the most urgent heading.
 */
export function planStatusFor(state: AlertState & Partial<Pick<AppState, "userPrefs">>, now: Date = new Date()): PlanStatus | null {
  const today = localDateKey(now);
  const drift = detectDrift(state, now);
  const report = planQualityFor(state, today);
  const taskById = new Map(state.tasks.map((task) => [task.id, task] as const));
  const dueKey = (task: Pick<Task, "dueDate">) => dateKeyOf(task.dueDate);

  // Quizzes / exams that took place: there is nothing to catch up, only to record.
  const recordIds = new Set<string>((drift.missedAssessments ?? []).map((entry) => entry.taskId));
  // Late work (never a quiz / exam).
  const overdueIds = new Set<string>(drift.overdueTasks.map((entry) => entry.taskId));
  for (const id of report.overdueTaskIds) {
    const task = taskById.get(id);
    if (!task) continue;
    (isAssessmentTask(task) ? recordIds : overdueIds).add(id);
  }
  for (const id of recordIds) overdueIds.delete(id);
  const listed = (id: string) => overdueIds.has(id) || recordIds.has(id);

  // Sessions that slipped for work that is neither overdue nor already taken place.
  const missedByTask = new Map<string, number>();
  let missedSessions = 0;
  for (const block of drift.missedBlocks) {
    if (!block.taskId || listed(block.taskId)) continue;
    missedSessions += 1;
    missedByTask.set(block.taskId, (missedByTask.get(block.taskId) ?? 0) + blockMinutes(block));
  }
  let missedMinutes = 0;
  for (const [taskId, minutes] of missedByTask) {
    const task = taskById.get(taskId);
    if (task) missedMinutes += Math.min(remainingMinutes(task), minutes);
  }

  const items: PlanStatusItem[] = [];
  const overdueTasks = [...overdueIds].map((id) => taskById.get(id)).filter((task): task is Task => Boolean(task))
    .sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.name.localeCompare(b.name));
  for (const task of overdueTasks) {
    const left = remainingMinutes(task);
    items.push({
      key: `overdue-${task.id}`,
      kind: "overdue",
      title: task.name,
      detail: `Was due ${relativeDayLabel(dueKey(task), today)}${left > 0 ? ` · ${describeMinutes(left)} of work left` : ""}`,
      taskId: task.id,
      fix: { kind: "editTask", taskId: task.id },
    });
  }

  const behind = drift.severity !== "none";
  const showMissed = behind && missedSessions > 0 && missedMinutes > 0;
  if (showMissed) {
    items.push({
      key: "missed",
      kind: "missed",
      title: "Missed sessions",
      detail: `${plural(missedSessions, "session", "sessions")} slipped · ${describeMinutes(missedMinutes)} to plan again`,
      fix: { kind: "catchUp" },
    });
  }

  const shortIds = new Set<string>();
  for (const shortfall of report.shortfalls) {
    if (listed(shortfall.taskId) || shortIds.has(shortfall.taskId)) continue;
    shortIds.add(shortfall.taskId);
    const deferred = report.deferredPastDeadlineTaskIds?.includes(shortfall.taskId) ?? false;
    items.push({
      key: `short-${shortfall.taskId}`,
      kind: "short",
      title: shortfall.taskName,
      detail: deferred
        ? `Moved past its deadline (${dueLabel(shortfall.dueDate, today)}): ${describeMinutes(shortfall.missingMinutes)} is not planned in time`
        : `Needs ${describeMoreTime(shortfall.missingMinutes)} before ${dueLabel(shortfall.dueDate, today)}`,
      taskId: shortfall.taskId,
      fix: { kind: "editTask", taskId: shortfall.taskId },
    });
  }

  const recordTasks = [...recordIds].map((id) => taskById.get(id)).filter((task): task is Task => Boolean(task))
    .sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.name.localeCompare(b.name));
  for (const task of recordTasks) {
    items.push({
      key: `record-${task.id}`,
      kind: "record",
      title: task.name,
      detail: `Took place ${relativeDayLabel(dueKey(task), today)} · mark it done or skipped`,
      taskId: task.id,
      fix: { kind: "record", taskId: task.id },
    });
  }

  // Not on the calendar (a task whose sessions slipped is covered by "Missed sessions": catching up plans it).
  const unplanned = report.unplannedTaskIds
    .filter((id) => !listed(id) && !shortIds.has(id) && !(showMissed && missedByTask.has(id)))
    .map((id) => taskById.get(id))
    .filter((task): task is Task => Boolean(task));
  for (const task of unplanned) {
    items.push({
      key: `unplanned-${task.id}`,
      kind: "unplanned",
      title: task.name,
      detail: `Not on your calendar yet · due ${dueLabel(dueKey(task), today)}`,
      taskId: task.id,
      fix: { kind: "replan" },
    });
  }

  // A week where the estimated work clusters, unless every task due that week is already listed above (the same problem).
  const unplannedIds = new Set(unplanned.map((task) => task.id));
  const warning = state.userPrefs ? getSemesterWorkloadWarnings(state.tasks, state.userPrefs.scheduleIntensity, now)[0] : undefined;
  const heavy = warning && state.tasks.some((task) =>
    (task.status === "pending" || task.status === "scheduled") && weekStartKeyOf(dueKey(task)) === warning.weekStart &&
    !listed(task.id) && !shortIds.has(task.id) && !unplannedIds.has(task.id))
    ? warning
    : undefined;
  if (heavy) {
    items.push({ key: `heavy-${heavy.weekStart}`, kind: "heavyWeek", title: "Heavy week ahead", detail: heavy.message, fix: { kind: "viewTasks" } });
  }

  if (items.length === 0) return null;

  const counts: PlanStatusCounts = {
    overdue: overdueTasks.length,
    behindMinutes: behind ? drift.behindMinutes : 0,
    short: shortIds.size,
    toRecord: recordTasks.length,
    unplanned: unplanned.length,
    heavyWeeks: heavy ? 1 : 0,
  };
  const summary = [
    counts.overdue > 0 ? `${counts.overdue} overdue` : "",
    counts.behindMinutes > 0 ? `${compactMinutes(counts.behindMinutes)} behind` : "",
    counts.short > 0 ? `${counts.short} short on time` : "",
    counts.toRecord === 1 ? `${recordTasks[0]!.name} to record` : counts.toRecord > 1 ? `${counts.toRecord} to record` : "",
    counts.unplanned > 0 ? `${counts.unplanned} not planned` : "",
    counts.heavyWeeks > 0 ? "heavy week ahead" : "",
  ].filter(Boolean).join(" · ");
  const headline =
    counts.overdue > 0 || behind ? "Behind plan"
      : counts.short > 0 ? "Short on time"
        : counts.unplanned > 0 ? "Not planned yet"
          : counts.toRecord === 1 ? `${recordTasks[0]!.name} took place`
            : counts.toRecord > 1 ? `${counts.toRecord} quizzes or exams took place`
              : "Heavy week ahead";
  const critical = counts.overdue > 0 || drift.severity === "high" || report.severity === "high";
  return { severity: critical ? "critical" : "warning", headline, summary, counts, items, canCatchUp: behind };
}
