import { AppState, ScheduleBlock, Task } from "./types";
import { addDaysToKey, dateKeyOf, daysBetweenKeys, getDurationMinutes, getWeekStart, localDateKey, minutesToTime, parseLocalDate, timeToMinutes } from "./utils";
import { dueLabel } from "./plan-format";
import { generateWeekSchedule, stripLegacyBlocks } from "./scheduler";
import {
  convertToScheduleBlocks,
  DAILY_STUDY_CAP,
  farthestLeadDays,
  OverdueTask,
  plannedMinutesFor,
  scheduleTasksIntelligently,
  SESSION_GAP_MINUTES,
  sessionLengthFor,
  SharedBusy,
  TaskShortfall,
  URGENT_DAYS,
} from "./intelligent-scheduler";
import { blockMinutes, remainingMinutes } from "./task-progress";
import { buildBusyMap } from "./busy-windows";
import { busyCalendarEvents } from "./calendar-events";
import { getAwakeWindow, getPlanningWindow } from "./awake-window";
import { isClassDay } from "./semester";
import { MIN_SESSION_MINUTES } from "./session-chunks";
import { studyLoadCaps } from "./workload-analysis";
import { deadlinePassed, isAssessmentTask, taskDeadline } from "./task-kind";
import { examsPlannedByPrep, followExamDates, prepCredit, sizePrepsToExams } from "./exam-prep-link";

const GENERATED_BLOCK_TYPES = new Set(["sleep", "study", "buffer", "class", "recurring"]);

export interface WeekPlanOptions {
  /** Preserve confirmed user decisions while replacing generated schedule content. */
  preserveAccepted?: boolean;
  /** Retain explicitly locked custom commitments in every planning mode. */
  preserveLocked?: boolean;
  /** Clock injection (defaults to `new Date()`). */
  now?: Date;
}

export interface WeekPlanResult {
  scheduleBlocks: ScheduleBlock[];
  tasks: Task[];
  unscheduledTasks: Array<{ taskId: string; taskName: string; reason: string }>;
  /** Per-task minutes that could not be placed before the deadline (empty when everything fits). */
  shortfalls: TaskShortfall[];
  /** Tasks whose due date has passed; they were planned first (today / tomorrow). */
  overdueTasks: OverdueTask[];
  summary: string;
  /**
   * Accepted / dragged / locked study sessions this plan had to let go of because a change made them wrong (see
   * findInvalidPinnedSessions). Their minutes were planned again; the preview should list them as changes.
   */
  releasedSessions?: ReleasedSession[];
}

// ── Pinned sessions a change made wrong ───────────────────────

export type ReleaseReason = "after-deadline" | "conflict" | "task-closed";

export interface ReleasedSession {
  block: ScheduleBlock;
  reason: ReleaseReason;
  /** Plain sentence for the preview: "Now after Exam 2 (Mon 9 Nov)", "Clashes with Job shift". */
  detail: string;
}

/** A study session the student confirmed: accepted, dragged (userEdited) or locked, and still to do. */
function isPinnedStudy(block: ScheduleBlock): boolean {
  return block.type === "study" && Boolean(block.taskId) && block.completionStatus === "pending" && !block.startedAt &&
    Boolean(block.accepted || block.locked || block.userEdited);
}

const DAY_MINUTES = 24 * 60;
function blockSpan(block: Pick<ScheduleBlock, "startTime" | "endTime">): [number, number] {
  const start = timeToMinutes(block.startTime);
  const end = timeToMinutes(block.endTime);
  return [start, end > start ? end : DAY_MINUTES];
}

/**
 * Accepted, dragged or locked study sessions that a change has made WRONG. Keeping a confirmed session is right
 * until the world moves under it; then it must be released so its minutes are planned again:
 *  (a) it now lands after its task's deadline (the exam moved earlier; a time-less quiz/exam counts from the start of
 *      its class that day, lib/task-kind.ts taskDeadline). Catch-up sessions of overdue homework are kept; nothing
 *      after a quiz / exam that has already happened is;
 *  (b) it overlaps a class, a recurring commitment, one of the student's own events, a Google Calendar event or a
 *      session in progress, starts inside the sleep window, or overlaps another confirmed study session (the student's
 *      own edits and locked sessions win, then the earlier one). No-study zones are planner preferences, not
 *      commitments: a confirmed session in one is kept;
 *  (c) its task was deleted, finished or skipped.
 * Sessions that already ended, started ones and finished ones are history and never released.
 */
export function findInvalidPinnedSessions(
  state: Pick<PlannerState, "tasks" | "scheduleBlocks" | "classes" | "recurringEvents" | "healthPrefs" | "userPrefs"> & Partial<Pick<AppState, "googleCalendarEvents" | "deviceCalendarEvents" | "semester">>,
  now: Date,
  options: { dates?: ReadonlySet<string>; recurringEvents?: Array<{ title: string; startTime: string; endTime: string }> } = {},
): ReleasedSession[] {
  const todayKey = localDateKey(now);
  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const pinned = state.scheduleBlocks.filter((block) =>
    isPinnedStudy(block) && !isPastBlock(block, todayKey, nowHHMM) && (!options.dates || options.dates.has(block.date)));
  if (pinned.length === 0) return [];

  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const released = new Map<string, ReleasedSession>();
  const release = (block: ScheduleBlock, reason: ReleaseReason, detail: string) => {
    if (!released.has(block.id)) released.set(block.id, { block, reason, detail });
  };

  // (b) What the confirmed sessions may not overlap, per date: the source of truth for classes / recurring
  // commitments / Google events, plus the student's own one-off events (never structural blocks, never study).
  const recurringEvents = options.recurringEvents ?? state.recurringEvents ?? [];
  const dates = [...new Set(pinned.map((block) => block.date))].sort();
  const ownEvents = state.scheduleBlocks.filter((block) =>
    block.type !== "study" && block.type !== "sleep" && block.type !== "buffer" && !isRegeneratedStructural(block, recurringEvents));
  const busy = buildBusyMap(dates, {
    classes: state.classes,
    recurringEvents: state.recurringEvents ?? [],
    scheduleBlocks: ownEvents,
    googleCalendarEvents: busyCalendarEvents(state),
    noGoZones: [],
    isClassDay: state.semester ? (date) => isClassDay(state.semester, date) : undefined,
  }, { labels: true });
  const awake = getAwakeWindow(state.healthPrefs.wakeTime, state.healthPrefs.bedtime);

  // Started (in progress) study blocks are fixed too.
  const inProgress = state.scheduleBlocks.filter((block) => block.type === "study" && block.startedAt && block.completionStatus === "pending");

  for (const block of pinned) {
    const task = block.taskId ? tasksById.get(block.taskId) : undefined;
    // (c)
    if (!task || task.status === "done" || task.status === "skipped") {
      release(block, "task-closed", !task ? "Its task was removed" : task.status === "done" ? `${task.name} is done` : `${task.name} was skipped`);
      continue;
    }
    // (a)
    const deadline = taskDeadline(task, state.classes, state.semester);
    const [start, end] = blockSpan(block);
    if (/^\d{4}-\d{2}-\d{2}$/.test(deadline.dueKey)) {
      const after = block.date > deadline.dueKey || (block.date === deadline.dueKey && deadline.cutoffMinutes !== undefined && end > deadline.cutoffMinutes);
      const passed = deadlinePassed(deadline, todayKey, nowMinutes);
      if (after && (!passed || isAssessmentTask(task))) {
        release(block, "after-deadline", passed ? `${task.name} has already taken place` : `Now after the ${task.name} deadline (${dueLabel(deadline.dueKey, todayKey)})`);
        continue;
      }
    }
    // (b) sleep: a session that STARTS while the student sleeps (a late finish chosen with "Fix my day - crunch" is
    // the student's call and stays).
    // With a bedtime after midnight (01:00) the first hour of the date is still the previous evening, not sleep.
    const asleep = awake.crossesMidnight
      ? start >= awake.bedMinutes - DAY_MINUTES && start < awake.wakeMinutes
      : start < awake.wakeMinutes || start >= awake.bedMinutes;
    if (asleep) {
      release(block, "conflict", "Falls in your sleep window");
      continue;
    }
    const clash = (busy[block.date] ?? []).find((interval) => start < interval.endMinutes && interval.startMinutes < end);
    if (clash) {
      release(block, "conflict", `Clashes with ${clash.label ?? "a commitment"}`);
      continue;
    }
    const other = inProgress.find((b) => b.date === block.date && b.id !== block.id && start < blockSpan(b)[1] && blockSpan(b)[0] < end);
    if (other) release(block, "conflict", `Overlaps ${other.title}`);
  }

  // (b) confirmed sessions overlapping each other: the student's own edits and locked ones win, then the earlier one.
  const rank = (block: ScheduleBlock) => (block.locked ? 0 : block.userEdited ? 1 : 2);
  const survivors = pinned
    .filter((block) => !released.has(block.id))
    .sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  const keptByDate = new Map<string, ScheduleBlock[]>();
  for (const block of survivors) {
    const [start, end] = blockSpan(block);
    const kept = keptByDate.get(block.date) ?? [];
    const other = kept.find((b) => start < blockSpan(b)[1] && blockSpan(b)[0] < end);
    if (other) release(block, "conflict", `Overlaps ${other.title}`);
    else keptByDate.set(block.date, [...kept, block]);
  }

  return [...released.values()].sort((a, b) => a.block.date.localeCompare(b.block.date) || a.block.startTime.localeCompare(b.block.startTime) || a.block.id.localeCompare(b.block.id));
}

