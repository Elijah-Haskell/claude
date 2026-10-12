// ============================================================
// Dynamic re-plan: detect drift, preview a new plan, apply it, undo it (pure)
// ============================================================
// "When anything changes the AI rewrites the schedule so it's no big deal" only holds if the rewrite is safe:
//  - nothing changes until the student has SEEN what will move (`replanSemester` / `previewPlanChange` return a
//    preview and never touch state),
//  - it is one tap to apply, and one tap to undo (`withUndoSnapshot` / `undoLastChange`).

import type {
  AppState,
  PlanAlerts,
  ReplanSnapshot,
  ScheduleBlock,
  Task,
} from "./types";
import { plannedMinutesFor, type OverdueTask, type TaskShortfall } from "./intelligent-scheduler";
import { buildSemesterPlan } from "./semester-plan";
import { fixMyDayDetailed } from "./scheduler";
import { isRegeneratedStructural, ReleasedSession, ReleaseReason } from "./week-planner";
import { blockMinutes, remainingMinutes } from "./task-progress";
import { addDaysToKey, dateKeyOf, daysBetweenKeys, localDateKey, minutesToTime, timeToMinutes } from "./utils";
import { describeMinutes, describeMoreTime, dueLabel } from "./plan-format";
import { deadlinePassed, isAssessmentTask, taskDeadline } from "./task-kind";
import { followExamDates } from "./exam-prep-link";
import { buildBusyMap } from "./busy-windows";
import { busyCalendarEvents } from "./calendar-events";
import { isClassDay } from "./semester";
import { MIN_SESSION_MINUTES } from "./session-chunks";

/** How many undoable changes are kept (newest first). */
export const MAX_UNDO_SNAPSHOTS = 3;
/** Missed sessions older than this are history, not drift. */
export const DRIFT_LOOKBACK_DAYS = 14;

/** The parts of the state a plan change may replace. Only the keys present are replaced (and snapshotted). */
export type PlanPatch = Partial<Pick<AppState, "scheduleBlocks" | "tasks" | "classes" | "recurringEvents" | "healthPrefs" | "planAlerts">>;

const isActive = (task: Task) => task.status === "pending" || task.status === "scheduled";
const hhmm = (now: Date) => `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

/** True when the block has already ended at `now`. */
function hasEnded(block: Pick<ScheduleBlock, "date" | "endTime">, todayKey: string, nowHHMM: string): boolean {
  return block.date < todayKey || (block.date === todayKey && block.endTime <= nowHHMM);
}

// ── Drift ─────────────────────────────────────────────────────

export interface DriftReport {
  /** Study sessions of unfinished tasks whose time passed without being completed (last 14 days). */
  missedBlocks: ScheduleBlock[];
  /** Overdue work a re-plan can still catch up on (never a quiz / exam: see missedAssessments). */
  overdueTasks: OverdueTask[];
  /**
   * Quizzes / exams whose date passed without being marked done. They already took place: re-planning cannot help,
   * so they neither count as "behind" nor raise the severity. The student marks them done or skipped.
   */
  missedAssessments?: OverdueTask[];
  /** Minutes of work that should already be done and is not. */
  behindMinutes: number;
  /** none: nothing to do; watch: a session or two slipped; high: overdue work or 3+ hours behind. */
  severity: "none" | "watch" | "high";
}

/**
 * How far the student has fallen behind the plan. A session counts as missed when it ended without being
 * completed or started, and its task is still open. Started sessions are left alone (the student was working).
 * Sessions the automatic re-plan recorded as missed (`autoMissed`) still count until the student re-plans.
 */
export function detectDrift(
  state: Pick<AppState, "tasks" | "scheduleBlocks">,
  now: Date = new Date(),
): DriftReport {
  const todayKey = localDateKey(now);
  const nowHHMM = hhmm(now);
  const since = addDaysToKey(todayKey, -DRIFT_LOOKBACK_DAYS);
  const activeById = new Map(state.tasks.filter(isActive).map((task) => [task.id, task]));

  const missedBlocks = state.scheduleBlocks.filter((block) => (
    block.type === "study" &&
    block.taskId !== undefined &&
    activeById.has(block.taskId) &&
    // A session a re-plan the student ran recorded as "missed" was absorbed (its minutes are planned again): it stays on
    // the calendar as history but is no longer drift, or "You're behind - re-plan?" could never be cleared. One the
    // automatic re-plan recorded is still news to the student: it counts until they re-plan (or tick it done).
    (block.completionStatus === "pending" || (block.completionStatus === "missed" && block.autoMissed === true)) &&
    !block.startedAt &&
    block.date >= since &&
    hasEnded(block, todayKey, nowHHMM)
  ));

  const missedByTask = new Map<string, number>();
  for (const block of missedBlocks) missedByTask.set(block.taskId!, (missedByTask.get(block.taskId!) ?? 0) + blockMinutes(block));

  const overdueTasks: OverdueTask[] = [];
  const missedAssessments: OverdueTask[] = [];
  let behindMinutes = 0;
  for (const task of activeById.values()) {
    const remaining = remainingMinutes(task);
    if (remaining <= 0) continue;
    const dueKey = dateKeyOf(task.dueDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueKey) && dueKey < todayKey) {
      const entry: OverdueTask = { taskId: task.id, taskName: task.name, dueDate: dueKey, daysOverdue: daysBetweenKeys(dueKey, todayKey) };
      if (isAssessmentTask(task)) {
        missedAssessments.push({ ...entry, missedAssessment: true }); // it happened; there is nothing to catch up on
        continue;
      }
      overdueTasks.push(entry);
      behindMinutes += remaining; // all of it is late
    } else {
      behindMinutes += Math.min(remaining, missedByTask.get(task.id) ?? 0);
    }
  }
  overdueTasks.sort((a, b) => b.daysOverdue - a.daysOverdue);
  missedAssessments.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const severity: DriftReport["severity"] = overdueTasks.length > 0 || behindMinutes >= 180
    ? "high"
    : behindMinutes >= 30
    ? "watch"
    : "none";
  return { missedBlocks, overdueTasks, missedAssessments, behindMinutes, severity };
}

/** "You're ~3 hours behind." style headline for the Today banner. */
export function describeDrift(report: DriftReport): string {
  if (report.overdueTasks.length > 0) {
    const n = report.overdueTasks.length;
    return `${n} task${n === 1 ? " is" : "s are"} overdue${report.behindMinutes > 0 ? ` and you're ${describeMinutes(report.behindMinutes)} behind` : ""}`;
  }
  return `You're ${describeMinutes(report.behindMinutes)} behind`;
}

