// ============================================================
// Trajectory — the plan's state: reducer, re-plan requests and their previews (pure)
// ============================================================
// Ported from the mobile app's lib/app-context.tsx without its React provider: the web provider
// (src/state/app-provider.tsx) wraps `reducer` and `runReplan` and adds persistence and the automatic re-plan.

import {
  AppState,
  ClassBlock,
  ExamPrep,
  Grade,
  HealthPreferences,
  IfThenPlan,
  MasteryLevel,
  RecurringEvent,
  ScheduleBlock,
  StudyRecommendation,
  Task,
  User,
  UserPreferences,
  SyllabusStudyGuide,
  SyllabusPracticeExam,
  NotificationSettings,
  SyllabusImport,
  GoogleCalendarEventLocal,
  Semester,
  ReplanSnapshot,
} from "./types";
import { buildWeekPlan, findPushedBlock, type ReleasedSession } from "./week-planner";
import { buildSemesterPlan } from "./semester-plan";
import { getPlanningHorizon, validateSemester, weekStartsInRange } from "./semester";
import {
  PlanPatch,
  changedTaskIds,
  diffPlans,
  markMissedBlocks,
  planDeferral,
  previewFixMyDay,
  previewPlanChange,
  replanSemester,
  toPlanAlerts,
  undoLastChange,
  withUndoSnapshot,
  type DeferralAtRisk,
  type FixMyDayPreview,
  type ReplanDiff,
  type ReplanPreview,
} from "./replan";
import { countConflicts } from "./plan-quality";
import { busyCalendarEvents } from "./calendar-events";
import {
  applyBlockMoves,
  calendarConflicts,
  doNotScheduleConflicts,
  resolveCalendarConflicts,
  resolveDoNotScheduleConflicts,
  sessionsOnCalendarEvents,
  type BlockMove,
} from "./day-conflicts";
import { applyBlockCompletion, revertBlockCompletion } from "./task-progress";
import { addDaysToKey, getWeekStart, localDateKey, parseLocalDate } from "./utils";
import { scoreTasks } from "./priority-engine";
import { applySyllabusImport, undoSyllabusImport, type ApplySyllabusImportPayload } from "./syllabus-import";
import { calendarEventsKey, planInputsKey } from "./plan-inputs";
import { examsPlannedByPrep, followExamDates } from "./exam-prep-link";
import { createInitialState } from "./state-persistence";

// ── Plan changes with no Undo ─────────────────────────────────

export type { ReplanNotice } from "./types";

/** The notice's headline after outside calendar events changed (a ReplanNotice, lib/types.ts). */
export const CALENDAR_REPLAN_LABEL = "Plan updated for calendar changes";

// ── Initial State ─────────────────────────────────────────────

export const initialState: AppState = createInitialState();

// ── Actions ───────────────────────────────────────────────────

export type Action =
  | { type: "LOAD_STATE"; payload: AppState }
  | { type: "COMPLETE_ONBOARDING" }
  /** Set (or with null clear) the term being planned. An invalid semester (start after end, a break outside the range) is ignored. */
  | { type: "SET_SEMESTER"; payload: Semester | null }
  /** Apply a previewed re-plan / assistant change and remember how to undo it (keeps the last 3). `summary` is shown by the Undo UI. */
  | { type: "APPLY_REPLAN"; payload: { label: string; at: string; next: PlanPatch; summary?: string } }
  /**
   * The automatic whole-semester re-plan after an ordinary edit, a new day (and "Replan the semester"). It is STABLE: every
   * upcoming suggestion that still works stays where it is and only the difference is planned (lib/week-planner.ts
   * planWindow keepSuggestions); sessions that ended unticked are kept as "missed". When it moves, adds or removes
   * sessions it keeps an undo snapshot marked "auto" ("Plan updated — N sessions moved · Undo"); after an edit of the
   * plan's inputs that snapshot also holds them as they were, so Undo puts the edit back too. After a change of the
   * outside calendar events alone it keeps no snapshot (they cannot be put back) and leaves the older ones alone: a
   * ReplanNotice says what moved instead.
   */
  | { type: "AUTO_REPLAN"; payload?: { weekStart?: Date; now?: Date; label?: string } }
  /**
   * Restore the schedule as it was before the newest applied change. Outside calendar events cannot be put back, so a
   * restored session that now sits on one is moved again (only those). `now` is for tests.
   */
  | { type: "UNDO_REPLAN"; now?: Date }
  | { type: "UNCOMPLETE_BLOCK"; payload: string }
  | { type: "ADD_CLASS"; payload: ClassBlock }
  | { type: "REMOVE_CLASS"; payload: string }
  | { type: "ADD_RECURRING_EVENT"; payload: RecurringEvent }
  | { type: "UPDATE_RECURRING_EVENT"; payload: RecurringEvent }
  | { type: "DELETE_RECURRING_EVENT"; payload: string }
  | { type: "ADD_TASK"; payload: Task }
  | { type: "UPDATE_TASK"; payload: Task }
  | { type: "BATCH_UPDATE_TASK_SCORES"; payload: Task[] }
  | { type: "DELETE_TASK"; payload: string }
  /** Mark a task done. `now` is for tests (its sessions still ahead are removed, earlier ones marked done). */
  | { type: "COMPLETE_TASK"; payload: string; now?: Date }
  | { type: "SET_SCHEDULE_BLOCKS"; payload: ScheduleBlock[] }
  | { type: "ACCEPT_BLOCK"; payload: string }
  | { type: "COMPLETE_BLOCK"; payload: string }
  | { type: "SKIP_BLOCK"; payload: string }
  | { type: "PUSH_BLOCK"; payload: { blockId: string; minutes?: number } }
  | { type: "UPDATE_BLOCK"; payload: Partial<ScheduleBlock> & { id: string } }
  | { type: "DELETE_BLOCK"; payload: string }
  | { type: "SET_IF_THEN_PLAN"; payload: { blockId: string; plan: IfThenPlan } }
  | { type: "UPDATE_HEALTH_PREFS"; payload: Partial<HealthPreferences> }
  | { type: "UPDATE_USER_PREFS"; payload: Partial<UserPreferences> }
  /** Same as AUTO_REPLAN (name kept for existing callers): stable, undoable, sessions that ended unticked kept as missed. `now` is for tests. */
  | { type: "REGENERATE_WEEK"; payload?: { now?: Date } }
  /**
   * Reset ALL in-memory state to a fresh install: signing out and deleting the account both wipe this iPhone (the
   * plan stays saved in the account unless the account is deleted). Persisted keys are wiped by lib/account-deletion-utils.
   */
  | { type: "LOGOUT" }
  | { type: "UPDATE_USER"; payload: Partial<User> }
  | { type: "UPDATE_CLASS"; payload: ClassBlock }
  | { type: "SET_CLASSES"; payload: ClassBlock[] }
  | { type: "ADD_GRADE"; payload: Grade }
  | { type: "UPDATE_GRADE"; payload: Grade }
  | { type: "DELETE_GRADE"; payload: string }
  | { type: "SET_RECOMMENDATIONS"; payload: StudyRecommendation[] }
  | { type: "RESET_SEMESTER" }
  | { type: "ADD_EXAM_PREP"; payload: ExamPrep }
  | { type: "UPDATE_EXAM_PREP"; payload: ExamPrep }
  | { type: "DELETE_EXAM_PREP"; payload: string }
  | { type: "UPDATE_EXAM_TOPIC_MASTERY"; payload: { examId: string; topicId: string; mastery: MasteryLevel } }
  /**
   * Plan the WHOLE semester (one solver pass; the first build, and after a syllabus import), stable: suggestions that
   * still work are kept. `weekStart` only matters for a week outside the planned horizon. `now` is for tests.
   */
  | { type: "AUTO_BUILD_WEEK"; payload?: { weekStart?: Date; now?: Date } }
  | { type: "BUILD_WEEK_FOR"; payload: { weekStart: Date; now?: Date } }
  | { type: "ADD_BLOCK"; payload: ScheduleBlock }
  | { type: "ADD_STUDY_GUIDE"; payload: SyllabusStudyGuide }
  | { type: "DELETE_STUDY_GUIDE"; payload: string }
  | { type: "ADD_PRACTICE_EXAM"; payload: SyllabusPracticeExam }
  | { type: "DELETE_PRACTICE_EXAM"; payload: string }
  | { type: "UPDATE_NOTIFICATION_SETTINGS"; payload: Partial<NotificationSettings> }
  | { type: "ADD_SYLLABUS_IMPORT"; payload: SyllabusImport }
  /** One atomic syllabus import (class, tasks, semester); the record remembers what it created so UNDO_SYLLABUS_IMPORT can remove exactly that. */
  | { type: "APPLY_SYLLABUS_IMPORT"; payload: ApplySyllabusImportPayload }
  /** Remove what one import created (tasks, class, generated blocks) and restore what it overwrote. Payload = the import id. */
  | { type: "UNDO_SYLLABUS_IMPORT"; payload: string }
  | { type: "DELETE_SYLLABUS_IMPORT"; payload: string }
  | { type: "SET_GOOGLE_CALENDAR_EVENTS"; payload: { events: GoogleCalendarEventLocal[]; connected: boolean; lastSync: string } }
  | { type: "SET_GOOGLE_CALENDAR_CONNECTED"; payload: boolean }
  | { type: "CLEAR_GOOGLE_CALENDAR" }
  /**
   * Replace the events read from the iPhone's calendars (lib/device-calendars.ts; they never leave the phone). The
   * reactive planner then re-plans only what they made wrong, like after a Google sync.
   */
  | { type: "SET_DEVICE_CALENDAR_EVENTS"; payload: GoogleCalendarEventLocal[] }
  /** "Plan around my iPhone calendars" was turned off (or calendar access was taken away): forget those events. */
  | { type: "CLEAR_DEVICE_CALENDAR_EVENTS" };