/** What the planner reads from the app state. `semester` restricts class meetings to its dates. */
export type PlannerState = Pick<AppState, "classes" | "recurringEvents" | "tasks" | "scheduleBlocks" | "healthPrefs" | "userPrefs">
  & Partial<Pick<AppState, "googleCalendarEvents" | "deviceCalendarEvents" | "semester">>;

/** Find the next conflict-free time later on the same day for an existing block. */
export function findPushedBlock(
  block: ScheduleBlock,
  allBlocks: ScheduleBlock[],
  minutesToPush = 30,
): ScheduleBlock | null {
  const duration = getDurationMinutes(block.startTime, block.endTime);
  let candidateStart = getDurationMinutes("00:00", block.startTime) + minutesToPush;
  const sleepBlock = allBlocks.find((candidate) => candidate.id !== block.id && candidate.date === block.date && candidate.type === "sleep");
  // A sleep block that starts before midnight ends the usable day 30 min earlier. A sleep block that
  // starts after midnight (bedtime "00:30") leaves the whole evening open.
  const sleepStart = sleepBlock ? timeToMinutes(sleepBlock.startTime) : null;
  const sleepEnd = sleepBlock ? timeToMinutes(sleepBlock.endTime) : null;
  const latestEnd = sleepStart !== null && sleepEnd !== null && sleepStart > sleepEnd
    ? sleepStart - 30
    : 23 * 60 + 45;
  const blockers = allBlocks
    .filter((other) => other.id !== block.id && other.date === block.date && other.startTime < other.endTime)
    .sort((first, second) => first.startTime.localeCompare(second.startTime));

  for (let attempts = 0; attempts < 32; attempts += 1) {
    const candidateEnd = candidateStart + duration;
    if (candidateEnd > latestEnd) return null;
    const collision = blockers.find((other) => (
      getDurationMinutes("00:00", other.startTime) < candidateEnd &&
      getDurationMinutes("00:00", other.endTime) > candidateStart
    ));
    if (!collision) {
      const startTime = `${String(Math.floor(candidateStart / 60)).padStart(2, "0")}:${String(candidateStart % 60).padStart(2, "0")}`;
      const endTime = `${String(Math.floor(candidateEnd / 60)).padStart(2, "0")}:${String(candidateEnd % 60).padStart(2, "0")}`;
      return { ...block, startTime, endTime, accepted: true, userEdited: true, schedulingReason: "Moved later at your request while preserving conflicts." };
    }
    candidateStart = getDurationMinutes("00:00", collision.endTime) + 10;
  }
  return null;
}

function getWeekDates(weekStart: Date): string[] {
  const first = localDateKey(weekStart);
  return Array.from({ length: 7 }, (_, index) => addDaysToKey(first, index));
}

function overlaps(first: ScheduleBlock, second: ScheduleBlock): boolean {
  return first.date === second.date && first.startTime < second.endTime && second.startTime < first.endTime;
}

/**
 * Structural blocks (sleep, class meetings, post-class transitions and recurring commitments) are rebuilt
 * from the source of truth on every plan. A user-made block of the same type (e.g. an "Other" commitment
 * added by hand) is not structural.
 */
export function isRegeneratedStructural(block: ScheduleBlock, recurringEvents: Array<{ title: string; startTime: string; endTime: string }>): boolean {
  switch (block.type) {
    case "sleep":
    case "class":
      return true;
    case "buffer":
      return block.title === "Transition";
    case "recurring":
      return block.id.startsWith("recurring-") || recurringEvents.some((event) => event.title === block.title && event.startTime === block.startTime && event.endTime === block.endTime);
    default:
      return false;
  }
}

type PreserveOptions = Required<Omit<WeekPlanOptions, "now">>;

/**
 * Blocks that re-planning must never touch or regenerate:
 *  - history: finished, skipped and missed blocks (the Today list shows them as "Skipped" / "Missed"; they never
 *    count as coverage or load), and blocks the user already started,
 *  - locked custom commitments (when `preserveLocked`),
 *  - blocks the user accepted or edited (when `preserveAccepted`), except structural
 *    ones which are safely rebuilt from the source of truth.
 * Everything else (untouched suggestions) is regenerated.
 */
export function isPreserved(block: ScheduleBlock, options: PreserveOptions, structural: boolean): boolean {
  if (block.completionStatus === "done" || block.completionStatus === "skipped" || block.completionStatus === "missed" || block.startedAt) return true;
  if (structural) return false;
  if (options.preserveLocked && block.locked) return true;
  if (!options.preserveAccepted) return false;
  return block.accepted || Boolean(block.userEdited);
}

function sameSlot(first: ScheduleBlock, second: ScheduleBlock): boolean {
  return first.type === second.type && first.date === second.date && first.startTime === second.startTime && first.endTime === second.endTime && first.title === second.title;
}

/** Give a block an id that no block in `taken` uses (deterministic suffix), and remember it. */
function claimUniqueId(block: ScheduleBlock, taken: Pick<Set<string>, "has" | "add">): ScheduleBlock {
  let id = block.id;
  for (let n = 2; taken.has(id); n += 1) id = `${block.id}-${n}`;
  taken.add(id);
  return id === block.id ? block : { ...block, id };
}

function byDate(blocks: ScheduleBlock[]): Map<string, ScheduleBlock[]> {
  const map = new Map<string, ScheduleBlock[]>();
  for (const block of blocks) {
    const list = map.get(block.date);
    if (list) list.push(block);
    else map.set(block.date, [block]);
  }
  return map;
}

/** True when the block's end has already passed at `now` (its date is earlier today or before). */
function isPastBlock(block: ScheduleBlock, todayKey: string, nowHHMM: string): boolean {
  return block.date < todayKey || (block.date === todayKey && block.endTime <= nowHHMM);
}