// ── Diff ──────────────────────────────────────────────────────

export interface BlockRef {
  id: string;
  title: string;
  taskId?: string;
  taskName?: string;
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
}

export interface Slot { date: string; startTime: string; endTime: string }

export interface ReplanMove {
  /** Id of the block after the change. */
  id: string;
  title: string;
  taskId?: string;
  taskName?: string;
  from: Slot;
  to: Slot;
  /** Why it moved when that is worth saying ("Missed earlier"). */
  note?: string;
}

export interface ReplanTaskDiff {
  /** Undefined for changes to blocks that belong to no task (events the student or the assistant added). */
  taskId?: string;
  taskName: string;
  added: BlockRef[];
  removed: BlockRef[];
  moved: ReplanMove[];
  unchanged: number;
  /** Minutes of this task the new plan still cannot fit before its deadline (0 when it all fits). */
  missingMinutes: number;
  /** Confirmed sessions of this task the change released (see ReplanDiff.released). */
  released?: ReleasedRef[];
}

/** A confirmed (accepted / dragged / locked) session a change made wrong, and why. */
export interface ReleasedRef extends BlockRef {
  reason: ReleaseReason;
  /** "Now after the deadline of Exam 2 (2026-11-18)", "Clashes with Job shift", ... */
  detail: string;
}

export interface ReplanDiff {
  added: BlockRef[];
  removed: BlockRef[];
  moved: ReplanMove[];
  /** Upcoming sessions and events that keep exactly their slot. */
  unchanged: number;
  /** Past unfinished sessions the re-plan records as missed. */
  markedMissed: BlockRef[];
  /**
   * Sessions the student had accepted, dragged or locked that no longer work after the change (after the deadline,
   * on top of a new commitment, for a finished task). They were released and their minutes planned again; they are
   * ALSO counted in removed / moved. Optional so older callers that build a diff by hand keep compiling.
   */
  released?: ReleasedRef[];
  byTask: ReplanTaskDiff[];
  /** False when applying would change nothing the student can see. */
  changed: boolean;
}

function toRef(block: ScheduleBlock, taskNames: Map<string, string>): BlockRef {
  return {
    id: block.id,
    title: block.title,
    taskId: block.taskId,
    taskName: block.taskId ? taskNames.get(block.taskId) : undefined,
    date: block.date,
    startTime: block.startTime,
    endTime: block.endTime,
    minutes: blockMinutes(block),
  };
}

const slotOf = (ref: Pick<BlockRef, "date" | "startTime" | "endTime">): Slot => ({ date: ref.date, startTime: ref.startTime, endTime: ref.endTime });
const slotKey = (ref: Pick<BlockRef, "taskId" | "date" | "startTime" | "endTime">) => `${ref.taskId ?? ""}|${ref.date}|${ref.startTime}|${ref.endTime}`;
const byWhen = (a: Pick<BlockRef, "date" | "startTime" | "id">, b: Pick<BlockRef, "date" | "startTime" | "id">) =>
  a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id);

/** How far apart two sessions are, in minutes (used to pair a removed session with the one that replaced it). */
function distance(a: BlockRef, b: BlockRef): number {
  return Math.abs(daysBetweenKeys(a.date, b.date)) * 1440 + Math.abs(timeToMinutes(a.startTime) - timeToMinutes(b.startTime)) + Math.abs(a.minutes - b.minutes) * 2;
}

/**
 * What a plan change does to the schedule the student lives in: sessions and events that were added, removed or
 * moved. Structural blocks (sleep, classes, recurring commitments) are rebuilt identically and are not listed,
 * and neither is anything already in the past. A study session that merely gets a new number or id but keeps its
 * slot is "unchanged"; a removed session is paired with the nearest added one of the same task and reported as moved.
 */