// ── The student's own changes ─────────────────────────────────

/**
 * Actions that are not a change the student made to the plan: they derive the plan again from what is already in it
 * (the automatic re-plan, priority scores, a week built on first view), put a stored or saved plan in place, or
 * touch what is not part of the saved plan (outside calendar events, this iPhone's notification settings). Every
 * other action counts as the student's, including any added later.
 */
const NOT_THE_STUDENTS_CHANGE = new Set<Action["type"]>([
  "LOAD_STATE", "LOGOUT", "AUTO_REPLAN", "BATCH_UPDATE_TASK_SCORES", "BUILD_WEEK_FOR", "UPDATE_NOTIFICATION_SETTINGS",
  "SET_GOOGLE_CALENDAR_EVENTS", "SET_GOOGLE_CALENDAR_CONNECTED", "CLEAR_GOOGLE_CALENDAR",
  "SET_DEVICE_CALENDAR_EVENTS", "CLEAR_DEVICE_CALENDAR_EVENTS",
]);

/** Whether an action is a change the student made (exported for tests; the provider notes it at every dispatch). */
export function isStudentAction(action: { type: string }): boolean {
  return !NOT_THE_STUDENTS_CHANGE.has(action.type as Action["type"]);
}

// The plan saved to the account (components/plan-sync.tsx) needs to tell the two kinds of change apart: when another
// device saved a newer plan, what this iPhone only re-planned by itself can give way to it quietly, but a change the
// student made here cannot. So the student's actions are counted twice: when they are dispatched, and as they go
// into a state. A state that holds fewer than were dispatched is one the student has just changed without React
// having rendered it yet (or an action of theirs changed nothing, which is why whoever compares the two only trusts
// the difference for a moment after the last dispatch).

let studentActions = 0;
let lastStudentActionAt = 0;

/** Called by the provider with every action on its way to the reducer. */
export function noteDispatched(action: { type: string }, now: number = Date.now()): void {
  if (!isStudentAction(action)) return;
  studentActions++;
  lastStudentActionAt = now;
}

/** How many of the student's own actions have been dispatched so far. */
export function studentActionCount(): number {
  return studentActions;
}

/** When the last of them was dispatched (ms since the epoch; 0: none yet). */
export function lastStudentActionTime(): number {
  return lastStudentActionAt;
}

/**
 * Beside each state, how many of the student's own actions went into it. Kept here and not in the state: it is not
 * part of the plan. The reducer writes it for every new state it returns, from the count of the state it was given,
 * so it stays right whatever order React renders updates in, and however often it calls the reducer.
 */
const studentEdits = new WeakMap<AppState, number>();

/** How many of the student's own actions went into `state`. More in a later state: the student changed something. */
export function studentEditsIn(state: AppState): number {
  return studentEdits.get(state) ?? 0;
}

/** The two actions that put a whole other state in place. */
const REPLACES_THE_STATE = new Set<Action["type"]>(["LOAD_STATE", "LOGOUT"]);

/** Kept the same way: how many times the whole state had been replaced by the time each state was made. */
const stateReplacements = new WeakMap<AppState, number>();

/**
 * How many times the whole state had been replaced (a stored or saved plan loaded, a wipe) when `state` was made.
 * Whoever replaces the state (lib/plan-sync-device.ts, when a saved plan is loaded) uses it to tell a render that
 * already includes the replacement from one that does not yet: React does not always render actions in the order
 * they were dispatched (a tap is rendered ahead of an action dispatched from a timer or a promise).
 */
export function stateReplacementsIn(state: AppState): number {
  return stateReplacements.get(state) ?? 0;
}

// ── Planning helpers ──────────────────────────────────────────

/**
 * Re-plan the whole semester (one solver pass over every week of the planning horizon). A `weekStart` outside
 * that horizon (a far-future week the student browsed to) is also built, week-only, so it is never left empty.
 */
function planSemester(state: AppState, options: PlanSemesterOptions = {}): AppState {
  return planSemesterDetailed(state, options).next;
}

interface PlanSemesterOptions {
  weekStart?: Date;
  now?: Date;
  /** Keep every still-valid upcoming suggestion where it is and plan only the difference (the automatic re-plan). */
  stable?: boolean;
  /** With `stable`: tasks an edit touched, planned again as a whole (lib/replan.ts changedTaskIds). */
  replanTaskIds?: ReadonlySet<string>;
  /** With `stable`: only what the change made wrong is planned again, no other suggestion moves (a calendar sync). */
  keepAllValid?: boolean;
  /** A re-plan the student runs (and previews): sessions it records as missed no longer count as "behind". */
  acknowledgeMissed?: boolean;
}