export interface PlanWindowOptions extends PreserveOptions {
  /** Mondays ("YYYY-MM-DD") of the weeks to (re)plan: contiguous and ascending. */
  weekStartKeys: string[];
  now: Date;
  /**
   * Whole-semester mode: generated blocks after the window that are not preserved are dropped (they belong to a
   * horizon that has since shrunk), and pending sessions whose time has already passed no longer count as
   * covering their task (unfinished work is planned again instead of being "covered" by the past).
   */
  fullHorizon?: boolean;
  /** Longest solver window in days (default: the solver's own 16-week cap). */
  maxHorizonDays?: number;
  /** Dates on which no new study may be placed (see SchedulingOptions.blockedDates). */
  blockedDates?: string[];
  /**
   * Stable re-plan (the automatic one after a new day, a finished session or an edit): every upcoming study
   * suggestion that is still valid stays exactly where it is and only the difference is solved (see keptSuggestions).
   * Without it every unconfirmed suggestion is placed again from scratch (an explicit Replan / Rebuild).
   */
  keepSuggestions?: boolean;
  /** With keepSuggestions: tasks a change touched (new date, estimate...). Their suggestions are planned again, not kept. */
  replanTaskIds?: ReadonlySet<string>;
  /**
   * With keepSuggestions: never let go of a still-valid suggestion to make room, only the ones the change made wrong
   * are planned again and what does not fit is reported short (a Google Calendar sync, which offers no Undo).
   */
  keepAllValid?: boolean;
}

/**
 * Plan every week in `weekStartKeys` with ONE solver pass.
 *
 * Structural blocks (sleep, classes, recurring commitments) are regenerated for each week, user decisions are
 * preserved (see `isPreserved`), and every solved study session inside the window is kept. Blocks outside the
 * window are left as they are. Regenerating is stable: running it twice on its own output changes nothing.
 *
 * With `keepSuggestions` the still-valid upcoming suggestions are kept too and only the difference is solved. When
 * that leaves work without room, the suggestions on the days that work could use are let go (the last few days
 * before its deadline, then more, then every session of the tasks competing for them) with the short tasks picking
 * first, or everything is solved afresh (see worthwhileChange). A change is only taken when it is worth the sessions
 * it moves (worthTheMoves): a few minutes are never worth reshuffling the semester, and a bigger reshuffle is left to
 * the student's "Re-plan semester" (previewed, with Undo) while the shortfall stays visible in the plan alerts.
 *
 * Idempotent: the plan returned is one where the next re-plan stops. After a change (or when the stable plan placed
 * something new) it is planned again from that result, with ITS suggestions kept, until nothing more is worth moving
 * and solving changes nothing; running this again on its own result then repeats that last round exactly.
 *
 * After an edit that leaves a task it added or changed well short of what a plan made from scratch gives it, the
 * suggestions it needs give way first (roomForEdits), at a cost relaxed for that edit; a new day keeps the strict one.
 */
export function planWindow(state: PlannerState, options: PlanWindowOptions): WeekPlanResult {
  // Exam prep study time takes its exam's CURRENT date and time (the exam may have moved) and at least the exam's own
  // estimate: an exam with a prep is planned only through it (lib/exam-prep-link.ts).
  state = { ...state, tasks: sizePrepsToExams(followExamDates(state.tasks), sessionLengthFor(state.userPrefs)) };
  const context = windowContext(state, options);
  if (!options.keepSuggestions) return solveWindow(state, options, context, []);
  let pins = keptSuggestions(state, options, context);
  let plan = solveWindow(state, options, context, pins);
  if (totalMissing(plan) === 0 || options.keepAllValid) return plan;
  // What a plan starting over fits: no change can beat it by much (it does not depend on the kept suggestions).
  const fresh = solveWindow(state, options, context, []);
  // The next re-plan has no edit left to absorb: from the second round on, every valid suggestion is kept.
  const settle: PlanWindowOptions = { ...options, replanTaskIds: undefined };
  let current: PlannerState = state;
  let currentContext = context;
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    const change = (round === 0 ? roomForEdits(current, options, currentContext, pins, plan, fresh) : null) ??
      worthwhileChange(current, round === 0 ? options : settle, currentContext, pins, plan, fresh);
    if (!change && sameBlocks(plan.scheduleBlocks, current.scheduleBlocks)) break;
    const next = change ?? plan;
    current = { ...state, scheduleBlocks: next.scheduleBlocks, tasks: next.tasks };
    currentContext = windowContext(current, settle);
    pins = keptSuggestions(current, settle, currentContext);
    plan = solveWindow(current, settle, currentContext, pins);
    if (totalMissing(plan) === 0) break;
    // A round that took no change and whose result solves to itself is where the plan settles: weighing the changes
    // again from it (found none in all 183 such rounds of the test suite) was a quarter of the solves of the slowest
    // automatic re-plans (1.0.9 audit: 3x slower than 1.0.8).
    if (!change && sameBlocks(plan.scheduleBlocks, current.scheduleBlocks)) break;
  }
  // What this re-plan released is measured against the student's plan, not the intermediate rounds.
  return currentContext === context ? plan : { ...plan, releasedSessions: context.releasedSessions };
}

/** Rounds of "plan again from the result" before the latest one is returned as it is (one or two in practice). */
const MAX_SETTLE_ROUNDS = 4;

/** How much shorter than in a plan made from scratch a task an edit added or changed may stay before room is made for it. */
export const EDIT_GAP_MINUTES = 30;

/**
 * Room for the tasks an edit added or changed (replanTaskIds) that the stable plan leaves more than EDIT_GAP_MINUTES
 * shorter than a plan made from scratch does (1.0.9 audit: an 8-hour assignment due in 5 days, every day before it
 * holding 4 sessions, got 80 of its 480 minutes; the fresh plan all of them, moving 71 suggestions). The kept
 * suggestions on the days it can use give way least urgent first (latest deadline, then nearest its deadline), only as
 * many as it needs with it placed first, and every one it does not need then goes back to its slot. Confirmed, started
 * and moved sessions never give way, and the work that gave way is planned again before its own deadline (or reported
 * short, never placed late). A cost relaxed for the edit the student just made: taken when the tasks behind win back
 * MINUTES_PER_MOVE per move, at any number of moves, and the plan as a whole ends at most EDIT_GAP_MINUTES shorter; null
 * otherwise. The automatic re-plan of a new day never comes here (worthTheMoves stays its rule).
 */
function roomForEdits(state: PlannerState, options: PlanWindowOptions, context: WindowContext, pins: ScheduleBlock[], stable: WeekPlanResult, fresh: WeekPlanResult): WeekPlanResult | null {
  const edited = options.replanTaskIds;
  if (!edited || edited.size === 0) return null;
  const shortBy = (plan: WeekPlanResult, taskId: string) => plan.shortfalls.find((shortfall) => shortfall.taskId === taskId)?.missingMinutes ?? 0;
  const behind = stable.shortfalls.filter((shortfall) => edited.has(shortfall.taskId) && /^\d{4}-\d{2}-\d{2}$/.test(shortfall.dueDate) &&
    shortfall.missingMinutes - shortBy(fresh, shortfall.taskId) > EDIT_GAP_MINUTES);
  if (behind.length === 0) return null;
  const caughtUp = (plan: WeekPlanResult) => behind.every((shortfall) => shortBy(plan, shortfall.taskId) - shortBy(fresh, shortfall.taskId) <= EDIT_GAP_MINUTES);
  const first = new Set(behind.map((shortfall) => shortfall.taskId));
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const dueOf = (block: ScheduleBlock) => dateKeyOf(tasksById.get(block.taskId!)?.dueDate ?? "");
  // The days each task behind can use: from today (or the day it was deferred to) to its deadline, or the two
  // catch-up days of overdue work.
  const ranges = behind.map((shortfall) => {
    const notBefore = tasksById.get(shortfall.taskId)?.notBeforeDate?.slice(0, 10) ?? "";
    const from = notBefore > context.todayKey ? notBefore : context.todayKey;
    return { from, to: shortfall.overdue ? addDaysToKey(from, 1) : shortfall.dueDate };
  });
  const candidates = pins
    .filter((pin) => ranges.some((range) => pin.date >= range.from && pin.date <= range.to))
    .sort((a, b) => dueOf(b).localeCompare(dueOf(a)) || b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime) || b.id.localeCompare(a.id));
  if (candidates.length === 0) return null;
  const without = (count: number) => {
    const freed = new Set(candidates.slice(0, count).map((pin) => pin.id));
    return pins.filter((pin) => !freed.has(pin.id));
  };
  // The fewest that catch every task behind up (all of them when nothing does), found by halving.
  let count = candidates.length;
  let made = solveWindow(state, options, context, without(count), first);
  if (caughtUp(made)) {
    let low = 1;
    while (low < count) {
      const mid = Math.floor((low + count) / 2);
      const attempt = solveWindow(state, options, context, without(mid), first);
      if (caughtUp(attempt)) {
        count = mid;
        made = attempt;
      } else {
        low = mid + 1;
      }
    }
  }
  const kept = without(count);
  const keptIds = new Set(kept.map((pin) => pin.id));
  const back = solveWindow(state, options, context, putBack(state, context, kept, pins.filter((pin) => !keptIds.has(pin.id)), made, first), first);
  const moves = (plan: WeekPlanResult) => movedSuggestions(pins, plan);
  const pick = totalMissing(back) <= totalMissing(made) && moves(back) <= moves(made) ? back : made;
  const won = behind.reduce((sum, shortfall) => sum + shortfall.missingMinutes - shortBy(pick, shortfall.taskId), 0);
  return won > 0 && won >= MINUTES_PER_MOVE * moves(pick) && totalMissing(pick) <= totalMissing(stable) + EDIT_GAP_MINUTES ? pick : null;
}