export function diffPlans(
  before: ScheduleBlock[],
  after: ScheduleBlock[],
  context: { tasks: Task[]; recurringEvents: Array<{ title: string; startTime: string; endTime: string }>; now: Date; shortfalls?: TaskShortfall[]; markedMissed?: ScheduleBlock[]; released?: ReleasedSession[] },
): ReplanDiff {
  const todayKey = localDateKey(context.now);
  const nowHHMM = hhmm(context.now);
  const taskNames = new Map(context.tasks.map((task) => [task.id, task.name]));
  const relevant = (block: ScheduleBlock) =>
    (block.type as string) !== "meal" && (block.type as string) !== "workout" &&
    !isRegeneratedStructural(block, context.recurringEvents) &&
    !hasEnded(block, todayKey, nowHHMM);

  const beforeRefs = before.filter(relevant).map((block) => toRef(block, taskNames));
  const afterRefs = after.filter(relevant).map((block) => toRef(block, taskNames));

  const isStudy = (ref: BlockRef) => ref.taskId !== undefined;
  // Study sessions are identified by task + slot (their ids and "(2/4)" numbering shift when a sibling is added);
  // every other block is identified by its id.
  const beforeStudy = new Map<string, BlockRef[]>();
  for (const ref of beforeRefs.filter(isStudy)) {
    const list = beforeStudy.get(slotKey(ref));
    if (list) list.push(ref); else beforeStudy.set(slotKey(ref), [ref]);
  }
  const afterStudyLeft: BlockRef[] = [];
  let unchanged = 0;
  const unchangedByTask = new Map<string, number>();
  for (const ref of afterRefs.filter(isStudy)) {
    const list = beforeStudy.get(slotKey(ref));
    if (list && list.length > 0) {
      list.pop();
      unchanged += 1;
      unchangedByTask.set(ref.taskId!, (unchangedByTask.get(ref.taskId!) ?? 0) + 1);
    } else {
      afterStudyLeft.push(ref);
    }
  }
  const beforeStudyLeft = [...beforeStudy.values()].flat();

  const added: BlockRef[] = [];
  const removed: BlockRef[] = [];
  const moved: ReplanMove[] = [];

  // Pair leftovers of the same task: nearest first.
  const taskIds = new Set([...beforeStudyLeft, ...afterStudyLeft].map((ref) => ref.taskId!));
  for (const taskId of taskIds) {
    const gone = beforeStudyLeft.filter((ref) => ref.taskId === taskId).sort(byWhen);
    const fresh = afterStudyLeft.filter((ref) => ref.taskId === taskId).sort(byWhen);
    const pairs: Array<{ r: BlockRef; a: BlockRef; d: number }> = [];
    for (const r of gone) for (const a of fresh) pairs.push({ r, a, d: distance(r, a) });
    pairs.sort((x, y) => x.d - y.d || byWhen(x.r, y.r) || byWhen(x.a, y.a));
    const usedR = new Set<BlockRef>();
    const usedA = new Set<BlockRef>();
    for (const { r, a } of pairs) {
      if (usedR.has(r) || usedA.has(a)) continue;
      usedR.add(r);
      usedA.add(a);
      moved.push({ id: a.id, title: a.title, taskId, taskName: a.taskName, from: slotOf(r), to: slotOf(a) });
    }
    removed.push(...gone.filter((ref) => !usedR.has(ref)));
    added.push(...fresh.filter((ref) => !usedA.has(ref)));
  }

  // Everything that is not a study session: match by id.
  const beforeOther = new Map(beforeRefs.filter((ref) => !isStudy(ref)).map((ref) => [ref.id, ref]));
  for (const ref of afterRefs.filter((item) => !isStudy(item))) {
    const previous = beforeOther.get(ref.id);
    if (!previous) added.push(ref);
    else if (slotKey(previous) !== slotKey(ref)) moved.push({ id: ref.id, title: ref.title, from: slotOf(previous), to: slotOf(ref) });
    else unchanged += 1;
    beforeOther.delete(ref.id);
  }
  removed.push(...beforeOther.values());

  added.sort(byWhen);
  removed.sort(byWhen);
  moved.sort((a, b) => a.to.date.localeCompare(b.to.date) || a.to.startTime.localeCompare(b.to.startTime) || a.id.localeCompare(b.id));

  const markedMissed = (context.markedMissed ?? []).map((block) => toRef(block, taskNames)).sort(byWhen);
  // The released block as the student knew it (before this change), with the reason.
  const beforeById = new Map(before.map((block) => [block.id, block]));
  const released: ReleasedRef[] = (context.released ?? [])
    .map(({ block, reason, detail }) => ({ ...toRef(beforeById.get(block.id) ?? block, taskNames), reason, detail }))
    .sort(byWhen);

  // ── Group by task ──
  const missingByTask = new Map((context.shortfalls ?? []).map((shortfall) => [shortfall.taskId, shortfall.missingMinutes]));
  const groups = new Map<string, ReplanTaskDiff>();
  const groupFor = (taskId: string | undefined, fallbackName: string | undefined): ReplanTaskDiff => {
    const key = taskId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        taskId,
        taskName: (taskId ? taskNames.get(taskId) : undefined) ?? fallbackName ?? "Other changes",
        added: [], removed: [], moved: [],
        unchanged: taskId ? unchangedByTask.get(taskId) ?? 0 : 0,
        missingMinutes: taskId ? missingByTask.get(taskId) ?? 0 : 0,
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const ref of added) groupFor(ref.taskId, ref.taskName).added.push(ref);
  for (const ref of removed) groupFor(ref.taskId, ref.taskName).removed.push(ref);
  for (const move of moved) groupFor(move.taskId, move.taskName).moved.push(move);
  for (const ref of released) (groupFor(ref.taskId, ref.taskName).released ??= []).push(ref);
  for (const shortfall of context.shortfalls ?? []) groupFor(shortfall.taskId, shortfall.taskName);

  const firstDate = (group: ReplanTaskDiff) => [
    ...group.added.map((ref) => ref.date),
    ...group.removed.map((ref) => ref.date),
    ...group.moved.map((move) => move.to.date),
  ].sort()[0] ?? "9999-12-31";
  const byTask = [...groups.values()].sort((a, b) => firstDate(a).localeCompare(firstDate(b)) || a.taskName.localeCompare(b.taskName));

  return {
    added, removed, moved, unchanged, markedMissed, released, byTask,
    changed: added.length + removed.length + moved.length + markedMissed.length + released.length > 0,
  };
}

// ── Preview ───────────────────────────────────────────────────

export interface ReplanPreview {
  /** Short label for the preview title and the Undo UI. */
  label: string;
  /** What will replace the current plan when applied. Only the keys present are replaced. */
  next: PlanPatch & { scheduleBlocks: ScheduleBlock[]; tasks: Task[] };
  diff: ReplanDiff;
  /** Work that still does not fit before its deadline after this change. */
  shortfalls: TaskShortfall[];
  overdueTasks: OverdueTask[];
  /** One or two plain sentences: what the change does. */
  summary: string;
}

function summarize(diff: ReplanDiff, shortfalls: TaskShortfall[], todayKey: string): string {
  const parts: string[] = [];
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (diff.moved.length > 0) parts.push(`moves ${count(diff.moved.length, "session")}`);
  if (diff.added.length > 0) parts.push(`adds ${count(diff.added.length, "session")}`);
  if (diff.removed.length > 0) parts.push(`removes ${count(diff.removed.length, "session")}`);
  const released = diff.released ?? [];
  let text = parts.length > 0
    ? `This ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`
    : diff.markedMissed.length > 0 || released.length > 0
    ? "Nothing else needs to move."
    : "Your plan already fits: nothing needs to change.";
  if (released.length > 0) {
    const first = released[0]!;
    const n = released.length;
    const detail = `${first.detail[0]!.toLowerCase()}${first.detail.slice(1)}`;
    text += ` ${count(n, "session")} you had confirmed no longer ${n === 1 ? "works" : "work"} (${detail}${n > 1 ? ", and others" : ""}) and ${n === 1 ? "is" : "are"} planned again.`;
  }
  if (diff.markedMissed.length > 0) text += ` ${count(diff.markedMissed.length, "missed session")} will be marked as missed.`;
  if (shortfalls.length > 0) {
    const first = shortfalls[0]!;
    const more = shortfalls.length > 1 ? ` (and ${shortfalls.length - 1} more)` : "";
    text += ` Still short: ${first.taskName} needs ${describeMoreTime(first.missingMinutes)} before ${dueLabel(first.dueDate, todayKey)}${more}.`;
  }
  return text;
}

