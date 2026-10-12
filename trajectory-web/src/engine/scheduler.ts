// ============================================================
// Trajectory Scheduling Engine
// Structural week (sleep window, classes, recurring commitments) plus the
// "Fix my day" re-flow. Study placement lives in intelligent-scheduler.ts.
// ============================================================

import {
  AppState,
  DayOfWeek,
  HealthPreferences,
  ScheduleBlock,
  Semester,
  BLOCK_COLORS,
} from "./types";
import { timeToMinutes, minutesToTime, addDaysToKey, getWeekStart, localDateKey, formatTime } from "./utils";
import { LAST_MINUTE_OF_DAY, getAwakeWindow, getPlanningWindow } from "./awake-window";
import { Interval } from "./busy-windows";
import { DAILY_STUDY_CAP } from "./intelligent-scheduler";
import { isClassDay } from "./semester";

const DAY_ORDER: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Meals and workouts were removed from the product. Blocks of those types can
 * still exist in state persisted by older versions: drop them when loading.
 */
export function stripLegacyBlocks(blocks: ScheduleBlock[]): ScheduleBlock[] {
  return blocks.filter((block) => (block.type as string) !== "meal" && (block.type as string) !== "workout");
}

// ── Main scheduling function ──────────────────────────────────

/**
 * The structural week: one sleep block per night, the class meetings (with a
 * transition after each) and recurring commitments. Study sessions are placed
 * by scheduleTasksIntelligently / buildWeekPlan, not here.
 *
 * When the state carries a `semester`, class meetings (and the transition after each) are only generated
 * from its start date to its end date and never on a break day. Sleep and recurring commitments are
 * unaffected. Without a semester every week has every class (older saves).
 *
 * `tasks` and `goals` are still accepted so older call sites keep compiling but
 * they are ignored.
 */
export function generateWeekSchedule(
  state: Pick<AppState, "classes" | "recurringEvents" | "healthPrefs" | "userPrefs"> & { tasks?: unknown; goals?: unknown; semester?: Semester },
  weekStartDate?: Date,
  now: Date = new Date(),
): ScheduleBlock[] {
  const weekStart = localDateKey(weekStartDate ?? getWeekStart(now));
  const blocks: ScheduleBlock[] = [];
  const dateFor = (day: DayOfWeek) => addDaysToKey(weekStart, DAY_ORDER.indexOf(day));

  const { end: dayWindowEnd } = getPlanningWindow(state.healthPrefs.wakeTime, state.healthPrefs.bedtime);

  // ── Step 1: Sleep blocks (bedtime -> wake; may start after midnight) ──
  for (const day of DAY_ORDER) {
    blocks.push({
      id: `sleep-${dateFor(day)}`,
      type: "sleep",
      title: "Sleep",
      date: dateFor(day),
      startTime: state.healthPrefs.bedtime,
      endTime: state.healthPrefs.wakeTime,
      locked: true,
      accepted: true,
      color: BLOCK_COLORS.sleep,
      completionStatus: "pending",
      whatCountsAsDone: `${state.healthPrefs.sleepTargetHours} hours of quality sleep`,
    });
  }

  // ── Step 2: Class blocks ──────────────────────────────────
  for (const cls of state.classes) {
    if (!cls.startTime || !cls.endTime) continue;
    for (const day of cls.days) {
      const date = dateFor(day);
      if (!isClassDay(state.semester, date)) continue;
      const endMin = timeToMinutes(cls.endTime);

      blocks.push({
        id: `class-${cls.id}-${date}`,
        type: "class",
        title: cls.name,
        date,
        startTime: cls.startTime,
        endTime: cls.endTime,
        locked: true,
        accepted: true,
        courseId: cls.id,
        color: cls.color,
        completionStatus: "pending",
        whatCountsAsDone: "Attend class and take notes",
        startRitual: "Review last class notes for 2 minutes before entering",
      });

      // Buffer after class (15 min)
      const bufferEnd = Math.min(endMin + 15, dayWindowEnd);
      if (bufferEnd > endMin) {
        blocks.push({
          id: `buffer-${cls.id}-${date}`,
          type: "buffer",
          title: "Transition",
          date,
          startTime: cls.endTime,
          endTime: minutesToTime(bufferEnd),
          locked: false,
          accepted: true,
          color: BLOCK_COLORS.buffer,
          completionStatus: "pending",
        });
      }
    }
  }

  // ── Step 3: Recurring events ──────────────────────────────
  for (const event of state.recurringEvents) {
    // doNotSchedule events block the time (the solver reads them) but don't appear as a visible block
    if (event.doNotSchedule) continue;
    for (const day of event.days) {
      blocks.push({
        id: `recurring-${event.id}-${dateFor(day)}`,
        type: "recurring",
        title: event.title,
        date: dateFor(day),
        startTime: event.startTime,
        endTime: event.endTime,
        locked: event.locked,
        accepted: true,
        color: event.color,
        completionStatus: "pending",
        whatCountsAsDone: `Complete ${event.title}`,
      });
    }
  }

  return blocks;
}