/** True when two calendars hold the same blocks (same ids, slots, titles and states), in any order. */
function sameBlocks(first: readonly ScheduleBlock[], second: readonly ScheduleBlock[]): boolean {
  if (first.length !== second.length) return false;
  const key = (block: ScheduleBlock) => `${block.id}|${block.type}|${block.date}|${block.startTime}|${block.endTime}|${block.title}|${block.completionStatus}|${block.taskId ?? ""}|${block.accepted ? 1 : 0}`;
  const a = first.map(key).sort();
  const b = second.map(key).sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * The best change of `stable` (which keeps `pins`) worth the sessions it moves, or null: partial re-solves that let go
 * of the kept suggestions on the days the short tasks could use (a few days before their deadlines, then more, then
 * every session of the tasks competing for them), with the short tasks placed first, and the fresh plan. The best is
 * the one that wins back the most minutes net of MINUTES_PER_MOVE per move (then the fewest moves).
 */
function worthwhileChange(state: PlannerState, options: PlanWindowOptions, context: WindowContext, pins: ScheduleBlock[], stable: WeekPlanResult, fresh: WeekPlanResult): WeekPlanResult | null {
  // Not even a fresh plan fits meaningfully more: keep the student's plan as it is.
  if (!fitsMeaningfullyMore(fresh, stable, context)) return null;
  const worth: Array<{ plan: WeekPlanResult; value: number; moves: number }> = [];
  const consider = (plan: WeekPlanResult) => {
    const moves = movedSuggestions(pins, plan);
    if (worthTheMoves(plan, stable, moves, context)) worth.push({ plan, value: totalMissing(stable) - totalMissing(plan) - MINUTES_PER_MOVE * moves, moves });
  };

  let pressing = stable.shortfalls.filter((shortfall) => shortfall.missingMinutes > 0);
  const short = new Set(pressing.map((shortfall) => shortfall.taskId));
  let tried = "";
  for (const release of [3, 10, "tasks"] as const) {
    // Each reach is tried once, and once more when its re-solve left a let-go session without room: that session's
    // task competes for the same days, so the retry also frees the days before its deadline and places it first.
    for (let retry = 0; retry < 2; retry += 1) {
      const freed = freedSuggestions(state, pressing, pins, context.todayKey, release);
      // The freed set only grows (wider reach, more pressing tasks): the same size and first tasks is the same attempt.
      const attempt = `${freed.size}/${short.size}`;
      if (attempt === tried) break;
      tried = attempt;
      const kept = pins.filter((pin) => !freed.has(pin.id));
      const partial = solveWindow(state, options, context, kept, short);
      consider(partial);
      // The same room for the short tasks, with every let-go suggestion their new sessions do not need put back (when
      // there is nothing to put back and nothing new to keep, that is the same solve again).
      const backPins = putBack(state, context, kept, pins.filter((pin) => freed.has(pin.id)), partial, short);
      const puttingBack = backPins.length === kept.length ? partial : solveWindow(state, options, context, backPins, short);
      consider(puttingBack);
      const bumped = [...partial.shortfalls, ...puttingBack.shortfalls]
        .filter((shortfall, index, all) => shortfall.missingMinutes > 0 && !short.has(shortfall.taskId) && all.findIndex((other) => other.taskId === shortfall.taskId) === index);
      if (bumped.length === 0) break;
      pressing = [...pressing, ...bumped];
      for (const shortfall of bumped) short.add(shortfall.taskId);
    }
  }
  consider(fresh);
  // A stable sort: on a full tie the narrower re-solve (tried first) wins.
  return worth.sort((a, b) => b.value - a.value || a.moves - b.moves)[0]?.plan ?? null;
}

const totalMissing = (plan: Pick<WeekPlanResult, "shortfalls">) => plan.shortfalls.reduce((sum, shortfall) => sum + shortfall.missingMinutes, 0);

/** Minutes a plan that lets go of more of the current one must win back before it is worth the reshuffle. */
export const MEANINGFUL_GAIN_MINUTES = 30;
/** ...plus this many minutes for every kept suggestion it moves or removes. */
export const MINUTES_PER_MOVE = 10;
/** Most kept suggestions an automatic re-plan moves to fit more work; a bigger reshuffle is the student's "Re-plan semester". */
export const MAX_AUTOMATIC_MOVES = 8;
/** Moves a task that had no time at all is worth on its own (per such task), whatever the minutes. */
const MOVES_PER_FIRST_TIME = 3;

const slotOf = (block: Pick<ScheduleBlock, "taskId" | "date" | "startTime" | "endTime">) => `${block.taskId}|${block.date}|${block.startTime}|${block.endTime}`;

/** Kept suggestions (`pins`) that `plan` does not keep in their slot: what the student would see moved or removed. */
function movedSuggestions(pins: readonly ScheduleBlock[], plan: WeekPlanResult): number {
  const slots = new Map<string, number>();
  for (const block of plan.scheduleBlocks) {
    if (block.type === "study" && block.taskId && block.completionStatus === "pending") slots.set(slotOf(block), (slots.get(slotOf(block)) ?? 0) + 1);
  }
  let moved = 0;
  for (const pin of pins) {
    const left = slots.get(slotOf(pin)) ?? 0;
    if (left > 0) slots.set(slotOf(pin), left - 1);
    else moved += 1;
  }
  return moved;
}

/**
 * True when `plan`, which moves `moves` of the kept suggestions, is worth it against `base`: every move costs
 * MINUTES_PER_MOVE more minutes of work it must fit (1.0.8 audit: the fresh fallback moved 45 sessions one morning, with
 * the number of moves never part of the decision), or it gives tasks that had no time at all their first minutes for
 * at most MOVES_PER_FIRST_TIME moves each. Never more than MAX_AUTOMATIC_MOVES moves, never more minutes short.
 */
function worthTheMoves(plan: WeekPlanResult, base: WeekPlanResult, moves: number, context: Pick<WindowContext, "todayKey" | "nowHHMM">): boolean {
  const gain = totalMissing(base) - totalMissing(plan);
  if (moves > MAX_AUTOMATIC_MOVES || gain <= 0) return false;
  if (gain >= MEANINGFUL_GAIN_MINUTES + MINUTES_PER_MOVE * moves) return true;
  const firsts = unplannedTasks(base, context) - unplannedTasks(plan, context);
  return firsts > 0 && moves <= MOVES_PER_FIRST_TIME * firsts;
}

/** Tasks short of time that have no session left to do in `plan` at all: none of their work is planned. */
function unplannedTasks(plan: WeekPlanResult, context: Pick<WindowContext, "todayKey" | "nowHHMM">): number {
  const short = new Set(plan.shortfalls.filter((shortfall) => shortfall.missingMinutes > 0).map((shortfall) => shortfall.taskId));
  if (short.size === 0) return 0;
  for (const block of plan.scheduleBlocks) {
    if (block.type === "study" && block.taskId && block.completionStatus === "pending" && !isPastBlock(block, context.todayKey, context.nowHHMM)) short.delete(block.taskId);
  }
  return short.size;
}

/**
 * True when `candidate` (which lets go of more of the student's plan) fits meaningfully more than `base`: at least
 * MEANINGFUL_GAIN_MINUTES less work left without room, or fewer tasks left with no time planned at all, and never
 * more minutes short. Otherwise the gain is not worth moving the sessions the student already has.
 */
function fitsMeaningfullyMore(candidate: WeekPlanResult, base: WeekPlanResult, context: Pick<WindowContext, "todayKey" | "nowHHMM">): boolean {
  const gain = totalMissing(base) - totalMissing(candidate);
  return gain >= MEANINGFUL_GAIN_MINUTES || (gain > 0 && unplannedTasks(candidate, context) < unplannedTasks(base, context));
}

/** What every solve of one window shares: the blocks it keeps, the structure it regenerates, the released pins. */
interface WindowContext {
  todayKey: string;
  nowHHMM: string;
  windowSet: Set<string>;
  recurringEvents: PlannerState["recurringEvents"];
  releasedSessions: ReleasedSession[];
  releasedIds: Set<string>;
  inWindow: ScheduleBlock[];
  preservedInWindow: ScheduleBlock[];
  outsideWindow: ScheduleBlock[];
  structuralBlocks: ScheduleBlock[];
  blockedDates: string[];
  /** Exams (and older preps) planned only through an exam prep, mapped to the prep's task id (examsPlannedByPrep). */
  plannedBy: Map<string, string>;
  /** Minutes exams whose prep is finished already had through it, counted as covered (lib/exam-prep-link.ts prepCredit). */
  prepCredit: Map<string, number>;
  /**
   * Dates holding a study session the student moved there or locked: their suggestions give way while the day is over
   * the daily cap (keptSuggestions), and the solver never takes such a day past the cap (SchedulingOptions.cappedDates).
   */
  movedDates: Set<string>;
  /** What every solve of this window shares, filled in by the first one (solveBase). */
  solveBase?: SolveBase;
}

function windowContext(state: PlannerState, options: PlanWindowOptions): WindowContext {
  const { now, weekStartKeys } = options;
  const todayKey = localDateKey(now);
  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const windowDates = weekStartKeys.flatMap((key) => Array.from({ length: 7 }, (_, index) => addDaysToKey(key, index)));
  const windowSet = new Set(windowDates);
  const windowEnd = windowDates[windowDates.length - 1] ?? "";
  const preserveOptions: PreserveOptions = { preserveAccepted: options.preserveAccepted, preserveLocked: options.preserveLocked };
  const recurringEvents = state.recurringEvents ?? [];

  // Confirmed sessions a change has made wrong (after a moved deadline, under a new commitment, of a closed task) are
  // released: they lose their pin, so they are regenerated like any suggestion and their minutes are planned again.
  const releasedSessions = findInvalidPinnedSessions(state, now, { dates: windowSet, recurringEvents });
  const releasedIds = new Set(releasedSessions.map((released) => released.block.id));
  // Meal / workout blocks from older app versions are dropped for good.
  const currentBlocks = stripLegacyBlocks(state.scheduleBlocks).map((block) => (
    releasedIds.has(block.id) ? { ...block, accepted: false, locked: false, userEdited: false } : block
  ));
  const inWindow = currentBlocks.filter((block) => windowSet.has(block.date));
  // A recurring commitment is drawn from today on: what is on the calendar for earlier days stays as it was (history),
  // so a commitment added mid-week is never drawn back over sessions the student already did.
  const pastCommitment = (block: ScheduleBlock) => block.type === "recurring" && block.date < todayKey && isRegeneratedStructural(block, recurringEvents);
  const preservedInWindow = inWindow.filter((block) => pastCommitment(block) || isPreserved(block, preserveOptions, isRegeneratedStructural(block, recurringEvents)));
  const outsideWindow = currentBlocks.filter((block) => {
    if (windowSet.has(block.date)) return false;
    // Generated content beyond a horizon that no longer reaches it is stale.
    if (options.fullHorizon && block.date > windowEnd) return isPreserved(block, preserveOptions, isRegeneratedStructural(block, recurringEvents));
    return true;
  });

  const structuralBlocks = weekStartKeys.flatMap((key) => generateWeekSchedule(
    {
      classes: state.classes,
      recurringEvents,
      healthPrefs: state.healthPrefs,
      userPrefs: state.userPrefs,
      semester: state.semester,
    },
    parseLocalDate(key),
    now,
  )).filter((block) => !(block.type === "recurring" && block.date < todayKey));

  // Days the student deferred ("Move to tomorrow" / "Defer this day") stay free of new study in every later plan, not
  // just the one the deferral previewed (the automatic re-plan 1.5 s later used to put other work back on that day).
  const blockedDates = [...new Set([
    ...(options.blockedDates ?? []),
    ...currentBlocks.filter((block) => block.deferredDay && block.completionStatus === "skipped" && block.date >= todayKey).map((block) => block.date),
  ])];
  const plannedBy = examsPlannedByPrep(state.tasks);
  const movedDates = new Set(preservedInWindow.filter((block) => countsAsLoad(block) && block.completionStatus === "pending" && (block.userEdited || block.locked)).map((block) => block.date));
  return {
    todayKey, nowHHMM, windowSet, recurringEvents, releasedSessions, releasedIds, inWindow, preservedInWindow, outsideWindow, structuralBlocks, blockedDates,
    plannedBy, prepCredit: prepCredit(state.tasks), movedDates,
  };
}

/**
 * What every solve of one window shares, worked out once for its context (the slowest re-plans solve it 15-27 times;
 * 1.0.9 audit: automatic re-plans 3x slower than 1.0.8): the busy windows, covered minutes, ids and regenerated
 * structure of the blocks that stay. Each solve adds its soft pins on top, so the result is the same as without it.
 */
interface SolveBase {
  /** Blocks the solver reads besides the soft pins: everything outside the window and what is preserved inside it. */
  scheduleBlocks: ScheduleBlock[];
  /** Busy windows of the structure and the preserved blocks. */
  fixedWindows: Array<{ date: string; startTime: string; endTime: string }>;
  /** Minutes (and sessions) the confirmed and preserved study blocks cover, per task. */
  coveredMinutes: Map<string, number>;
  coveredSessions: Map<string, Array<{ label?: string; minutes: number }>>;
  preservedByDate: Map<string, ScheduleBlock[]>;
  /** Structural blocks no preserved block replaces. */
  structural: ScheduleBlock[];
  takenIds: Set<string>;
  /** The busy time of `scheduleBlocks` and `fixedWindows`, built by the first solve (SchedulingOptions.sharedBusy). */
  sharedBusy: SharedBusy;
}

function solveBase(options: PlanWindowOptions, context: WindowContext): SolveBase {
  if (context.solveBase) return context.solveBase;
  const { todayKey, nowHHMM, outsideWindow, preservedInWindow, structuralBlocks } = context;
  const coveredMinutes = new Map<string, number>();
  const coveredSessions = new Map<string, Array<{ label?: string; minutes: number }>>();
  for (const block of [...outsideWindow.filter((b) => b.accepted), ...preservedInWindow]) {
    if (block.type !== "study" || !block.taskId || block.completionStatus !== "pending") continue;
    if (options.fullHorizon && isPastBlock(block, todayKey, nowHHMM)) continue;
    const taskId = context.plannedBy.get(block.taskId) ?? block.taskId;
    coveredMinutes.set(taskId, (coveredMinutes.get(taskId) ?? 0) + blockMinutes(block));
    coveredSessions.set(taskId, [...(coveredSessions.get(taskId) ?? []), { label: block.strategyLabel, minutes: blockMinutes(block) }]);
  }
  const preservedByDate = byDate(preservedInWindow);
  const scheduleBlocks = [...outsideWindow, ...preservedInWindow];
  const fixedWindows = [...structuralBlocks, ...preservedInWindow]
    .filter((block) => block.type !== "sleep" && block.startTime < block.endTime)
    .map((block) => ({ date: block.date, startTime: block.startTime, endTime: block.endTime }));
  context.solveBase = {
    scheduleBlocks,
    fixedWindows,
    coveredMinutes,
    coveredSessions,
    preservedByDate,
    structural: structuralBlocks.filter((candidate) => keepsGenerated(candidate, preservedByDate.get(candidate.date) ?? [])),
    takenIds: new Set(scheduleBlocks.map((block) => block.id)),
    sharedBusy: { blocks: scheduleBlocks.length, extra: fixedWindows.length },
  };
  return context.solveBase;
}

/**
 * A regenerated block (structure, or a solved session) that the blocks kept on its day (`sameDay`) do not replace: a
 * preserved structural block (e.g. a completed class) wins over its regenerated twin, and nothing but a class or
 * commitment is drawn over a kept block. A regenerated study session that merely shares an id with a preserved one is
 * a different session: it gets a unique id.
 */
function keepsGenerated(candidate: ScheduleBlock, sameDay: readonly ScheduleBlock[]): boolean {
  if (candidate.type !== "study" && sameDay.some((preserved) => preserved.id === candidate.id || sameSlot(candidate, preserved))) return false;
  if (candidate.type === "class" || candidate.type === "recurring") return true;
  return !sameDay.some((preserved) => overlaps(candidate, preserved));
}

/**
 * One solver pass over the window. `softPins` (see keptSuggestions) stay exactly where they are, like preserved
 * blocks; `firstTaskIds` are placed before every other task.
 */
function solveWindow(state: PlannerState, options: PlanWindowOptions, context: WindowContext, softPins: ScheduleBlock[], firstTaskIds?: ReadonlySet<string>): WeekPlanResult {
  const { now, weekStartKeys } = options;
  const { todayKey, nowHHMM, windowSet, recurringEvents, outsideWindow, preservedInWindow } = context;
  const base = solveBase(options, context);
  const keptInWindow = softPins.length > 0 ? [...preservedInWindow, ...softPins] : preservedInWindow;

  // A kept suggestion keeps the short break the solver leaves after every session it places.
  const fixedWindows = base.fixedWindows.concat(softPins
    .filter((block) => block.type !== "sleep" && block.startTime < block.endTime)
    .map((block) => ({ date: block.date, startTime: block.startTime, endTime: withSessionGap(block.endTime) })));

  // Minutes already covered by sessions that will still be on the calendar after this plan. An exam's confirmed or
  // started sessions cover its prep's plan: the exam is planned only through the prep (lib/exam-prep-link.ts). Once its
  // prep is finished, what the prep's sessions did counts toward the exam like progress (prepCredit).
  const coveredMinutes: Record<string, number> = Object.fromEntries(base.coveredMinutes);
  const coveredSessions: Record<string, Array<{ label?: string; minutes: number }>> = {};
  for (const [taskId, sessions] of base.coveredSessions) coveredSessions[taskId] = [...sessions];
  for (const block of softPins) {
    if (block.type !== "study" || !block.taskId || block.completionStatus !== "pending") continue;
    if (options.fullHorizon && isPastBlock(block, todayKey, nowHHMM)) continue;
    const taskId = context.plannedBy.get(block.taskId) ?? block.taskId;
    coveredMinutes[taskId] = (coveredMinutes[taskId] ?? 0) + blockMinutes(block);
    (coveredSessions[taskId] ??= []).push({ label: block.strategyLabel, minutes: blockMinutes(block) });
  }
  for (const [taskId, minutes] of context.prepCredit) {
    coveredMinutes[taskId] = (coveredMinutes[taskId] ?? 0) + minutes;
    (coveredSessions[taskId] ??= []).push({ minutes });
  }
  // An exam planned through its prep gets no sessions of its own; once it has taken place it is still handed to the
  // solver, which plans nothing for it and reports it as a missed assessment (mark it done or skipped).
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const throughPrep = (task: Task) => context.plannedBy.has(task.id) &&
    !(isAssessmentTask(task) && deadlinePassed(taskDeadline(task, state.classes, state.semester), todayKey, nowMinutes));
  const pendingTasks = state.tasks.filter((task) => (task.status === "pending" || task.status === "scheduled") && !throughPrep(task));
  const solver = scheduleTasksIntelligently(
    pendingTasks,
    {
      classes: state.classes,
      recurringEvents,
      // Kept suggestions busy their time and count toward each day's / week's load like confirmed sessions.
      scheduleBlocks: base.scheduleBlocks.concat(softPins.map((block) => ({ ...block, accepted: true }))),
      healthPrefs: state.healthPrefs,
      userPrefs: state.userPrefs,
      // Google and iPhone calendar events together (no deviceCalendarEvents below, so nothing is counted twice).
      googleCalendarEvents: busyCalendarEvents(state),
      semester: state.semester,
    },
    parseLocalDate(weekStartKeys[0] ?? localDateKey(getWeekStart(now))),
    fixedWindows,
    {
      now, coveredMinutes, coveredSessions, maxHorizonDays: options.maxHorizonDays, blockedDates: context.blockedDates, firstTaskIds,
      cappedDates: context.movedDates, sharedBusy: base.sharedBusy,
    },
  );
  const solvedStudyBlocks = convertToScheduleBlocks(solver.scheduledBlocks)
    .filter((block) => windowSet.has(block.date));

  const pinsByDate = byDate(softPins);
  const generatedBlocks = [
    ...base.structural.filter((candidate) => keepsGenerated(candidate, pinsByDate.get(candidate.date) ?? [])),
    ...solvedStudyBlocks.filter((candidate) => keepsGenerated(candidate, base.preservedByDate.get(candidate.date) ?? []) &&
      keepsGenerated(candidate, pinsByDate.get(candidate.date) ?? [])),
  ];
  // Ids must stay unique across the whole calendar (a preserved block may already own a deterministic id).
  const claimed = new Set(softPins.map((block) => block.id));
  const takenIds = { has: (id: string) => base.takenIds.has(id) || claimed.has(id), add: (id: string) => claimed.add(id) };
  const uniqueGenerated = generatedBlocks.map((block) => claimUniqueId(block, takenIds));
  const windowBlocks = [...uniqueGenerated, ...keptInWindow].sort(byWhen);

  const scheduledTaskIds = new Set(solvedStudyBlocks.flatMap((block) => block.taskId ? [block.taskId] : []));
  for (const taskId of Object.keys(coveredMinutes)) scheduledTaskIds.add(taskId);
  const tasks = state.tasks.map((task) => (
    scheduledTaskIds.has(task.id) && task.status === "pending"
      ? { ...task, status: "scheduled" as const }
      : task
  ));

  return {
    scheduleBlocks: [...outsideWindow, ...windowBlocks],
    tasks,
    unscheduledTasks: solver.unscheduledTasks,
    shortfalls: solver.shortfalls,
    overdueTasks: solver.overdueTasks,
    summary: solver.summary,
    releasedSessions: context.releasedSessions,
  };
}

function withSessionGap(endTime: string): string {
  return minutesToTime(Math.min(timeToMinutes(endTime) + SESSION_GAP_MINUTES, DAY_MINUTES - 1));
}

/** Study the solver counts toward a day's load: finished, confirmed and started sessions. */
function countsAsLoad(block: ScheduleBlock): boolean {
  return block.type === "study" && Boolean(block.taskId) &&
    (block.completionStatus === "done" || (block.completionStatus === "pending" && Boolean(block.accepted || block.locked || block.startedAt || block.userEdited)));
}

/**
 * Calendar order: date, start time, then id. Date keys and "HH:MM" times compare as plain strings, the order
 * localeCompare gives them too at a fraction of the cost (every solve sorts the whole window).
 */
const byWhen = (a: Pick<ScheduleBlock, "date" | "startTime" | "id">, b: Pick<ScheduleBlock, "date" | "startTime" | "id">) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : a.id.localeCompare(b.id);

/**
 * The stable re-plan's soft pins: upcoming study suggestions nobody confirmed that are kept exactly where they are
 * (like accepted sessions, but releasable), so a new day, a finished session or an unrelated edit leaves the plan
 * alone. A suggestion is let go, and its minutes planned again, when it is no longer valid:
 *  - its task is one the change touched (replanTaskIds: a moved deadline, a new estimate...), planned again as a whole;
 *  - its task is finished, skipped or gone, has no date, or is a quiz / exam that has taken place;
 *  - its task is an exam planned through its exam prep (or an older prep of the same exam): the prep plans that time
 *    (1.0.8 saved both, so this also clears the duplicates of a plan saved by 1.0.8);
 *  - it is after its task's deadline (or its class-time cutoff), before the day the student deferred the work to, on a
 *    deferred day, further ahead of the deadline than the solver ever plans (lib/intelligent-scheduler.ts
 *    farthestLeadDays), or catch-up work no longer in the next two days;
 *  - it overlaps a class (or the break after it), a commitment, a no-study zone, a Google Calendar event, one of the
 *    student's own events, a confirmed, started or finished session, or lies outside the hours the planner uses;
 *  - its day is over the 4-session cap, or over the daily study cap because of a session the student moved there
 *    (the least urgent suggestion on that day goes first). The solver never takes such a day past the daily cap but for
 *    work due within two days (SchedulingOptions.cappedDates), or the next re-plan put back what this one let go
 *    (1.0.9 audit: not idempotent).
 * Then each task keeps what it still needs: surplus sessions (work done early, a lower estimate, a missed session
 * ticked done after its make-up was planned) go latest first, the last one shortened when only part of it is surplus.
 * A task short by less than a minimum session lets its latest suggestion go, so the solver plans it again at full size
 * instead of adding a stub.
 */
function keptSuggestions(state: PlannerState, options: PlanWindowOptions, context: WindowContext): ScheduleBlock[] {
  const { todayKey, nowHHMM, preservedInWindow } = context;
  const nowMinutes = options.now.getHours() * 60 + options.now.getMinutes();
  const candidates = context.inWindow.filter((block) =>
    block.type === "study" && Boolean(block.taskId) && block.completionStatus === "pending" && !block.startedAt &&
    !block.accepted && !block.locked && !block.userEdited && !context.releasedIds.has(block.id) && !isPastBlock(block, todayKey, nowHHMM) &&
    !options.replanTaskIds?.has(block.taskId!) && !context.plannedBy.has(block.taskId!));
  if (candidates.length === 0) return [];

  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const planning = getPlanningWindow(state.healthPrefs.wakeTime, state.healthPrefs.bedtime);
  const blocked = new Set(context.blockedDates);
  const dates = [...new Set(candidates.map((block) => block.date))].sort();
  // The time a newly placed session could not use either (the solver builds the same busy map).
  const busy = buildBusyMap(dates, {
    classes: state.classes,
    recurringEvents: context.recurringEvents ?? [],
    scheduleBlocks: [...context.outsideWindow, ...preservedInWindow],
    googleCalendarEvents: busyCalendarEvents(state),
    extraOccupied: [...context.structuralBlocks, ...preservedInWindow]
      .filter((block) => block.type !== "sleep" && block.startTime < block.endTime)
      .map((block) => ({ date: block.date, startTime: block.startTime, endTime: block.endTime })),
    noGoZones: state.userPrefs.noGoZones ?? [],
    isClassDay: state.semester ? (date) => isClassDay(state.semester, date) : undefined,
  });
  const neededByTask = new Map<string, number>();
  const needed = (task: Task) => {
    if (!neededByTask.has(task.id)) neededByTask.set(task.id, plannedMinutesFor(task));
    return neededByTask.get(task.id)!;
  };

  let pins: ScheduleBlock[] = [];
  for (const block of [...candidates].sort(byWhen)) {
    const task = tasksById.get(block.taskId!);
    if (!task || (task.status !== "pending" && task.status !== "scheduled")) continue;
    const dueKey = dateKeyOf(task.dueDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueKey)) continue;
    const deadline = taskDeadline(task, state.classes, state.semester);
    const notBefore = task.notBeforeDate ? task.notBeforeDate.slice(0, 10) : "";
    const overdue = deadlinePassed(deadline, todayKey, nowMinutes) || notBefore > dueKey;
    if (overdue && isAssessmentTask(task)) continue;
    if (block.date < notBefore || blocked.has(block.date)) continue;
    const [start, end] = blockSpan(block);
    if (overdue) {
      if (block.date > addDaysToKey(notBefore > todayKey ? notBefore : todayKey, 1)) continue;
    } else {
      if (block.date > dueKey || (block.date === dueKey && deadline.cutoffMinutes !== undefined && end > deadline.cutoffMinutes)) continue;
      if (daysBetweenKeys(block.date, dueKey) > farthestLeadDays(task, needed(task), state.userPrefs)) continue;
    }
    if (start < planning.start || end > planning.end) continue;
    if ((busy[block.date] ?? []).some((interval) => start < interval.endMinutes && interval.startMinutes < end)) continue;
    // Two suggestions on top of each other (older data): the earlier one stays.
    if (pins.some((pin) => pin.date === block.date && start < blockSpan(pin)[1] && blockSpan(pin)[0] < end)) continue;
    pins.push(block);
  }

  // Day caps. The least urgent suggestion (latest deadline, then latest start) goes first. Work due within URGENT_DAYS
  // days neither counts toward nor gives way to the daily cap of a day the student moved a session to: the solver may
  // put it there past the cap as a last resort, so letting it go (or the work it pushed past the cap) made the next
  // re-plan move the day's other sessions (SchedulingOptions.cappedDates).
  const caps = studyLoadCaps(state.userPrefs);
  const dueOf = (block: ScheduleBlock) => dateKeyOf(tasksById.get(block.taskId!)?.dueDate ?? "");
  const urgentUntil = addDaysToKey(todayKey, URGENT_DAYS);
  const urgent = (block: ScheduleBlock) => dueOf(block) <= urgentUntil;
  for (const date of dates) {
    const load = preservedInWindow.filter((block) => block.date === date && countsAsLoad(block));
    const movedHere = context.movedDates.has(date);
    const onDay = pins.filter((pin) => pin.date === date)
      .sort((a, b) => dueOf(b).localeCompare(dueOf(a)) || b.startTime.localeCompare(a.startTime) || b.id.localeCompare(a.id));
    const minutes = () => [...load, ...onDay.filter((pin) => !urgent(pin))].reduce((sum, block) => sum + blockMinutes(block), 0);
    const dropped = new Set<string>();
    while (onDay.length > 0 && (load.length + onDay.length > DAILY_STUDY_CAP || (movedHere && !urgent(onDay[0]!) && minutes() > caps.dailyMinutes))) {
      dropped.add(onDay.shift()!.id);
    }
    if (dropped.size > 0) pins = pins.filter((pin) => !dropped.has(pin.id));
  }

  // What each task still needs, against what stays on the calendar anyway (confirmed / started sessions; an exam's
  // count for the prep that plans it, and a finished prep's minutes for its exam).
  const confirmed: Record<string, number> = Object.fromEntries(context.prepCredit);
  for (const block of [...context.outsideWindow.filter((b) => b.accepted), ...preservedInWindow]) {
    if (block.type !== "study" || !block.taskId || block.completionStatus !== "pending") continue;
    if (options.fullHorizon && isPastBlock(block, todayKey, nowHHMM)) continue;
    const taskId = context.plannedBy.get(block.taskId) ?? block.taskId;
    confirmed[taskId] = (confirmed[taskId] ?? 0) + blockMinutes(block);
  }
  const replaced = new Map<string, ScheduleBlock | null>();
  const pinsByTask = new Map<string, ScheduleBlock[]>();
  for (const pin of pins) pinsByTask.set(pin.taskId!, [...(pinsByTask.get(pin.taskId!) ?? []), pin]);
  for (const [taskId, taskPins] of pinsByTask) {
    const task = tasksById.get(taskId)!;
    const latestFirst = [...taskPins].sort(byWhen).reverse();
    let covered = (confirmed[taskId] ?? 0) + taskPins.reduce((sum, pin) => sum + blockMinutes(pin), 0);
    let surplus = covered - needed(task);
    while (surplus > 0 && latestFirst.length > 0) {
      const last = latestFirst[0]!;
      const minutes = blockMinutes(last);
      if (minutes <= surplus) {
        replaced.set(last.id, null);
        latestFirst.shift();
        surplus -= minutes;
        covered -= minutes;
        continue;
      }
      if (minutes - surplus >= MIN_SESSION_MINUTES) {
        const keep = minutes - surplus;
        replaced.set(last.id, {
          ...last,
          endTime: minutesToTime(timeToMinutes(last.startTime) + keep),
          ...(last.whatCountsAsDone ? { whatCountsAsDone: last.whatCountsAsDone.replace(`${minutes} min`, `${keep} min`) } : {}),
        });
        covered -= surplus;
      }
      break;
    }
    const short = remainingMinutes(task) - covered;
    if (short > 0 && short < MIN_SESSION_MINUTES && latestFirst.length > 0) replaced.set(latestFirst[0]!.id, null);
  }
  return pins.flatMap((pin) => {
    if (!replaced.has(pin.id)) return [pin];
    const next = replaced.get(pin.id);
    return next ? [next] : [];
  });
}