/**
 * Mark sessions that already ended unfinished as "missed" (history), so the plan stops counting them as
 * coverage for their task. Sessions the student started, and sessions of finished tasks, are left alone.
 * The student can still tick a missed session done (its minutes are credited; the make-up then goes).
 *  - `automatic` (the automatic re-plan): newly ended sessions are recorded with `autoMissed`, so the "You're behind"
 *    banner still shows them.
 *  - otherwise (a re-plan the student runs): those are acknowledged too (their `autoMissed` is cleared), which clears
 *    the banner.
 */
export function markMissedBlocks(
  state: Pick<AppState, "tasks" | "scheduleBlocks">,
  now: Date,
  options: { automatic?: boolean } = {},
): { blocks: ScheduleBlock[]; marked: ScheduleBlock[] } {
  const missedIds = new Set(detectDrift(state, now).missedBlocks
    .filter((block) => block.completionStatus === "pending" || !options.automatic)
    .map((block) => block.id));
  if (missedIds.size === 0) return { blocks: state.scheduleBlocks, marked: [] };
  const marked: ScheduleBlock[] = [];
  const blocks = state.scheduleBlocks.map((block) => {
    if (!missedIds.has(block.id)) return block;
    marked.push(block);
    const { autoMissed: _recorded, ...rest } = block;
    return options.automatic ? { ...rest, completionStatus: "missed" as const, autoMissed: true } : { ...rest, completionStatus: "missed" as const };
  });
  return { blocks, marked };
}

export interface ReplanOptions {
  now?: Date;
  /** Why the re-plan runs ("You're behind", "Tasks changed", ...): becomes the preview title and the Undo label. */
  reason?: string;
  /**
   * Also let the plan move upcoming sessions the student accepted (their own edits, started, locked and finished
   * sessions are never moved). Default false: accepted sessions stay put and the plan works around them.
   */
  moveAccepted?: boolean;
}

/**
 * The re-plan: catch up on missed sessions, absorb changed tasks, and refit the whole semester, WITHOUT touching
 * state. Returns what would change (`diff`), what still would not fit (`shortfalls`) and the blocks/tasks to apply.
 */
export function replanSemester(state: AppState, options: ReplanOptions = {}): ReplanPreview {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const nowHHMM = hhmm(now);
  const missed = markMissedBlocks(state, now);
  let blocks = missed.blocks;
  if (options.moveAccepted) {
    blocks = blocks.map((block) => (
      block.type === "study" && block.taskId && block.accepted && !block.locked && !block.userEdited && !block.startedAt &&
      block.completionStatus === "pending" && !hasEnded(block, todayKey, nowHHMM)
        ? { ...block, accepted: false }
        : block
    ));
  }
  const plan = buildSemesterPlan({ ...state, scheduleBlocks: blocks }, { now });
  const diff = diffPlans(state.scheduleBlocks, plan.scheduleBlocks, {
    tasks: state.tasks, recurringEvents: state.recurringEvents, now, shortfalls: plan.shortfalls, markedMissed: missed.marked,
    released: plan.releasedSessions,
  });
  return {
    label: options.reason ?? "Replan",
    next: { scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks, planAlerts: toPlanAlerts(plan.shortfalls, plan.overdueTasks, now) },
    diff,
    shortfalls: plan.shortfalls,
    overdueTasks: plan.overdueTasks,
    summary: summarize(diff, plan.shortfalls, todayKey),
  };
}

/** What of a task its sessions are planned from (not its name, score, progress or pending / scheduled state). */
function planningKey(task: Task): string {
  return [
    task.dueDate, task.dueTime ?? "", task.notBeforeDate ?? "", task.estimatedMinutes, task.difficulty, task.courseId, task.kind ?? "",
    (task.planningStrategy?.sessions ?? []).map((s) => `${s.label}/${s.minutes}/${s.targetDaysBeforeDue}/${s.earliestDaysBeforeDue}`).join(","),
  ].join("~");
}

/**
 * The tasks a change touched in a way their plan depends on: new ones, and those with a new date, time, estimate,
 * difficulty, course, kind or strategy (an exam's prep study moves with its exam). A stable re-plan plans these again
 * as a whole instead of keeping their sessions; progress is left to the planner's surplus / deficit handling.
 */
export function changedTaskIds(before: readonly Task[], after: readonly Task[]): Set<string> {
  const previous = new Map(followExamDates(before).map((task) => [task.id, planningKey(task)]));
  return new Set(followExamDates(after).filter((task) => previous.get(task.id) !== planningKey(task)).map((task) => task.id));
}

/**
 * Preview a change made to the plan's INPUTS (tasks, classes, recurring events, sleep window, one-off blocks) - for
 * instance one proposed by the AI assistant or a deadline edit: `after` is the state with the change already applied.
 * The plan is rebuilt for the whole semester from `after` the STABLE way (like the automatic re-plan): every
 * suggestion that still works stays, the tasks the change touched are planned again, and so is anything the change
 * made wrong. It is compared with what the student has now (`before`). Sessions that ended unticked are kept as missed.
 * With `replan: false` the change is previewed exactly as given (no new study sessions are planned).
 */