/**
 * planSemester, plus the confirmed sessions the planner released because the change made them wrong and the sessions
 * it recorded as missed. Sessions that ended unticked are never dropped: they stay on the calendar as "missed" (the
 * student can still tick them done) and their minutes are planned again.
 */
function planSemesterDetailed(state: AppState, options: PlanSemesterOptions = {}): { next: AppState; released: ReleasedSession[]; marked: ScheduleBlock[] } {
  const now = options.now ?? new Date();
  const missed = markMissedBlocks(state, now, { automatic: !options.acknowledgeMissed });
  const input = missed.marked.length > 0 ? { ...state, scheduleBlocks: missed.blocks } : state;
  const plan = buildSemesterPlan(input, { now, keepSuggestions: options.stable, replanTaskIds: options.replanTaskIds, keepAllValid: options.keepAllValid });
  let next: AppState = { ...state, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks, planAlerts: toPlanAlerts(plan.shortfalls, plan.overdueTasks, now) };
  if (options.weekStart) {
    const weekKey = localDateKey(options.weekStart);
    const inHorizon = weekStartsInRange(plan.horizon.startKey, plan.horizon.endKey).includes(weekKey);
    if (!inHorizon) {
      const week = buildWeekPlan(next, options.weekStart, { now });
      next = { ...next, scheduleBlocks: week.scheduleBlocks, tasks: week.tasks };
    }
  }
  return { next, released: plan.releasedSessions ?? [], marked: missed.marked };
}

/** Credit / un-credit a study block's minutes to its task when the block's "done" state flips. */
function tasksAfterBlockChange(tasks: Task[], before: ScheduleBlock, after: ScheduleBlock): Task[] {
  if (before.type !== "study" || !before.taskId) return tasks;
  const wasDone = before.completionStatus === "done";
  const isDone = after.completionStatus === "done";
  if (wasDone === isDone) return tasks;
  return tasks.map((task) => (
    task.id !== before.taskId ? task : isDone ? applyBlockCompletion(task, after) : revertBlockCompletion(task, before)
  ));
}

/** Replace one block and keep its task's progress in step with the block's completion state. */
function changeBlock(state: AppState, blockId: string, change: (block: ScheduleBlock) => ScheduleBlock): AppState {
  const before = state.scheduleBlocks.find((block) => block.id === blockId);
  if (!before) return state;
  const after = change(before);
  if (after === before) return state;
  return {
    ...state,
    scheduleBlocks: state.scheduleBlocks.map((block) => (block.id === blockId ? after : block)),
    tasks: tasksAfterBlockChange(state.tasks, before, after),
  };
}

/**
 * "Start this week over". Inside the planned semester it releases the week's study sessions (accepted and edited
 * ones too; locked, started and finished ones stay) and re-plans the WHOLE semester, so the released minutes are
 * placed once, consistently with every other week, and one-off events the student added are never dropped.
 * Outside it there is no plan to stay consistent with: just that week is built.
 */
function rebuildWeek(state: AppState, weekStart: Date, now: Date): { next: AppState; released: ReleasedSession[]; marked: ScheduleBlock[] } {
  const weekKey = localDateKey(weekStart);
  const horizon = getPlanningHorizon(state, now);
  if (!weekStartsInRange(horizon.startKey, horizon.endKey).includes(weekKey)) {
    const plan = buildWeekPlan(state, weekStart, { preserveAccepted: false, preserveLocked: true, now });
    return { next: { ...state, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks }, released: plan.releasedSessions ?? [], marked: [] };
  }
  const weekDates = new Set(Array.from({ length: 7 }, (_, i) => addDaysToKey(weekKey, i)));
  const released = state.scheduleBlocks.map((block) => (
    weekDates.has(block.date) && block.type === "study" && block.taskId && !block.locked && !block.startedAt && block.completionStatus === "pending"
      ? { ...block, accepted: false, userEdited: false }
      : block
  ));
  return planSemesterDetailed({ ...state, scheduleBlocks: released }, { now, acknowledgeMissed: true });
}

/** Add the Undo UI's details (and, after an edit, the inputs as they were) to the snapshot `withUndoSnapshot` just stored. */
function annotateLatestSnapshot(state: AppState, extra: Partial<Omit<ReplanSnapshot, "label" | "at">>): AppState {
  const [latest, ...rest] = state.undoSnapshots ?? [];
  if (!latest) return state;
  return { ...state, undoSnapshots: [{ ...latest, ...extra }, ...rest] };
}

// ── Re-plan requests ──────────────────────────────────────────
// Every "Replan" UI (the Replan sheet on Today / Week / Settings, "Move to tomorrow" in the block sheet) asks
// `runReplan` for a PREVIEW and applies it with APPLY_REPLAN (undoable). This is the one seam where the engine
// behind each scope is chosen.

export type ReplanScope = "today" | "week" | "semester";
/** Today's options: Fix My Day (two modes), move the rest to tomorrow, and the two local clash fixers. */
export type TodayReplanMode = "protect_sleep" | "crunch_mode" | "defer" | "calendar_conflicts" | "do_not_schedule";
export type ReplanRequest =
  | {
      scope: "today";
      mode: TodayReplanMode;
      /** Local date key; defaults to today. */
      date?: string;
      /** Defer only: the student chose "Move anyway" after being told work would miss its deadline. */
      acceptLate?: boolean;
      /** Defer only: move just these open sessions (Today's "Move N to tomorrow"); the others stay. Default: all. */
      blockIds?: readonly string[];
    }
  | { scope: "week"; /** Local date key of the week's Monday; defaults to this week. */ weekStart?: string }
  | { scope: "semester"; moveAccepted?: boolean; reason?: string };
export type ScopedReplanPreview = ReplanPreview & {
  unplaced?: FixMyDayPreview["unplaced"];
  /**
   * Defer only: nothing can be applied yet because moving the day would miss a deadline. The UI asks
   * "Keep it" / "Move anyway" (the latter runs the same request again with `acceptLate: true`).
   */
  needsConfirmation?: { atRisk: DeferralAtRisk[]; summary: string };
};

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "3 sessions moved · 1 added · 2 released" — what a change did, for the Undo UI and the toast. Empty when nothing changed. */
export function describeReplanDiff(diff: Pick<ReplanDiff, "moved" | "added" | "removed" | "markedMissed" | "released">): string {
  const parts: [number, string][] = [
    [diff.moved.length, "moved"],
    [diff.added.length, "added"],
    [diff.removed.length, "removed"],
    [diff.released?.length ?? 0, "released"],
    [diff.markedMissed.length, "marked missed"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, verb], index) => (index === 0 ? `${count(n, "session")} ${verb}` : `${n} ${verb}`))
    .join(" · ");
}

/** What the conflict count reads from the state: the outside calendar events are Google's and the iPhone's. */
type ConflictState = Pick<AppState, "classes" | "recurringEvents" | "semester" | "googleCalendarEvents"> & Partial<Pick<AppState, "deviceCalendarEvents">>;

/**
 * Real double bookings (study over a class, commitment, calendar event, own event or other study) in a plan from
 * today on — the ONLY source for a "0 conflicts" claim (lib/plan-quality.ts countConflicts). `next` may replace
 * classes / recurring events (an assistant change), otherwise the state's are used.
 */