// ── Fix My Day: re-place what is still movable ────────────────

export interface FixMyDayOptions {
  /** Clock injection (defaults to `new Date()`). */
  now?: Date;
  /** Blocks the user has started (treated as in progress and never moved), besides `block.startedAt`. */
  startedBlockIds?: string[];
  /**
   * The minute of `date` a movable session must end by (its task's deadline that day, lib/task-kind.ts taskDeadline):
   * undefined when nothing is due that day, null when it can no longer be placed at all (its quiz / exam has taken
   * place). A session that does not fit before it is left unplaced ("won't fit"), never moved past it.
   */
  latestEndFor?: (block: ScheduleBlock) => number | null | undefined;
  /** More busy time on `date` that has no block of its own: the no-study zones and calendar events the planner avoids. */
  busy?: Interval[];
  /**
   * Most study sessions the day may hold (default DAILY_STUDY_CAP, the planner's cap). A missed session is brought back
   * only while the day's finished, started and kept sessions leave room; the rest stay missed, reported in `unplaced`
   * (1.0.9 audit: a day with 4 sessions and a missed one ended with 5).
   */
  maxSessions?: number;
}

export interface FixMyDayMove {
  id: string;
  title: string;
  from: { startTime: string; endTime: string };
  to: { startTime: string; endTime: string };
  /** True when the block was in the past and unfinished, so it is being re-placed after now. */
  wasMissed: boolean;
}

export interface FixMyDayUnplaced {
  block: ScheduleBlock;
  reason: string;
}

export interface FixMyDayResult {
  /** Every input block (none is ever dropped), with moved blocks at their new times. */
  blocks: ScheduleBlock[];
  moved: FixMyDayMove[];
  /** Movable blocks that found no slot. They stay in `blocks` (un-accepted, flagged) so the UI can ask what to do. */
  unplaced: FixMyDayUnplaced[];
}

const GAP_MINUTES = 5;

function findFreeSlot(occupied: Interval[], from: number, until: number, duration: number): number | null {
  const sorted = [...occupied].sort((a, b) => a.startMinutes - b.startMinutes);
  let cursor = from;
  for (const slot of sorted) {
    if (slot.endMinutes <= cursor) continue;
    if (slot.startMinutes - cursor >= duration) break;
    cursor = Math.max(cursor, slot.endMinutes);
  }
  return cursor + duration <= until ? cursor : null;
}

function blockInterval(block: ScheduleBlock): Interval {
  const start = timeToMinutes(block.startTime);
  const end = timeToMinutes(block.endTime);
  // A block that wraps past midnight occupies the rest of its own day.
  return { startMinutes: start, endMinutes: end > start ? end : 24 * 60 };
}

/**
 * Re-plan the rest of a day.
 *
 *  - Only planner-made study sessions (study blocks linked to a task) that are
 *    still pending, unlocked and untouched by the user can move. Classes,
 *    recurring commitments, work shifts, user-created events, locked and
 *    edited blocks, blocks already started (or in progress right now) and
 *    finished blocks stay exactly where they are and are treated as busy time.
 *  - Sessions that are still ahead of `now` and conflict-free stay put; missed
 *    sessions (earlier today, unfinished) and conflicting ones are placed in the
 *    earliest free gap after `now`. Nothing is ever placed before `now`.
 *  - `protect_sleep` ends the day 30 min before bedtime; `crunch_mode` also uses
 *    that last half hour but stops AT bedtime (never past 23:55): study never
 *    lands in the sleep window.
 *  - With `latestEndFor` a session never ends after its task's deadline, and `busy` (no-study zones, calendar
 *    events) is avoided like any fixed block.
 *  - Nothing is dropped: sessions with no slot are reported in `unplaced` and kept in `blocks` at their old time,
 *    which stays taken: nothing else is moved on top of them.
 *  - The day never goes past `maxSessions` study sessions: missed sessions (earliest first) are only brought back while
 *    its finished, started and kept sessions leave room (one that can no longer be placed before its deadline takes
 *    none). The others stay missed and are reported in `unplaced`.
 */