export function previewPlanChange(
  before: AppState,
  after: AppState,
  options: { now?: Date; label: string; replan?: boolean },
): ReplanPreview {
  const now = options.now ?? new Date();
  const missed = options.replan === false ? null : markMissedBlocks(after, now, { automatic: true });
  const plan: { scheduleBlocks: ScheduleBlock[]; tasks: Task[]; shortfalls: TaskShortfall[]; overdueTasks: OverdueTask[]; releasedSessions?: ReleasedSession[] } = options.replan === false
    ? { scheduleBlocks: after.scheduleBlocks, tasks: after.tasks, shortfalls: [], overdueTasks: [] }
    : buildSemesterPlan(missed?.marked.length ? { ...after, scheduleBlocks: missed.blocks } : after, {
        now, keepSuggestions: true, replanTaskIds: changedTaskIds(before.tasks, after.tasks),
      });
  const next: ReplanPreview["next"] = { scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks };
  if (options.replan !== false) next.planAlerts = toPlanAlerts(plan.shortfalls, plan.overdueTasks, now);
  if (after.classes !== before.classes) next.classes = after.classes;
  if (after.recurringEvents !== before.recurringEvents) next.recurringEvents = after.recurringEvents;
  if (after.healthPrefs !== before.healthPrefs) next.healthPrefs = after.healthPrefs;
  const diff = diffPlans(before.scheduleBlocks, plan.scheduleBlocks, {
    tasks: after.tasks, recurringEvents: after.recurringEvents, now, shortfalls: plan.shortfalls, released: plan.releasedSessions,
  });
  return {
    label: options.label,
    next,
    diff,
    shortfalls: plan.shortfalls,
    overdueTasks: plan.overdueTasks,
    summary: summarize(diff, plan.shortfalls, localDateKey(now)),
  };
}

// ── "Move to tomorrow" (defer a day) ──────────────────────────

/** Work the deferral would push past its deadline. */
export interface DeferralAtRisk {
  taskId: string;
  taskName: string;
  dueDate: string;
  dueTime?: string;
  /** A quiz / exam: moving its prep past the date means no prep at all (it cannot be done late). */
  assessment: boolean;
  /** Minutes of this task's sessions on the deferred day. */
  deferredMinutes: number;
  /** Minutes that no longer fit before the deadline once that day is off-limits. */
  missingMinutes: number;
}

export type DeferralResult =
  | {
      ok: true;
      label: string;
      /** Apply with APPLY_REPLAN (withUndoSnapshot). */
      next: PlanPatch & { scheduleBlocks: ScheduleBlock[]; tasks: Task[] };
      diff: ReplanDiff;
      /** Tasks moved to start tomorrow or later. */
      deferredTaskIds: string[];
      /** Tasks due by the deferred day whose work was moved to the time left BEFORE their deadline instead. */
      keptBeforeDeadline: string[];
      /** Only with acceptLate: work that is now planned after its deadline (homework) or not at all (quiz / exam). */
      late: DeferralAtRisk[];
      summary: string;
    }
  | {
      ok: false;
      reason: "past-deadline";
      /** Ask the student: keep the session(s), or call again with `acceptLate: true`. Nothing was changed. */
      atRisk: DeferralAtRisk[];
      summary: string;
    }
  | { ok: false; reason: "nothing-to-defer"; atRisk: []; summary: string };

/**
 * "Move to tomorrow" for every open study session on `date`, WITHOUT touching state (pure).
 *
 * Work due after `date` simply starts again tomorrow (Task.notBeforeDate), as before. Work due on or before `date`
 * cannot move to tomorrow without missing its deadline, so instead it goes to the time still left BEFORE the deadline
 * (never on `date` itself: the student just said not today). When even that does not fit, nothing is applied and the
 * result is `{ ok: false, reason: "past-deadline", atRisk }` so the UI can ask. Called again with `acceptLate: true`
 * the work is deferred anyway: homework becomes late catch-up work from tomorrow, a quiz / exam gets no more prep,
 * and both show up as shortfalls / overdue in the plan alerts (never silently dropped).
 *
 * `blockIds` moves only those open sessions (Today's "Move N to tomorrow" moves just the excess over the daily cap):
 * the day's other open sessions are pinned (accepted) so the re-plan leaves them exactly where they are.
 */