export function countPlanConflicts(
  state: ConflictState,
  next: Pick<PlanPatch, "classes" | "recurringEvents"> & { scheduleBlocks: ScheduleBlock[] },
  now: Date = new Date(),
): number {
  return countConflicts(next.scheduleBlocks, {
    classes: next.classes ?? state.classes,
    recurringEvents: next.recurringEvents ?? state.recurringEvents,
    semester: state.semester,
    googleCalendarEvents: state.googleCalendarEvents,
    deviceCalendarEvents: state.deviceCalendarEvents,
  }, { fromDate: localDateKey(now) });
}

/** "0 conflicts" only when countConflicts is really 0, otherwise the count. */
export function describeConflicts(n: number): string {
  return n === 0 ? "0 conflicts" : count(n, "conflict");
}

/**
 * The Undo UI's one-line summary of an applied change: what moved, then the conflict count of the resulting plan
 * ("3 sessions moved · 0 conflicts"). Empty when nothing visible changed.
 */
export function changeSummary(
  state: ConflictState,
  preview: { diff: Pick<ReplanDiff, "moved" | "added" | "removed" | "markedMissed" | "released">; next: Pick<PlanPatch, "classes" | "recurringEvents"> & { scheduleBlocks: ScheduleBlock[] } },
  now: Date = new Date(),
): string {
  const what = describeReplanDiff(preview.diff);
  return what ? `${what} · ${describeConflicts(countPlanConflicts(state, preview.next, now))}` : "";
}