export function fixMyDayDetailed(
  blocks: ScheduleBlock[],
  date: string,
  mode: "protect_sleep" | "crunch_mode",
  healthPrefs: HealthPreferences,
  options: FixMyDayOptions = {},
): FixMyDayResult {
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  if (date < todayKey) return { blocks: [...blocks], moved: [], unplaced: [] };

  const isToday = date === todayKey;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const started = new Set(options.startedBlockIds ?? []);

  const planning = getPlanningWindow(healthPrefs.wakeTime, healthPrefs.bedtime);
  const awake = getAwakeWindow(healthPrefs.wakeTime, healthPrefs.bedtime);
  const windowEnd = mode === "protect_sleep"
    ? planning.end
    : Math.min(awake.bedMinutes, LAST_MINUTE_OF_DAY);
  const earliest = isToday ? Math.ceil((nowMinutes + GAP_MINUTES) / 5) * 5 : planning.start;

  const dayBlocks = blocks.filter((block) => block.date === date && (block.type as string) !== "sleep");
  const isMovable = (block: ScheduleBlock): boolean => {
    if (block.type !== "study" || !block.taskId) return false;
    if (block.locked || block.userEdited || block.startedAt || started.has(block.id)) return false;
    if (block.completionStatus !== "pending" && block.completionStatus !== "missed") return false;
    const start = timeToMinutes(block.startTime);
    const end = timeToMinutes(block.endTime);
    if (isToday && start <= nowMinutes && nowMinutes < end) return false; // in progress right now
    return true;
  };

  const movable = dayBlocks
    .filter(isMovable)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime) || a.id.localeCompare(b.id));
  const movableIds = new Set(movable.map((block) => block.id));
  /** The latest minute a session may end today: the end of the day, or its deadline when that comes first (-1: never). */
  const limitOf = (block: ScheduleBlock): number => {
    const latest = options.latestEndFor?.(block);
    if (latest === null) return -1;
    return latest === undefined ? windowEnd : Math.min(windowEnd, latest);
  };
  // A missed session (it ended earlier today, or was recorded as missed) comes back only while the day has room for it:
  // its finished, started and kept sessions count, and the earliest missed one comes back first. One that can no longer
  // be placed at all (its quiz has taken place, its deadline has passed) takes no room: it stays missed for its own
  // reason (1.0.9 audit: it kept a missed session that could come back out, and the day ended with 3).
  const maxSessions = options.maxSessions ?? DAILY_STUDY_CAP;
  const isRevival = (block: ScheduleBlock) => block.completionStatus === "missed" || (isToday && timeToMinutes(block.endTime) <= nowMinutes);
  const canStillFit = (block: ScheduleBlock) => limitOf(block) - earliest >= Math.max(1, timeToMinutes(block.endTime) - timeToMinutes(block.startTime));
  let room = maxSessions - dayBlocks.filter((block) => block.type === "study" &&
    (block.completionStatus === "done" || (block.completionStatus === "pending" && !(movableIds.has(block.id) && isRevival(block))))).length;
  const overCap = new Set<string>();
  for (const block of movable) {
    if (!isRevival(block) || !canStillFit(block)) continue;
    if (room > 0) room -= 1;
    else overCap.add(block.id);
  }
  const placeable = movable.filter((block) => !overCap.has(block.id));
  const fixed: Interval[] = [
    ...dayBlocks.filter((block) => (!movableIds.has(block.id) || overCap.has(block.id)) && block.completionStatus !== "skipped").map(blockInterval),
    ...(options.busy ?? []),
  ];

  interface Plan { placements: Map<string, { start: number; end: number }>; unplaced: ScheduleBlock[] }

  const place = (candidates: ScheduleBlock[], busy: Interval[], keepers: Map<string, { start: number; end: number }>): Plan => {
    const occupied = [...busy];
    const placements = new Map(keepers);
    const unplaced: ScheduleBlock[] = [];
    for (const keeper of keepers.values()) occupied.push({ startMinutes: keeper.start, endMinutes: keeper.end + GAP_MINUTES });
    for (const block of candidates) {
      const duration = Math.max(1, timeToMinutes(block.endTime) - timeToMinutes(block.startTime));
      const until = limitOf(block);
      // Stay as close to the planned time as possible: try at/after the original start first, then anywhere after now.
      const wanted = Math.max(earliest, timeToMinutes(block.startTime));
      const start = findFreeSlot(occupied, wanted, until, duration) ?? findFreeSlot(occupied, earliest, until, duration);
      if (start === null) {
        unplaced.push(block);
        continue;
      }
      placements.set(block.id, { start, end: start + duration });
      occupied.push({ startMinutes: start, endMinutes: start + duration + GAP_MINUTES });
    }
    return { placements, unplaced };
  };

  // Stage 1: leave conflict-free future sessions where they are; re-place the rest.
  const keepFirst = (candidates: ScheduleBlock[], busy: Interval[]): Plan => {
    const keepers = new Map<string, { start: number; end: number }>();
    const toPlace: ScheduleBlock[] = [];
    const claimed: Interval[] = [...busy];
    for (const block of candidates) {
      const start = timeToMinutes(block.startTime);
      const end = timeToMinutes(block.endTime);
      const inFuture = start >= earliest;
      const fits = end > start && end <= limitOf(block);
      const clash = claimed.some((slot) => start < slot.endMinutes && slot.startMinutes < end);
      if (inFuture && fits && !clash) {
        keepers.set(block.id, { start, end });
        claimed.push({ startMinutes: start, endMinutes: end + GAP_MINUTES });
      } else {
        toPlace.push(block);
      }
    }
    return place(toPlace, busy, keepers);
  };
  // Stage 2: let every movable session flow forward from `earliest`.
  const compress = (candidates: ScheduleBlock[], busy: Interval[]): Plan => place(candidates, busy, new Map());

  // A session that does not fit stays where it was, so its time is taken too: nothing else may be moved on top of it
  // (the preview used to show a clean day that the Undo bar then called "1 conflict").
  const settle = (strategy: (candidates: ScheduleBlock[], busy: Interval[]) => Plan): Plan => {
    let stuck: ScheduleBlock[] = [];
    for (;;) {
      const stuckIds = new Set(stuck.map((block) => block.id));
      const rest = strategy(placeable.filter((block) => !stuckIds.has(block.id)), [...fixed, ...stuck.map(blockInterval)]);
      if (rest.unplaced.length === 0) return { placements: rest.placements, unplaced: stuck };
      stuck = [...stuck, ...rest.unplaced];
    }
  };
  let plan = settle(keepFirst);
  // Only when something still has no slot is compressing the day worth trying.
  if (plan.unplaced.length > 0) {
    const compressed = settle(compress);
    if (compressed.unplaced.length < plan.unplaced.length) plan = compressed;
  }

  const moved: FixMyDayMove[] = [];
  const unplacedIds = new Set(plan.unplaced.map((block) => block.id));
  const reasonFor = (block: ScheduleBlock): string => {
    const until = limitOf(block);
    if (until <= 0) return "There is no time left before its deadline.";
    if (until <= earliest) return `It was due at ${formatTime(minutesToTime(until))}.`;
    if (until < windowEnd) return `It is due at ${formatTime(minutesToTime(until))} and there is no free slot left before then.`;
    const past = isToday && timeToMinutes(block.endTime) <= nowMinutes;
    const room = mode === "protect_sleep" ? "before your wind-down time" : "before bedtime";
    return past
      ? `Missed earlier and no free slot is left ${room}. Move it to another day or drop it.`
      : `No free slot is left ${room}. Move it to another day or drop it.`;
  };
  const unplaced: FixMyDayUnplaced[] = [];

  const fullDay = `${isToday ? "Today" : "That day"} already has ${maxSessions} study sessions.`;
  const result = blocks.map((block) => {
    if (!movableIds.has(block.id)) return block;
    if (overCap.has(block.id)) {
      const flagged: ScheduleBlock = { ...block, accepted: false, completionStatus: "missed", schedulingReason: fullDay };
      unplaced.push({ block: flagged, reason: fullDay });
      return flagged;
    }
    if (unplacedIds.has(block.id)) {
      const wasMissed = isToday && timeToMinutes(block.endTime) <= nowMinutes;
      const flagged: ScheduleBlock = {
        ...block,
        accepted: false,
        completionStatus: wasMissed ? "missed" : block.completionStatus,
        schedulingReason: reasonFor(block),
      };
      unplaced.push({ block: flagged, reason: reasonFor(block) });
      return flagged;
    }
    const target = plan.placements.get(block.id);
    if (!target) return block;
    const newStart = minutesToTime(target.start);
    const newEnd = minutesToTime(target.end);
    if (newStart === block.startTime && newEnd === block.endTime) {
      return block.completionStatus === "pending" ? block : { ...block, completionStatus: "pending" as const };
    }
    moved.push({
      id: block.id,
      title: block.title,
      from: { startTime: block.startTime, endTime: block.endTime },
      to: { startTime: newStart, endTime: newEnd },
      wasMissed: isToday && timeToMinutes(block.endTime) <= nowMinutes,
    });
    return { ...block, startTime: newStart, endTime: newEnd, completionStatus: "pending" as const };
  });

  moved.sort((a, b) => a.to.startTime.localeCompare(b.to.startTime));
  return { blocks: result, moved, unplaced };
}

/**
 * Compatibility wrapper: the re-planned blocks only. Nothing is dropped; use
 * `fixMyDayDetailed` when you need to show what moved and what did not fit.
 */
export function fixMyDay(
  blocks: ScheduleBlock[],
  date: string,
  mode: "protect_sleep" | "crunch_mode",
  healthPrefs: HealthPreferences,
  now?: Date,
): ScheduleBlock[] {
  return fixMyDayDetailed(blocks, date, mode, healthPrefs, { now }).blocks;
}