export function planDeferral(state: AppState, date: string, options: { now?: Date; acceptLate?: boolean; label?: string; blockIds?: readonly string[] } = {}): DeferralResult {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const tomorrow = addDaysToKey(date, 1);
  const only = options.blockIds ? new Set(options.blockIds) : null;
  const openOnDay = (block: ScheduleBlock) => block.date === date && block.type === "study" && block.completionStatus === "pending" && Boolean(block.taskId);
  const onDay = state.scheduleBlocks.filter((block) => openOnDay(block) && (!only || only.has(block.id)));
  const moving = new Set(onDay.map((block) => block.id));
  const taskIds = [...new Set(onDay.map((block) => block.taskId!))];
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  if (taskIds.length === 0) return { ok: false, reason: "nothing-to-defer", atRisk: [], summary: "There is no open study session to move." };

  const bound = new Set<string>(); // due by `date`, deadline not yet passed
  for (const id of taskIds) {
    const task = tasksById.get(id);
    if (!task) continue;
    const deadline = taskDeadline(task, state.classes, state.semester);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline.dueKey) || deadline.dueKey >= tomorrow) continue;
    if (!deadlinePassed(deadline, todayKey, nowMinutes)) bound.add(id);
  }

  const deferTo = (id: string) => !bound.has(id) || options.acceptLate === true;
  const deferred: AppState = {
    ...state,
    tasks: state.tasks.map((task) => (taskIds.includes(task.id) && deferTo(task.id) ? { ...task, status: "pending" as const, notBeforeDate: tomorrow } : task)),
    scheduleBlocks: state.scheduleBlocks.map((block) => (
      moving.has(block.id)
        ? { ...block, accepted: false, completionStatus: "skipped" as const, deferredDay: true }
        : only && openOnDay(block) ? { ...block, accepted: true } : block
    )),
  };
  // Stable, like the automatic re-plan: only the moved work is planned again; every other valid suggestion stays where
  // it is (it used to re-solve the whole semester and reshuffle ~100 later sessions for "Move 1 to tomorrow").
  const plan = buildSemesterPlan(deferred, { now, blockedDates: [date], keepSuggestions: true, replanTaskIds: new Set(taskIds) });

  const riskOf = (id: string, missingMinutes: number): DeferralAtRisk => {
    const task = tasksById.get(id)!;
    return {
      taskId: id,
      taskName: task.name,
      dueDate: dateKeyOf(task.dueDate),
      ...(task.dueTime ? { dueTime: task.dueTime } : {}),
      assessment: isAssessmentTask(task),
      deferredMinutes: onDay.filter((block) => block.taskId === id).reduce((sum, block) => sum + blockMinutes(block), 0),
      missingMinutes,
    };
  };
  const atRisk: DeferralAtRisk[] = [...bound].map((id) => riskOf(id, options.acceptLate
    ? remainingMinutes(tasksById.get(id)!)
    : plan.shortfalls.find((s) => s.taskId === id)?.missingMinutes ?? 0));
  // Work due later can still be squeezed: a quiz tomorrow at its 10:00 class has only the morning left once today is
  // off-limits. A shortfall the deferral creates (or grows) is a deadline at risk too, never a silent plan alert.
  const shortBefore = new Map((state.planAlerts?.shortfalls ?? []).map((s) => [s.taskId, s.missingMinutes]));
  const squeezed = taskIds
    .filter((id) => !bound.has(id) && tasksById.has(id))
    .flatMap((id) => {
      const missing = plan.shortfalls.find((s) => s.taskId === id)?.missingMinutes ?? 0;
      return missing > (shortBefore.get(id) ?? 0) ? [riskOf(id, missing)] : [];
    });
  const unsafe = [...atRisk.filter((risk) => risk.missingMinutes > 0), ...squeezed];

  if (unsafe.length > 0 && !options.acceptLate) {
    const first = unsafe[0]!;
    const more = unsafe.length > 1 ? ` (and ${unsafe.length - 1} more)` : "";
    const isSqueezed = !bound.has(first.taskId);
    return {
      ok: false,
      reason: "past-deadline",
      atRisk: unsafe,
      summary: isSqueezed
        ? `${first.taskName} is ${first.assessment ? "" : "due "}${dueLabel(first.dueDate, todayKey)}: after moving, only part of ${first.assessment ? "its prep" : "it"} fits before then${more}.`
        : first.assessment
        ? `${first.taskName} is ${dueLabel(first.dueDate, todayKey)}: moving its prep to tomorrow means no prep before it${more}.`
        : `${first.taskName} is due ${dueLabel(first.dueDate, todayKey)}: tomorrow would be late, and only part of it fits before then${more}.`,
    };
  }

  const label = options.label ?? "Move to tomorrow";
  // The skipped sessions stay on the calendar as history (the planner keeps skipped sessions, lib/week-planner.ts
  // isPreserved; appended here too in case one lies outside the planned window); they are left out of the comparison
  // so each one reads as MOVED to its new day.
  const skipped = deferred.scheduleBlocks.filter((block) => block.date === date && block.completionStatus === "skipped" && block.taskId && taskIds.includes(block.taskId) && onDay.some((o) => o.id === block.id));
  const planIds = new Set(plan.scheduleBlocks.map((block) => block.id));
  const scheduleBlocks = [...plan.scheduleBlocks, ...skipped.filter((block) => !planIds.has(block.id))];
  const diff = diffPlans(state.scheduleBlocks, plan.scheduleBlocks.filter((block) => !skipped.some((s) => s.id === block.id)), {
    tasks: plan.tasks, recurringEvents: state.recurringEvents, now, shortfalls: plan.shortfalls, released: plan.releasedSessions,
  });
  const late = options.acceptLate ? [...atRisk, ...squeezed] : [];
  const kept = options.acceptLate ? [] : [...bound];
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const pieces = [
    `${count(onDay.length, "session")} moved off ${dueLabel(date, todayKey)}.`,
    kept.length > 0 ? `${count(kept.length, "task")} due by then ${kept.length === 1 ? "was" : "were"} moved to the time left before ${kept.length === 1 ? "its" : "their"} deadline instead.` : "",
    options.acceptLate && atRisk.length > 0 ? `${atRisk.map((risk) => risk.taskName).join(", ")} will be late${atRisk.some((risk) => risk.assessment) ? " (no more prep before the quiz or exam)" : ""}.` : "",
    options.acceptLate && squeezed.length > 0 ? `${squeezed.map((risk) => risk.taskName).join(", ")} will not fully fit before ${squeezed.length === 1 ? "its" : "their"} deadline.` : "",
  ].filter(Boolean);
  return {
    ok: true,
    label,
    next: { scheduleBlocks, tasks: plan.tasks, planAlerts: toPlanAlerts(plan.shortfalls, plan.overdueTasks, now) },
    diff,
    deferredTaskIds: taskIds.filter(deferTo),
    keptBeforeDeadline: kept,
    late,
    summary: pieces.join(" "),
  };
}

// ── Fix My Day ────────────────────────────────────────────────

export interface FixMyDayPreview extends ReplanPreview {
  /** Sessions that found no free slot today, with the reason (they stay where they are, flagged, if applied). */
  unplaced: Array<{ block: BlockRef; reason: string }>;
}

/**
 * Preview "Fit the rest of today" (fixMyDay; "Use time up to bedtime" = crunch_mode): what moves, and what does not fit (with the reason). Nothing is applied. Moved sessions
 * are accepted in `next` so the next whole-semester plan keeps them where the student just confirmed them.
 * It keeps the planner's limits: a session never ends after its task's deadline (prep for a quiz / exam that has
 * taken place is not moved at all), and the no-study zones, commitments and calendar events the planner avoids are
 * busy. A missed session moved back into today makes the make-up planned for it surplus: that later session goes
 * (or is shortened), so the work is not planned twice.
 */