/**
 * Soft pins for a re-solve that moves as few suggestions as it can: the `kept` ones, the short tasks' new sessions in
 * `partial` (which solved them first in the room of the `freed` suggestions), and every freed suggestion of another
 * task back in its slot unless one of those new sessions now needs it (an overlap, or its day would go past the session
 * cap or, on a day the student moved a session to, the daily cap). The most urgent go back first.
 */
function putBack(state: PlannerState, context: WindowContext, kept: ScheduleBlock[], freed: ScheduleBlock[], partial: WeekPlanResult, short: ReadonlySet<string>): ScheduleBlock[] {
  const keptIds = new Set(kept.map((pin) => pin.id));
  const placed = partial.scheduleBlocks.filter((block) => block.type === "study" && Boolean(block.taskId) && short.has(block.taskId!) &&
    block.completionStatus === "pending" && !block.accepted && !block.locked && !block.userEdited && !block.startedAt &&
    context.windowSet.has(block.date) && !isPastBlock(block, context.todayKey, context.nowHHMM) && !keptIds.has(block.id));
  const pins = [...kept, ...placed];
  const caps = studyLoadCaps(state.userPrefs);
  const dueOf = new Map(state.tasks.map((task) => [task.id, dateKeyOf(task.dueDate)]));
  // As in keptSuggestions: work due within URGENT_DAYS days neither counts toward a moved day's daily cap nor gives way.
  const urgentUntil = addDaysToKey(context.todayKey, URGENT_DAYS);
  const urgent = (block: ScheduleBlock) => (dueOf.get(block.taskId!) ?? "") <= urgentUntil;
  const minutes = (blocks: ScheduleBlock[]) => blocks.reduce((sum, block) => sum + blockMinutes(block), 0);
  const candidates = freed.filter((pin) => !short.has(pin.taskId!))
    .sort((a, b) => (dueOf.get(a.taskId!) ?? "").localeCompare(dueOf.get(b.taskId!) ?? "") || byWhen(a, b));
  for (const pin of candidates) {
    const [start, end] = blockSpan(pin);
    const sameDay = pins.filter((other) => other.date === pin.date);
    if (sameDay.some((other) => start < blockSpan(other)[1] + SESSION_GAP_MINUTES && blockSpan(other)[0] < end + SESSION_GAP_MINUTES)) continue;
    const load = context.preservedInWindow.filter((block) => block.date === pin.date && countsAsLoad(block));
    if (load.length + sameDay.length >= DAILY_STUDY_CAP) continue;
    if (context.movedDates.has(pin.date) && !urgent(pin) && minutes(load) + minutes(sameDay.filter((other) => !urgent(other))) + blockMinutes(pin) > caps.dailyMinutes) continue;
    pins.push(pin);
  }
  return pins;
}