/** One plain sentence for a preview ("This moves 2 sessions and adds 1."), or `nothing` when nothing changes. */
function changeSentence(diff: ReplanDiff, nothing: string): string {
  const parts = [
    diff.moved.length > 0 ? `moves ${count(diff.moved.length, "session")}` : "",
    diff.added.length > 0 ? `adds ${count(diff.added.length, "session")}` : "",
    diff.removed.length > 0 ? `removes ${count(diff.removed.length, "session")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return nothing;
  return `This ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`;
}

const EMPTY_DIFF: ReplanDiff = { added: [], removed: [], moved: [], unchanged: 0, markedMissed: [], byTask: [], changed: false };

function nothingToDo(state: AppState, label: string, summary: string): ScopedReplanPreview {
  return { label, next: { scheduleBlocks: state.scheduleBlocks, tasks: state.tasks }, diff: EMPTY_DIFF, shortfalls: [], overdueTasks: [], summary };
}

/** Preview of moving some of the day's blocks to new slots (nothing else changes). */
function movesPreview(state: AppState, moves: BlockMove[], label: string, nothing: string, now: Date): ScopedReplanPreview {
  if (moves.length === 0) return nothingToDo(state, label, nothing);
  const scheduleBlocks = applyBlockMoves(state.scheduleBlocks, moves);
  const diff = diffPlans(state.scheduleBlocks, scheduleBlocks, { tasks: state.tasks, recurringEvents: state.recurringEvents, now });
  return { label, next: { scheduleBlocks, tasks: state.tasks }, diff, shortfalls: [], overdueTasks: [], summary: changeSentence(diff, nothing) };
}

/** "Move the rest of the day to tomorrow" (lib/replan.ts planDeferral): never silently pushes work past its deadline. */
function deferPreview(state: AppState, date: string, now: Date, acceptLate: boolean, blockIds?: readonly string[]): ScopedReplanPreview {
  const result = planDeferral(state, date, { now, acceptLate, blockIds });
  if (!result.ok) {
    if (result.reason === "nothing-to-defer") return nothingToDo(state, "Move to tomorrow", result.summary);
    return { ...nothingToDo(state, "Move to tomorrow", result.summary), needsConfirmation: { atRisk: result.atRisk, summary: result.summary } };
  }
  return {
    label: result.label,
    next: result.next,
    diff: result.diff,
    shortfalls: result.next.planAlerts?.shortfalls ?? [],
    overdueTasks: result.next.planAlerts?.overdueTasks ?? [],
    summary: result.summary,
  };
}

function weekPreview(state: AppState, weekStart: Date, now: Date): ScopedReplanPreview {
  const label = "Replan this week";
  const { next: after, released, marked } = rebuildWeek(state, weekStart, now);
  const replanned = after.planAlerts !== state.planAlerts;
  const shortfalls = replanned ? after.planAlerts?.shortfalls ?? [] : [];
  const diff = diffPlans(state.scheduleBlocks, after.scheduleBlocks, { tasks: after.tasks, recurringEvents: state.recurringEvents, now, shortfalls, released, markedMissed: marked });
  return {
    label,
    next: { scheduleBlocks: after.scheduleBlocks, tasks: after.tasks, ...(replanned ? { planAlerts: after.planAlerts } : {}) },
    diff,
    shortfalls,
    overdueTasks: replanned ? after.planAlerts?.overdueTasks ?? [] : [],
    summary: changeSentence(diff, "This week already fits: nothing needs to change."),
  };
}

/**
 * The preview for one Replan request, computed from `state` WITHOUT changing it. Apply it with
 * `APPLY_REPLAN { label, next, summary: changeSummary(state, preview) }` (useReplanFlow does this). A defer that
 * would miss a deadline comes back with `needsConfirmation` and must not be applied as is.
 *  - today:    Fix My Day (protect_sleep / crunch_mode), move the rest to tomorrow (defer), clear calendar clashes
 *              (Google and iPhone calendar events), clear do-not-schedule zones.
 *  - week:     start the week over, consistently with the rest of the semester.
 *  - semester: catch up missed sessions and refit the whole semester (optionally moving accepted sessions).
 */
export function runReplan(state: AppState, request: ReplanRequest, now: Date = new Date()): ScopedReplanPreview {
  switch (request.scope) {
    case "semester":
      return replanSemester(state, { now, reason: request.reason ?? "Replan the semester", moveAccepted: request.moveAccepted });
    case "week":
      return weekPreview(state, request.weekStart ? parseLocalDate(request.weekStart) : getWeekStart(now), now);
    case "today": {
      const date = request.date ?? localDateKey(now);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      switch (request.mode) {
        case "protect_sleep":
        case "crunch_mode":
          return previewFixMyDay(state, date, request.mode, { now });
        case "defer":
          return deferPreview(state, date, now, request.acceptLate === true, request.blockIds);
        case "calendar_conflicts": {
          const conflicts = calendarConflicts(state.scheduleBlocks, busyCalendarEvents(state), date, nowMinutes);
          return movesPreview(state, resolveCalendarConflicts(state.scheduleBlocks, conflicts, date, state.healthPrefs), "Clear calendar conflicts", "Nothing can move: there is no free slot between the conflicting events and bedtime today.", now);
        }
        case "do_not_schedule": {
          const conflicts = doNotScheduleConflicts(state.scheduleBlocks, state.recurringEvents, date);
          return movesPreview(state, resolveDoNotScheduleConflicts(state.scheduleBlocks, conflicts, date, state.healthPrefs), "Clear no-study-zone sessions", "Nothing can move: there is no free slot between the zone and bedtime today.", now);
        }
      }
    }
  }
}

/**
 * Preview editing a task (deadline, estimate, difficulty): the whole semester is re-planned from the edited task
 * and compared with the plan the student has now. Applying it saves the edit AND the new plan in one undoable
 * step. Null when the task no longer exists.
 */
export function previewTaskEdit(state: AppState, taskId: string, patch: Partial<Task>, now: Date = new Date()): ReplanPreview | null {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return null;
  const after: AppState = { ...state, tasks: state.tasks.map((candidate) => (candidate.id === taskId ? { ...candidate, ...patch } : candidate)) };
  const label = patch.dueDate !== undefined && patch.dueDate !== task.dueDate ? "Deadline change" : "Task change";
  return previewPlanChange(state, after, { now, label });
}

// ── Reducer ───────────────────────────────────────────────────

/** Actions that never invalidate the Undo snapshots (they ARE the plan changes / undo, or only refresh scores). */
const KEEPS_UNDO = new Set<Action["type"]>(["LOAD_STATE", "APPLY_REPLAN", "AUTO_REPLAN", "REGENERATE_WEEK", "UNDO_REPLAN", "BATCH_UPDATE_TASK_SCORES"]);

/** The plan inputs an automatic re-plan's Undo puts back together with the plan (AppState.inputsBeforeEdit). */
const UNDOABLE_INPUTS = ["classes", "recurringEvents", "healthPrefs", "semester", "userPrefs"] as const;

/** Edits of the task list the automatic re-plan's Undo reverts too (the task comes back out, or back in). */
const TASK_LIST_EDITS = new Set<Action["type"]>(["ADD_TASK", "UPDATE_TASK", "DELETE_TASK"]);

/** What the plan reads from outside calendar events, Google's and the iPhone's (reading the same events again is no change). */
function calendarKey(state: Pick<AppState, "googleCalendarEvents" | "deviceCalendarEvents">): string {
  return calendarEventsKey(busyCalendarEvents(state));
}

/** True when an action replaced the outside calendar events with different ones. */
function calendarEventsChanged(before: AppState, after: AppState): boolean {
  if (after.googleCalendarEvents === before.googleCalendarEvents && after.deviceCalendarEvents === before.deviceCalendarEvents) return false;
  return calendarKey(after) !== calendarKey(before);
}

/** How the task list changed between two versions of it (for the Undo UI). */
function taskEditOf(before: Task[], after: Task[]): NonNullable<ReplanSnapshot["taskEdit"]> {
  const beforeIds = new Set(before.map((task) => task.id));
  const afterIds = new Set(after.map((task) => task.id));
  const added = after.filter((task) => !beforeIds.has(task.id)).length;
  const removed = before.filter((task) => !afterIds.has(task.id)).length;
  if (added > 0 && removed === 0) return { kind: "added", count: added };
  if (removed > 0 && added === 0) return { kind: "removed", count: removed };
  return { kind: "changed", count: Math.max(1, changedTaskIds(before, after).size) };
}

/**
 * Actions after which no edit is left for the next automatic re-plan to absorb: they plan, restore or reset. A
 * syllabus import is its own undoable step (UNDO_SYLLABUS_IMPORT) and is never reverted by a re-plan's Undo.
 */
const CLEARS_EDITS = new Set<Action["type"]>([
  "LOAD_STATE", "APPLY_REPLAN", "AUTO_REPLAN", "REGENERATE_WEEK", "UNDO_REPLAN", "AUTO_BUILD_WEEK",
  "APPLY_SYLLABUS_IMPORT", "UNDO_SYLLABUS_IMPORT", "RESET_SEMESTER", "LOGOUT",
]);

/**
 * Exported for tests only; the app uses it through AppProvider.
 * Undo restores the tasks and schedule exactly as they were before a change, so once the student edits them
 * afterwards (completes a session, adds or edits a task, moves a block, changes a class...) an older snapshot would
 * silently throw that edit away: the snapshots are dropped instead.
 * An edit of a plan input (commitments, classes, sleep hours, semester, study settings, the task list) is also
 * remembered as it was before, until the automatic re-plan that follows absorbs it: that re-plan's Undo puts the input
 * back too, so undoing it never leaves a plan built for the new commitment under the old one, or a new task with no
 * sessions (or the reverse). The task list is remembered with the schedule it had; any other edit of the tasks or the
 * schedule in between (a session ticked done) forgets it, so an Undo never erases that edit. Outside calendar events
 * that changed (Google or the iPhone's calendars) are only flagged: they cannot be put back.
 */
export function reducer(state: AppState, action: Action): AppState {
  const next = reduceKeepingUndo(state, action);
  // Only for a state this call made. An action that changed nothing leaves the state, and its counts, as they were:
  // counting it on the state it was given would count it again every time React runs the reducer once more.
  if (next !== state) {
    studentEdits.set(next, studentEditsIn(state) + (isStudentAction(action) ? 1 : 0));
    stateReplacements.set(next, stateReplacementsIn(state) + (REPLACES_THE_STATE.has(action.type) ? 1 : 0));
  }
  return next;
}

function reduceKeepingUndo(state: AppState, action: Action): AppState {
  let next = reduce(state, action);
  if (next === state) return next;
  if (CLEARS_EDITS.has(action.type)) {
    if (next.inputsBeforeEdit) next = { ...next, inputsBeforeEdit: undefined };
  } else {
    const initial = state.inputsBeforeEdit ?? {};
    let record = initial;
    const edited = UNDOABLE_INPUTS.filter((key) => next[key] !== state[key] && !(key in record));
    if (edited.length > 0) record = Object.assign({}, record, ...edited.map((key) => ({ [key]: key === "semester" ? state.semester ?? null : state[key] })));
    if (TASK_LIST_EDITS.has(action.type)) {
      if (!record.tasks) record = { ...record, tasks: state.tasks, scheduleBlocks: state.scheduleBlocks };
    } else if (record.tasks && action.type !== "BATCH_UPDATE_TASK_SCORES" && (next.tasks !== state.tasks || next.scheduleBlocks !== state.scheduleBlocks)) {
      const { tasks: _tasks, scheduleBlocks: _blocks, ...rest } = record;
      record = rest;
    }
    if (!record.calendarChanged && calendarEventsChanged(state, next)) {
      record = { ...record, calendarChanged: true };
    }
    if (record !== initial) next = { ...next, inputsBeforeEdit: Object.keys(record).length > 0 ? record : undefined };
  }
  if (KEEPS_UNDO.has(action.type) || !next.undoSnapshots) return next;
  const edited = next.tasks !== state.tasks || next.scheduleBlocks !== state.scheduleBlocks ||
    UNDOABLE_INPUTS.some((key) => next[key] !== state[key]);
  return edited ? { ...next, undoSnapshots: undefined } : next;
}

/**
 * What a re-plan did to the sessions still to do. Skipped / missed / done sessions are history (the planner keeps them
 * as they are), and listing them would be noise.
 */
function pendingDiff(before: ScheduleBlock[], planned: AppState, now: Date, released: ReleasedSession[]): ReplanDiff {
  const live = (block: ScheduleBlock) => block.completionStatus === "pending";
  return diffPlans(before.filter(live), planned.scheduleBlocks.filter(live), { tasks: planned.tasks, recurringEvents: planned.recurringEvents, now, released });
}

/** `planned` with the "Plan updated for calendar changes" notice for what `diff` moved (it has no Undo). */
function withCalendarNotice(planned: AppState, diff: ReplanDiff, now: Date): AppState {
  return { ...planned, replanNotice: { label: CALENDAR_REPLAN_LABEL, summary: changeSummary(planned, { diff, next: planned }, now), at: now.toISOString() } };
}

/**
 * After an Undo: the plan it restores was made for the outside calendar events of that moment. When they changed since
 * (a Google sync, a new event in the iPhone's calendars), a restored session may now sit on one of them: the same
 * keep-everything-valid re-plan a calendar change runs moves just those, and the student is told (without an Undo:
 * the calendar cannot be put back). Nothing on a calendar event: the restore stays exact.
 */
function revalidateAgainstCalendar(state: AppState, now: Date): AppState {
  if (sessionsOnCalendarEvents(state.scheduleBlocks, busyCalendarEvents(state), now).length === 0) return state;
  const { next: planned, released } = planSemesterDetailed(state, { now, stable: true, keepAllValid: true });
  const diff = pendingDiff(state.scheduleBlocks, planned, now, released);
  return diff.moved.length + diff.removed.length > 0 ? withCalendarNotice(planned, diff, now) : planned;
}

/** "Plan updated for your new commitment": what the automatic re-plan absorbed, for the Undo UI. */
function autoReplanLabel(state: AppState, edits: AppState["inputsBeforeEdit"]): string {
  const keys = edits ? UNDOABLE_INPUTS.filter((key) => key in edits) : [];
  const taskEdit = edits?.tasks ? taskEditOf(edits.tasks, state.tasks) : undefined;
  if (keys.length + (taskEdit ? 1 : 0) > 1) return "Plan updated for your changes";
  if (taskEdit) {
    const s = taskEdit.count > 1 ? "s" : "";
    return taskEdit.kind === "added" ? `Plan updated for your new task${s}` : taskEdit.kind === "removed" ? `Plan updated for the task${s} you deleted` : `Plan updated for your task change${s}`;
  }
  if (keys.length === 0) return "Plan updated";
  switch (keys[0]) {
    case "recurringEvents":
      return (edits?.recurringEvents?.length ?? 0) < state.recurringEvents.length ? "Plan updated for your new commitment" : "Plan updated for your commitments";
    case "classes":
      return "Plan updated for your classes";
    case "healthPrefs":
      return "Plan updated for your sleep hours";
    case "semester":
      return "Plan updated for your semester dates";
    default:
      return "Plan updated for your study settings";
  }
}

function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LOAD_STATE":
      return { ...initialState, ...action.payload };

    case "COMPLETE_ONBOARDING":
      return { ...state, onboardingComplete: true };

    case "SET_SEMESTER": {
      if (action.payload === null) return { ...state, semester: undefined };
      const checked = validateSemester(action.payload);
      if (!checked.ok) return state;
      // Keep the profile's semester label in step (the profile lives in this state: the first edit creates it).
      const user = state.user?.currentSemester === checked.semester.name
        ? state.user
        : { id: "local", email: "", name: "", createdAt: new Date().toISOString(), ...state.user, currentSemester: checked.semester.name };
      return { ...state, semester: checked.semester, user };
    }

    case "APPLY_REPLAN": {
      const applied = withUndoSnapshot(state, { label: action.payload.label, at: action.payload.at }, action.payload.next);
      return annotateLatestSnapshot(applied, { summary: action.payload.summary, source: "manual" });
    }

    case "AUTO_REPLAN":
    case "REGENERATE_WEEK": {
      const now = action.payload?.now ?? new Date();
      const custom = action.type === "AUTO_REPLAN" ? action.payload : undefined;
      const { calendarChanged, ...edits } = state.inputsBeforeEdit ?? {};
      // Outside calendar events changed (a Google sync, the iPhone's calendars read again) and nothing else.
      const calendarOnly = Boolean(calendarChanged) && Object.keys(edits).length === 0;
      // Stable: what still works stays put and the tasks an edit touched are planned again. New study settings ask
      // for a different plan, so that one starts afresh. A calendar change alone re-plans only the sessions its events
      // now overlap: nothing else is reshuffled to make room.
      const { next: planned, released } = planSemesterDetailed(state, {
        weekStart: custom?.weekStart, now, stable: !edits.userPrefs, replanTaskIds: edits.tasks ? changedTaskIds(edits.tasks, state.tasks) : undefined,
        keepAllValid: calendarOnly,
      });
      // Only sessions still to do count as "changed". After a task-list edit it is compared with the schedule from
      // before that edit (a deleted task's sessions show as removed).
      const diff = pendingDiff(edits.scheduleBlocks ?? state.scheduleBlocks, planned, now, released);
      // Nothing the student would see moved: apply quietly (task states / plan alerts may still have been refreshed).
      if (!diff.changed) return planned;
      // A calendar change cannot be put back, so this update has no Undo of its own: when it moved or removed sessions
      // the student is told ("Plan updated for calendar changes"), and make-ups it only added are no news. The Undo
      // stack stays as it was: undoing an older change afterwards re-checks the restored plan against the calendar
      // (UNDO_REPLAN), so it can never put sessions back on top of the new events.
      if (calendarOnly) return diff.moved.length + diff.removed.length > 0 ? withCalendarNotice(planned, diff, now) : planned;
      // Only make-ups for missed work were added (no edit absorbed, nothing moved or removed): there is nothing to
      // undo. An Undo would take the make-ups away and leave the missed work unplanned, since no input changed that
      // would plan it again.
      const missedTasks = new Set(planned.scheduleBlocks.filter((block) => block.completionStatus === "missed" && block.taskId).map((block) => block.taskId));
      const onlyMakeUps = Object.keys(edits).length === 0 && diff.moved.length === 0 && diff.removed.length === 0 &&
        (diff.released?.length ?? 0) === 0 && diff.added.every((ref) => missedTasks.has(ref.taskId));
      if (onlyMakeUps) return planned;
      // The clean-up of a plan saved by 1.0.8, where an exam with an Exam Prep had its own suggestions AND the prep's: the
      // exam's go and the prep's mixed practice takes their place. That is no change of the student's to undo: Undo put
      // the double time back and the next re-plan removed it again, every time (1.0.9 audit).
      if (Object.keys(edits).length === 0 && diff.moved.length === 0 && (diff.released?.length ?? 0) === 0 && diff.removed.length > 0) {
        const plannedBy = examsPlannedByPrep(followExamDates(planned.tasks));
        const preps = new Set(plannedBy.values());
        const cleanUpOnly = diff.removed.every((ref) => plannedBy.has(ref.taskId ?? "")) &&
          diff.added.every((ref) => preps.has(ref.taskId ?? "") || missedTasks.has(ref.taskId));
        if (cleanUpOnly) return planned;
      }
      const applied = withUndoSnapshot(
        state,
        { label: custom?.label ?? autoReplanLabel(state, edits), at: now.toISOString() },
        { scheduleBlocks: planned.scheduleBlocks, tasks: planned.tasks, planAlerts: planned.planAlerts },
      );
      // The inputs as they were before the edit this re-plan absorbed: Undo puts them back with the plan.
      return annotateLatestSnapshot(applied, {
        summary: changeSummary(planned, { diff, next: planned }, now), source: "auto", ...edits,
        ...(edits.tasks ? { taskEdit: taskEditOf(edits.tasks, state.tasks) } : {}),
      });
    }

    case "UNDO_REPLAN": {
      const restored = undoLastChange(state);
      if (restored === state) return state;
      // A calendar notice from before described a plan that is gone now.
      return revalidateAgainstCalendar(restored.replanNotice ? { ...restored, replanNotice: undefined } : restored, action.now ?? new Date());
    }

    case "ADD_CLASS":
      return { ...state, classes: [...state.classes, action.payload] };

    case "REMOVE_CLASS":
      return {
        ...state,
        classes: state.classes.filter((c) => c.id !== action.payload),
      };

    case "ADD_RECURRING_EVENT":
      return { ...state, recurringEvents: [...state.recurringEvents, action.payload] };

    case "UPDATE_RECURRING_EVENT":
      return {
        ...state,
        recurringEvents: state.recurringEvents.map((e) =>
          e.id === action.payload.id ? action.payload : e
        ),
      };

    case "DELETE_RECURRING_EVENT":
      return {
        ...state,
        recurringEvents: state.recurringEvents.filter((e) => e.id !== action.payload),
      };

    case "ADD_TASK": {
      // Score the new task immediately
      const [scoredNew] = scoreTasks([action.payload]);
      return { ...state, tasks: [...state.tasks, scoredNew] };
    }

    case "UPDATE_TASK":
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.payload.id ? action.payload : t
        ),
      };

    case "BATCH_UPDATE_TASK_SCORES": {
      // action.payload: Task[] — update priorityScore for all tasks in one dispatch
      const scoreMap = new Map<string, number | undefined>(
        action.payload.map((t) => [t.id, t.priorityScore])
      );
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          scoreMap.has(t.id) ? { ...t, priorityScore: scoreMap.get(t.id) as number | undefined } : t
        ),
      };
    }

    case "DELETE_TASK":
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.payload),
        // Sessions still to do for a deleted task go with it; finished sessions stay as history.
        scheduleBlocks: state.scheduleBlocks.filter(
          (b) => !(b.taskId === action.payload && b.type === "study" && b.completionStatus !== "done"),
        ),
      };

    case "COMPLETE_TASK": {
      // Mark the task done (all of its estimated work counts as finished)
      const updatedTasks = state.tasks.map((t) =>
        t.id === action.payload
          ? { ...t, status: "done" as const, completedMinutes: Math.max(t.completedMinutes ?? 0, t.estimatedMinutes) }
          : t
      );
      // Its sessions so far (earlier, and today's that already began) are marked done as before. Sessions still ahead
      // are no longer needed: they go, instead of showing as done on days to come and counting toward those days' load.
      const now = action.now ?? new Date();
      const todayKey = localDateKey(now);
      const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const ahead = (b: ScheduleBlock) => b.type === "study" && b.completionStatus === "pending" && !b.startedAt &&
        (b.date > todayKey || (b.date === todayKey && b.startTime > nowHHMM));
      const updatedBlocks = state.scheduleBlocks
        .filter((b) => !(b.taskId === action.payload && ahead(b)))
        .map((b) => (b.taskId === action.payload ? { ...b, completionStatus: "done" as const, accepted: true } : b));
      return { ...state, tasks: updatedTasks, scheduleBlocks: updatedBlocks };
    }

    case "SET_SCHEDULE_BLOCKS":
      return { ...state, scheduleBlocks: action.payload };

    case "UPDATE_BLOCK":
      return changeBlock(state, action.payload.id, (b) => {
        const moved =
          (action.payload.date !== undefined && action.payload.date !== b.date) ||
          (action.payload.startTime !== undefined && action.payload.startTime !== b.startTime) ||
          (action.payload.endTime !== undefined && action.payload.endTime !== b.endTime);
        // A manual move/resize is a decision: re-planning must not put the block back.
        return { ...b, ...action.payload, ...(moved ? { userEdited: true } : {}) };
      });
    case "DELETE_BLOCK":
      return {
        ...state,
        scheduleBlocks: state.scheduleBlocks.filter((b) => b.id !== action.payload),
      };
    case "ACCEPT_BLOCK":
      return {
        ...state,
        scheduleBlocks: state.scheduleBlocks.map((b) =>
          b.id === action.payload ? { ...b, accepted: true } : b
        ),
      };

    case "COMPLETE_BLOCK":
      // The block's minutes are credited to its task ONCE (pending -> done). The task is only done when the
      // completed minutes cover its estimate; otherwise it stays scheduled and the planner keeps the rest.
      return changeBlock(state, action.payload, (b) => (
        b.completionStatus === "done" ? b : { ...b, completionStatus: "done" as const, accepted: true }
      ));

    case "UNCOMPLETE_BLOCK":
      return changeBlock(state, action.payload, (b) => (
        b.completionStatus === "done" ? { ...b, completionStatus: "pending" as const } : b
      ));

    case "SKIP_BLOCK":
      return changeBlock(state, action.payload, (b) => (
        b.completionStatus === "skipped" ? b : { ...b, completionStatus: "skipped" as const }
      ));

    case "PUSH_BLOCK": {
      const block = state.scheduleBlocks.find((candidate) => candidate.id === action.payload.blockId);
      if (!block || block.locked || block.completionStatus !== "pending") return state;
      const pushed = findPushedBlock(block, state.scheduleBlocks, action.payload.minutes ?? 30);
      if (!pushed) return state;
      return {
        ...state,
        scheduleBlocks: state.scheduleBlocks.map((candidate) => candidate.id === pushed.id ? pushed : candidate),
      };
    }

    case "SET_IF_THEN_PLAN":
      return {
        ...state,
        scheduleBlocks: state.scheduleBlocks.map((b) =>
          b.id === action.payload.blockId
            ? { ...b, ifThenPlan: action.payload.plan }
            : b
        ),
      };

    case "UPDATE_HEALTH_PREFS":
      return {
        ...state,
        healthPrefs: { ...state.healthPrefs, ...action.payload },
      };

    case "UPDATE_USER_PREFS":
      return {
        ...state,
        userPrefs: { ...state.userPrefs, ...action.payload },
      };

    case "UPDATE_NOTIFICATION_SETTINGS": {
      const notificationSettings = { ...state.notificationSettings, ...action.payload } as NotificationSettings;
      // Turning reminders off cancels the OS notifications (see notification-settings), so the blocks
      // must forget their notification ids or re-enabling would think they are still scheduled.
      const turnedOff = state.notificationSettings.enabled && !notificationSettings.enabled;
      return {
        ...state,
        notificationSettings,
        scheduleBlocks: turnedOff
          ? state.scheduleBlocks.map((b) => (b.notificationId ? { ...b, notificationId: undefined } : b))
          : state.scheduleBlocks,
      };
    }

    case "LOGOUT":
      // Back to a fresh install (signing out, deleting the account, or replacing another account's plan on this
      // iPhone). Returns the pristine initialState object itself: the persister never writes that (so nothing
      // reappears after a wipe), and the saved plan never sends it (lib/plan-snapshot.ts isPristineState).
      return initialState;

    case "UPDATE_USER":
      // The profile is part of the plan on this iPhone (there is no separate server-side profile to load), so the
      // first profile edit (e.g. choosing a semester) creates a minimal local one.
      return {
        ...state,
        user: {
          id: "local",
          email: "",
          name: "",
          currentSemester: "",
          createdAt: new Date().toISOString(),
          ...state.user,
          ...action.payload,
        },
      };

    case "UPDATE_CLASS":
      return {
        ...state,
        classes: state.classes.map((c) =>
          c.id === action.payload.id ? action.payload : c
        ),
      };

    case "SET_CLASSES":
      return { ...state, classes: action.payload };

    case "ADD_GRADE":
      return { ...state, grades: [...state.grades, action.payload] };

    case "UPDATE_GRADE":
      return {
        ...state,
        grades: state.grades.map((g) =>
          g.id === action.payload.id ? action.payload : g
        ),
      };

    case "DELETE_GRADE":
      return {
        ...state,
        grades: state.grades.filter((g) => g.id !== action.payload),
      };

    case "SET_RECOMMENDATIONS":
      return { ...state, recommendations: action.payload };

    case "RESET_SEMESTER":
      // Everything that belongs to the term goes: classes, work, plan, grades AND the imported syllabi plus the
      // study material generated from them (a reset that kept the old syllabi looked like it had not worked).
      // Preferences, the sleep window, notification settings and the calendars (Google link, iPhone calendars) stay.
      return {
        ...state,
        semester: undefined,
        undoSnapshots: undefined,
        replanNotice: undefined,
        planAlerts: undefined,
        classes: [],
        tasks: [],
        scheduleBlocks: [],
        grades: [],
        recommendations: [],
        recurringEvents: [],
        examPreps: [],
        syllabusImports: [],
        studyGuides: [],
        practiceExams: [],
      };

    case "ADD_EXAM_PREP":
      return { ...state, examPreps: [...(state.examPreps || []), action.payload] };

    case "UPDATE_EXAM_PREP":
      return {
        ...state,
        examPreps: (state.examPreps || []).map((e) =>
          e.id === action.payload.id ? action.payload : e
        ),
      };

    case "DELETE_EXAM_PREP":
      return {
        ...state,
        examPreps: (state.examPreps || []).filter((e) => e.id !== action.payload),
      };

    case "UPDATE_EXAM_TOPIC_MASTERY": {
      const { examId, topicId, mastery } = action.payload;
      return {
        ...state,
        examPreps: (state.examPreps || []).map((ep) =>
          ep.id === examId
            ? {
                ...ep,
                topics: ep.topics.map((t) =>
                  t.id === topicId
                    ? { ...t, mastery, reviewCount: t.reviewCount + 1, lastReviewedAt: new Date().toISOString() }
                    : t
                ),
              }
            : ep
        ),
      };
    }

    case "ADD_BLOCK":
      return { ...state, scheduleBlocks: [...state.scheduleBlocks, action.payload] };

    case "AUTO_BUILD_WEEK":
      // Stable: the first build has nothing to keep; importing another course keeps the plan of the others.
      return planSemester(state, { weekStart: action.payload?.weekStart, now: action.payload?.now, stable: true });

    case "BUILD_WEEK_FOR": {
      const targetWeekStart = action.payload.weekStart;
      const targetWeekDates = Array.from({ length: 7 }, (_, i) => addDaysToKey(localDateKey(targetWeekStart), i));
      // Only auto-build if the week has no non-sleep blocks yet
      const existingBlocksBWF = state.scheduleBlocks.filter(
        (b) => targetWeekDates.includes(b.date) && b.type !== "sleep"
      );
      if (existingBlocksBWF.length > 0) return state;
      // A week inside the planned horizon is part of the semester plan: if it already has its structure (sleep)
      // it has nothing to show, otherwise the semester plan is (re)built. Only weeks beyond the horizon are built alone.
      const horizon = getPlanningHorizon(state, action.payload.now ?? new Date());
      if (weekStartsInRange(horizon.startKey, horizon.endKey).includes(localDateKey(targetWeekStart))) {
        return state.scheduleBlocks.some((b) => targetWeekDates.includes(b.date))
          ? state
          : planSemester(state, { now: action.payload.now, stable: true });
      }
      const plan = buildWeekPlan(state, targetWeekStart, { preserveAccepted: false, preserveLocked: true, now: action.payload.now });
      return { ...state, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks };
    }

    case "ADD_STUDY_GUIDE":
      return { ...state, studyGuides: [...(state.studyGuides || []), action.payload] };

    case "DELETE_STUDY_GUIDE":
      return {
        ...state,
        studyGuides: (state.studyGuides || []).filter((g) => g.id !== action.payload),
        practiceExams: (state.practiceExams || []).filter((e) => e.studyGuideId !== action.payload),
      };

    case "ADD_PRACTICE_EXAM":
      return { ...state, practiceExams: [...(state.practiceExams || []), action.payload] };

    case "DELETE_PRACTICE_EXAM":
      return {
        ...state,
        practiceExams: (state.practiceExams || []).filter((e) => e.id !== action.payload),
      };

    case "ADD_SYLLABUS_IMPORT":
      return {
        ...state,
        syllabusImports: [action.payload, ...(state.syllabusImports || [])],
      };

    case "APPLY_SYLLABUS_IMPORT": {
      const applied = applySyllabusImport(state, action.payload);
      // The semester goes through SET_SEMESTER so its validation and the profile's semester label stay the planner's.
      return action.payload.semester && applied.semester ? reducer(applied, { type: "SET_SEMESTER", payload: applied.semester }) : applied;
    }

    case "UNDO_SYLLABUS_IMPORT":
      return undoSyllabusImport(state, action.payload);

    case "DELETE_SYLLABUS_IMPORT":
      return {
        ...state,
        syllabusImports: (state.syllabusImports || []).filter((i) => i.id !== action.payload),
      };

    case "SET_GOOGLE_CALENDAR_EVENTS": {
      // Deduplicate events by ID to prevent duplicate key errors in rendering
      const seenIds = new Set<string>();
      const dedupedEvents = action.payload.events.filter((e) => {
        if (seenIds.has(e.id)) return false;
        seenIds.add(e.id);
        return true;
      });
      return {
        ...state,
        googleCalendarEvents: dedupedEvents,
        googleCalendarConnected: action.payload.connected,
        googleCalendarLastSync: action.payload.lastSync,
      };
    }

    case "SET_GOOGLE_CALENDAR_CONNECTED": {
      return {
        ...state,
        googleCalendarConnected: action.payload,
        googleCalendarEvents: action.payload ? state.googleCalendarEvents : [],
      };
    }

    case "CLEAR_GOOGLE_CALENDAR": {
      return {
        ...state,
        googleCalendarEvents: [],
        googleCalendarConnected: false,
        googleCalendarLastSync: undefined,
      };
    }

    case "SET_DEVICE_CALENDAR_EVENTS": {
      // One entry per occurrence id (lib/device-calendars.ts makes them unique; a duplicate would break list keys).
      const seenIds = new Set<string>();
      const events: GoogleCalendarEventLocal[] = [];
      for (const event of action.payload) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        events.push(event.source === "device" ? event : { ...event, source: "device" });
      }
      return { ...state, deviceCalendarEvents: events };
    }

    case "CLEAR_DEVICE_CALENDAR_EVENTS":
      return (state.deviceCalendarEvents?.length ?? 0) === 0 ? state : { ...state, deviceCalendarEvents: [] };

    default:
      return state;
  }
}