export function previewFixMyDay(
  state: Pick<AppState, "scheduleBlocks" | "tasks" | "healthPrefs"> & Partial<Pick<AppState, "classes" | "semester" | "recurringEvents" | "userPrefs" | "googleCalendarEvents" | "deviceCalendarEvents">>,
  date: string,
  mode: "protect_sleep" | "crunch_mode",
  options: { now?: Date } = {},
): FixMyDayPreview {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const taskNames = new Map(state.tasks.map((task) => [task.id, task.name]));
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const startedBlockIds = state.scheduleBlocks.filter((block) => block.startedAt).map((block) => block.id);
  const latestEndFor = (block: ScheduleBlock): number | null | undefined => {
    const task = block.taskId ? tasksById.get(block.taskId) : undefined;
    if (!task) return undefined;
    const deadline = taskDeadline(task, state.classes ?? [], state.semester);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline.dueKey) || deadline.dueKey > date) return undefined;
    // Prep for a quiz / exam that has taken place is pointless. Homework due that day ends by its due time (none left
    // once it has passed); homework already late from an earlier day is caught up on, as the planner does.
    if (isAssessmentTask(task) && deadlinePassed(deadline, todayKey, nowMinutes)) return null;
    if (deadline.dueKey < date) return isAssessmentTask(task) || deadline.dueKey >= todayKey ? null : undefined;
    return deadline.cutoffMinutes;
  };
  const busy = buildBusyMap([date], {
    classes: state.classes ?? [],
    recurringEvents: state.recurringEvents ?? [],
    scheduleBlocks: [],
    googleCalendarEvents: busyCalendarEvents(state),
    noGoZones: state.userPrefs?.noGoZones ?? [],
    isClassDay: state.semester ? (day) => isClassDay(state.semester, day) : undefined,
  })[date] ?? [];
  const result = fixMyDayDetailed(state.scheduleBlocks, date, mode, state.healthPrefs, { now, startedBlockIds, latestEndFor, busy });
  const movedIds = new Set(result.moved.map((move) => move.id));
  const byId = new Map(state.scheduleBlocks.map((block) => [block.id, block]));

  let moved: ReplanMove[] = result.moved.map((move) => {
    const original = byId.get(move.id);
    return {
      id: move.id,
      title: move.title,
      taskId: original?.taskId,
      taskName: original?.taskId ? taskNames.get(original.taskId) : undefined,
      from: { date, ...move.from },
      to: { date, ...move.to },
      note: move.wasMissed ? "Missed earlier" : undefined,
    };
  });
  const unplaced = result.unplaced.map(({ block, reason }) => ({ block: toRef(block, taskNames), reason }));
  let scheduleBlocks = result.blocks.map((block) => (movedIds.has(block.id) ? { ...block, accepted: true } : block));

  // Missed work moved back into today: the task's sessions still to do now cover more than it needs (its make-up is
  // still planned). The surplus goes from its other unconfirmed sessions, today's first (so the day does not gain a
  // session), then the latest; the last one is shortened when only part of it is surplus. If that is not enough (the
  // make-up was missed too), the missed sessions beyond what the task needs stay missed, or come back shorter.
  const removed: BlockRef[] = [];
  const shortened: ReplanMove[] = [];
  const notRevived = new Set<string>();
  const nowHHMM = hhmm(now);
  const revivedIds = new Set(result.moved.filter((move) => move.wasMissed).map((move) => move.id));
  const revivedTasks = new Set(moved.filter((move) => revivedIds.has(move.id)).map((move) => move.taskId ?? ""));
  for (const taskId of revivedTasks) {
    const task = tasksById.get(taskId);
    if (!task || !isActive(task)) continue;
    const upcoming = scheduleBlocks.filter((block) => block.type === "study" && block.taskId === taskId && block.completionStatus === "pending" && !hasEnded(block, todayKey, nowHHMM));
    let surplus = upcoming.reduce((sum, block) => sum + blockMinutes(block), 0) - plannedMinutesFor(task);
    const spare = upcoming
      .filter((block) => !movedIds.has(block.id) && !block.accepted && !block.locked && !block.userEdited && !block.startedAt)
      .sort((a, b) => Number(b.date === date) - Number(a.date === date) || byWhen(b, a));
    for (const block of spare) {
      if (surplus <= 0) break;
      const minutes = blockMinutes(block);
      if (minutes <= surplus) {
        scheduleBlocks = scheduleBlocks.filter((candidate) => candidate.id !== block.id);
        removed.push(toRef(block, taskNames));
        surplus -= minutes;
      } else if (minutes - surplus >= MIN_SESSION_MINUTES) {
        const endTime = minutesToTime(timeToMinutes(block.startTime) + minutes - surplus);
        scheduleBlocks = scheduleBlocks.map((candidate) => (candidate.id === block.id ? { ...candidate, endTime } : candidate));
        shortened.push({ id: block.id, title: block.title, taskId, taskName: task.name, from: slotOf(block), to: { ...slotOf(block), endTime }, note: "Shorter: you are catching up today" });
        surplus = 0;
      }
    }
    const revived = moved.filter((move) => move.taskId === taskId && revivedIds.has(move.id)).sort((a, b) => b.to.startTime.localeCompare(a.to.startTime));
    for (const move of revived) {
      if (surplus <= 0) break;
      const minutes = timeToMinutes(move.to.endTime) - timeToMinutes(move.to.startTime);
      if (minutes <= surplus) {
        scheduleBlocks = scheduleBlocks.map((candidate) => (candidate.id === move.id ? byId.get(move.id) ?? candidate : candidate));
        notRevived.add(move.id);
        surplus -= minutes;
      } else {
        if (minutes - surplus >= MIN_SESSION_MINUTES) {
          const endTime = minutesToTime(timeToMinutes(move.to.startTime) + minutes - surplus);
          scheduleBlocks = scheduleBlocks.map((candidate) => (candidate.id === move.id ? { ...candidate, endTime } : candidate));
          move.to = { ...move.to, endTime };
        }
        break;
      }
    }
  }
  if (notRevived.size > 0) moved = moved.filter((move) => !notRevived.has(move.id));

  const groups = new Map<string, ReplanTaskDiff>();
  const groupFor = (taskId: string | undefined, taskName: string | undefined): ReplanTaskDiff => {
    const key = taskId ?? "";
    const group = groups.get(key) ?? { taskId, taskName: taskName ?? "Other sessions", added: [], removed: [], moved: [], unchanged: 0, missingMinutes: 0 };
    groups.set(key, group);
    return group;
  };
  for (const move of [...moved, ...shortened]) groupFor(move.taskId, move.taskName).moved.push(move);
  for (const ref of removed) groupFor(ref.taskId, ref.taskName).removed.push(ref);
  const diff: ReplanDiff = {
    added: [], removed, moved: [...moved, ...shortened], unchanged: 0, markedMissed: [],
    byTask: [...groups.values()],
    changed: moved.length + shortened.length + removed.length + unplaced.length > 0,
  };
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const summary = !diff.changed
    ? "Your day already fits: nothing needs to move."
    : [
        moved.length > 0 ? `This moves ${count(moved.length, "session")} into free time today.` : "",
        removed.length > 0 ? `${count(removed.length, "later session")} ${removed.length === 1 ? "is" : "are"} no longer needed.` : "",
        shortened.length > 0 ? `${count(shortened.length, "later session")} ${shortened.length === 1 ? "is" : "are"} shorter.` : "",
        unplaced.length > 0 ? `${count(unplaced.length, "session")} will not fit today.` : "",
      ].filter(Boolean).join(" ");
  return {
    label: "Fit the rest of today",
    next: { scheduleBlocks, tasks: state.tasks },
    diff,
    shortfalls: [],
    overdueTasks: [],
    summary,
    unplaced,
  };
}