/**
 * Kept suggestions to let go when keeping every one left work without room (ids): those on the days the short tasks
 * could use, from `release` days before their deadline (or the two catch-up days of overdue work). With "tasks",
 * every suggestion of the short tasks and of each task with one on those days (up to 4 weeks back).
 */
function freedSuggestions(state: PlannerState, shortfalls: TaskShortfall[], pins: ScheduleBlock[], todayKey: string, release: number | "tasks"): Set<string> {
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const lookback = release === "tasks" ? 28 : release;
  const ranges = shortfalls
    .filter((shortfall) => shortfall.missingMinutes > 0 && /^\d{4}-\d{2}-\d{2}$/.test(shortfall.dueDate))
    .map((shortfall) => {
      const notBefore = tasksById.get(shortfall.taskId)?.notBeforeDate?.slice(0, 10) ?? "";
      const earliest = notBefore > todayKey ? notBefore : todayKey;
      if (shortfall.overdue) return { from: earliest, to: addDaysToKey(earliest, 1) };
      const reach = addDaysToKey(shortfall.dueDate, -lookback);
      return { from: reach > earliest ? reach : earliest, to: shortfall.dueDate };
    });
  const onThoseDays = pins.filter((pin) => ranges.some((range) => pin.date >= range.from && pin.date <= range.to));
  if (release !== "tasks") return new Set(onThoseDays.map((pin) => pin.id));
  const tasks = new Set([...shortfalls.map((shortfall) => shortfall.taskId), ...onThoseDays.map((pin) => pin.taskId!)]);
  return new Set(pins.filter((pin) => tasks.has(pin.taskId!)).map((pin) => pin.id));
}