// ── Apply / undo ──────────────────────────────────────────────

/**
 * Apply a plan change and remember how to undo it. The snapshot keeps the pre-change value of exactly the keys
 * the patch replaces; the newest MAX_UNDO_SNAPSHOTS snapshots are kept.
 */
export function withUndoSnapshot(state: AppState, meta: { label: string; at: string }, patch: PlanPatch): AppState {
  const snapshot: ReplanSnapshot = {
    label: meta.label,
    at: meta.at,
    scheduleBlocks: state.scheduleBlocks,
    tasks: state.tasks,
  };
  if (patch.classes) snapshot.classes = state.classes;
  if (patch.recurringEvents) snapshot.recurringEvents = state.recurringEvents;
  if (patch.healthPrefs) snapshot.healthPrefs = state.healthPrefs;
  if ("planAlerts" in patch) snapshot.planAlerts = state.planAlerts;
  return {
    ...state,
    ...patch,
    undoSnapshots: [snapshot, ...(state.undoSnapshots ?? [])].slice(0, MAX_UNDO_SNAPSHOTS),
  };
}

/**
 * Restore the newest snapshot exactly and drop it. A state with nothing to undo is returned as is. A snapshot of an
 * automatic re-plan after an edit also holds the edited inputs (commitments, classes, sleep hours, semester, study
 * settings, the task list with the schedule it had) as they were before it, so the plan and what it was built from
 * come back together.
 */
export function undoLastChange(state: AppState): AppState {
  const [latest, ...rest] = state.undoSnapshots ?? [];
  if (!latest) return state;
  const restored: AppState = {
    ...state,
    scheduleBlocks: latest.scheduleBlocks,
    tasks: latest.tasks,
    undoSnapshots: rest.length > 0 ? rest : undefined,
    inputsBeforeEdit: undefined,
  };
  if (latest.classes) restored.classes = latest.classes;
  if (latest.recurringEvents) restored.recurringEvents = latest.recurringEvents;
  if (latest.healthPrefs) restored.healthPrefs = latest.healthPrefs;
  if (latest.userPrefs) restored.userPrefs = latest.userPrefs;
  if (latest.semester !== undefined) {
    restored.semester = latest.semester ?? undefined;
    // The profile's semester label follows the semester (see SET_SEMESTER).
    if (latest.semester && state.user && state.user.currentSemester !== latest.semester.name) restored.user = { ...state.user, currentSemester: latest.semester.name };
  }
  if ("planAlerts" in latest) restored.planAlerts = latest.planAlerts;
  return restored;
}

/**
 * The snapshot the Undo button would restore. It stays available until the student makes another change (that edit
 * drops it, so an Undo never erases a later edit) or the next applied / automatic re-plan stacks a newer one on top.
 * `_now` is kept for existing callers.
 */
export function undoableChange(state: Pick<AppState, "undoSnapshots">, _now?: Date): ReplanSnapshot | undefined {
  return state.undoSnapshots?.[0];
}

const RESTORED_INPUTS: Array<[keyof ReplanSnapshot, string]> = [
  ["recurringEvents", "your commitments"],
  ["classes", "your classes"],
  ["healthPrefs", "your sleep hours"],
  ["semester", "your semester dates"],
  ["userPrefs", "your study settings"],
];

/**
 * "Undo also puts your commitments back as they were." when undoing an AUTOMATIC re-plan also reverts the edit it
 * absorbed (see undoLastChange); null when Undo only restores the plan. An applied change the student previewed is
 * one step of its own and needs no such note.
 */
export function undoAlsoRestores(snapshot: ReplanSnapshot): string | null {
  if (snapshot.source !== "auto") return null;
  const parts: string[] = [];
  const edit = snapshot.taskEdit;
  if (edit) {
    const tasks = edit.count > 1 ? "tasks" : "task";
    parts.push(edit.kind === "added" ? `removes the ${tasks} you added` : edit.kind === "removed" ? `brings back the ${tasks} you deleted` : `puts the ${tasks} back as ${edit.count > 1 ? "they were" : "it was"}`);
  }
  const nouns = RESTORED_INPUTS.filter(([key]) => snapshot[key] !== undefined).map(([, noun]) => noun);
  if (nouns.length > 0) parts.push(`puts ${nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`} back as they were`);
  return parts.length > 0 ? `Undo also ${parts.join(" and ")}.` : null;
}



/** The plan alerts the latest plan leaves behind (see AppState.planAlerts). */
export function toPlanAlerts(shortfalls: TaskShortfall[], overdueTasks: OverdueTask[], now: Date): PlanAlerts {
  return { shortfalls, overdueTasks, computedAt: now.toISOString() };
}