/**
 * Plan ONE week. It keeps AI out of exact time placement, rebuilds structural constraints, protects user
 * decisions, and delegates all study-slot selection to the deterministic solver. Only the requested week
 * changes; use `buildSemesterPlan` (lib/semester-plan.ts) to plan the whole semester in one pass.
 *
 * Limitation of planning one week at a time: only ACCEPTED sessions in the other weeks count as covering a task
 * (unaccepted suggestions elsewhere are not "kept" by this call), so several single-week calls over the same task
 * can place its minutes more than once. The app therefore plans through buildSemesterPlan everywhere except a
 * week beyond the planned horizon; this function stays for that case and for one-week previews.
 *
 * Regenerating is stable: study sessions get deterministic ids, blocks the user
 * accepted, edited, locked, started or completed are kept exactly as they are,
 * and running it twice on its own output changes nothing.
 */
export function buildWeekPlan(
  state: PlannerState,
  requestedWeekStart?: Date,
  options: WeekPlanOptions = {},
): WeekPlanResult {
  const now = options.now ?? new Date();
  const weekStart = requestedWeekStart ?? getWeekStart(now);
  return planWindow(state, {
    weekStartKeys: [getWeekDates(weekStart)[0]!],
    now,
    preserveAccepted: options.preserveAccepted ?? true,
    preserveLocked: options.preserveLocked ?? true,
  });
}

export { GENERATED_BLOCK_TYPES };
