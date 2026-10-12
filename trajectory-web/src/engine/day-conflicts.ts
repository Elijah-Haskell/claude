// Today's clashes the plan can fix locally (pure): blocks that overlap an upcoming outside calendar event (a synced
// Google event or one read from the iPhone's calendars: callers pass busyCalendarEvents(state)), and blocks sitting
// inside a recurring "do not schedule" zone. Each finder has a resolver that returns the moves (new start / end on the
// same day) the Replan sheet previews before anything is applied.
// Moved out of the Today screen so the preview and the tests use the same rules.
// A move never lands in the student's sleep window: it stays inside the same planning window the planner uses
// (lib/awake-window.ts getPlanningWindow: from 30 min after waking to 30 min before bedtime, never past midnight),
// also when bedtime is after midnight.

import { DEFAULT_HEALTH_PREFS, type DayOfWeek, type GoogleCalendarEventLocal, type HealthPreferences, type RecurringEvent, type ScheduleBlock } from "./types";
import { getDurationMinutes, localDateKey, timeToMinutes } from "./utils";
import { getPlanningWindow, type PlanningWindow } from "./awake-window";
import { addGoogleCalendarBusy, DAY_MINUTES, type BusyMap } from "./busy-windows";

/** A block's new slot on the same day. */
export interface BlockMove {
  id: string;
  startTime: string;
  endTime: string;
}

export interface CalendarConflict {
  gcalEvent: GoogleCalendarEventLocal;
  block: ScheduleBlock;
}

export interface ZoneConflict {
  block: ScheduleBlock;
  zone: RecurringEvent;
}

/** The student's sleep window (`healthPrefs`); the default one when a caller has none. */
export type SleepWindow = Pick<HealthPreferences, "wakeTime" | "bedtime">;

const WEEKDAYS: DayOfWeek[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The day's plan as the Today timeline shows it (no sleep / buffer rows). */
function visibleBlocks(blocks: ScheduleBlock[], date: string): ScheduleBlock[] {
  return blocks.filter((b) => b.date === date && b.type !== "sleep" && b.type !== "buffer");
}

/**
 * Timed calendar events on `date` that start after `nowMinutes`, earliest first. Only events that end the same day: a
 * timed event running into another day (an overnight trip) has no free slot "after it" today, and the planner already
 * keeps study off its whole span (lib/busy-windows.ts).
 */
export function upcomingCalendarEvents(events: GoogleCalendarEventLocal[], date: string, nowMinutes: number): GoogleCalendarEventLocal[] {
  return events
    .filter((e) => !e.isAllDay && e.startDate && e.startTime && e.startDate.slice(0, 10) === date && (!e.endDate || e.endDate.slice(0, 10) === date) &&
      e.status !== "cancelled" && timeToMinutes(e.startTime) > nowMinutes)
    .sort((a, b) => timeToMinutes(a.startTime!) - timeToMinutes(b.startTime!));
}

/**
 * Open study sessions still ahead (not started) that sit on an outside calendar event, with the planner's own reading
 * of busy time (lib/busy-windows.ts addGoogleCalendarBusy: all-day events cover their days, multi-day events their
 * whole span). Used after an Undo: the plan it puts back was made for the calendar as it was then.
 */
export function sessionsOnCalendarEvents(blocks: readonly ScheduleBlock[], events: GoogleCalendarEventLocal[], now: Date): ScheduleBlock[] {
  if (events.length === 0) return [];
  const today = localDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const span = (block: Pick<ScheduleBlock, "startTime" | "endTime">): [number, number] => {
    const start = timeToMinutes(block.startTime);
    const end = timeToMinutes(block.endTime);
    return [start, end > start ? end : DAY_MINUTES];
  };
  const open = blocks.filter((block) =>
    block.type === "study" && block.completionStatus === "pending" && !block.startedAt &&
    (block.date > today || (block.date === today && span(block)[1] > nowMinutes)));
  if (open.length === 0) return [];
  const busy: BusyMap = {};
  for (const block of open) busy[block.date] = [];
  addGoogleCalendarBusy(busy, events);
  return open.filter((block) => {
    const [start, end] = span(block);
    return (busy[block.date] ?? []).some((interval) => start < interval.endMinutes && interval.startMinutes < end);
  });
}

/**
 * Every (event, block) pair that overlaps on `date`, for study sessions still to do that the Fix can move. A class or
 * commitment that is also in the student's calendar is the same appointment, not a clash, and a locked or finished
 * session stays put: reporting those only showed a conflict the Fix then said it could not move.
 */
export function calendarConflicts(blocks: ScheduleBlock[], events: GoogleCalendarEventLocal[], date: string, nowMinutes: number): CalendarConflict[] {
  const dayBlocks = visibleBlocks(blocks, date).filter((block) => block.type === "study" && block.completionStatus === "pending" && !block.locked);
  return upcomingCalendarEvents(events, date, nowMinutes).flatMap((gcalEvent) => {
    if (!gcalEvent.startTime || !gcalEvent.endTime) return [];
    const start = timeToMinutes(gcalEvent.startTime);
    const end = timeToMinutes(gcalEvent.endTime);
    return dayBlocks
      .filter((block) => timeToMinutes(block.startTime) < end && timeToMinutes(block.endTime) > start)
      .map((block) => ({ gcalEvent, block }));
  });
}

/**
 * Walk forward from `from` until the block fits without overlapping anything else on the day (jumping past the
 * block in the way each time). Sleep counts as busy: the block never starts before `window.start` nor ends after
 * `window.end`. Null when nothing fits before bedtime.
 */
function firstFreeStart(block: ScheduleBlock, from: number, others: ScheduleBlock[], window: PlanningWindow, stepMinutes: number, attempts: number): number | null {
  const duration = getDurationMinutes(block.startTime, block.endTime);
  let candidate = Math.max(from, window.start);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidateEnd = candidate + duration;
    if (candidateEnd > window.end) return null;
    const blockers = others.filter((b) => b.id !== block.id && timeToMinutes(b.startTime) < candidateEnd && timeToMinutes(b.endTime) > candidate);
    if (blockers.length === 0) return candidate;
    const latestEnd = Math.max(...blockers.map((b) => timeToMinutes(b.endTime)));
    candidate = latestEnd > candidate ? latestEnd : candidate + stepMinutes;
  }
  return null;
}

/** Shared walk: move each block (in start order) past `after(conflict)`, keeping later checks aware of earlier moves. */
function resolve<C extends { block: ScheduleBlock }>(
  blocks: ScheduleBlock[],
  conflicts: C[],
  date: string,
  after: (conflict: C) => number | null,
  sleep: SleepWindow,
  stepMinutes: number,
  attempts: number,
): BlockMove[] {
  const window = getPlanningWindow(sleep.wakeTime, sleep.bedtime);
  let day = blocks.filter((b) => b.date === date).map((b) => ({ ...b }));
  const moves = new Map<string, BlockMove>();
  const ordered = [...conflicts].sort((a, b) => timeToMinutes(a.block.startTime) - timeToMinutes(b.block.startTime));
  for (const conflict of ordered) {
    const { block } = conflict;
    // Locked and finished blocks are never moved (the student fixed them in place / already did them).
    if (moves.has(block.id) || block.locked || block.completionStatus === "done") continue;
    const from = after(conflict);
    if (from === null) continue;
    const start = firstFreeStart(block, from, day, window, stepMinutes, attempts);
    if (start === null) continue;
    const move = { id: block.id, startTime: toHHMM(start), endTime: toHHMM(start + getDurationMinutes(block.startTime, block.endTime)) };
    moves.set(block.id, move);
    day = day.map((b) => (b.id === block.id ? { ...b, startTime: move.startTime, endTime: move.endTime } : b));
  }
  return [...moves.values()];
}

/**
 * Move each block that clashes with a calendar event to the first free slot after that event and before bedtime
 * (`sleep`: the student's healthPrefs).
 */
export function resolveCalendarConflicts(blocks: ScheduleBlock[], conflicts: CalendarConflict[], date: string, sleep: SleepWindow = DEFAULT_HEALTH_PREFS): BlockMove[] {
  return resolve(blocks, conflicts, date, (c) => (c.gcalEvent.endTime ? timeToMinutes(c.gcalEvent.endTime) : null), sleep, 30, 24);
}

/** Blocks planned inside a recurring "do not schedule" zone on `date`. */
export function doNotScheduleConflicts(blocks: ScheduleBlock[], recurringEvents: RecurringEvent[], date: string): ZoneConflict[] {
  const zones = recurringEvents.filter((r) => r.doNotSchedule);
  if (zones.length === 0) return [];
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00`).getDay()]!;
  const dayBlocks = visibleBlocks(blocks, date);
  const results: ZoneConflict[] = [];
  for (const zone of zones) {
    if (!zone.days.includes(weekday)) continue;
    const zoneStart = timeToMinutes(zone.startTime);
    const zoneEnd = timeToMinutes(zone.endTime);
    for (const block of dayBlocks) {
      if (block.type === "recurring" || block.type === "sleep") continue;
      if (timeToMinutes(block.startTime) < zoneEnd && timeToMinutes(block.endTime) > zoneStart) results.push({ block, zone });
    }
  }
  return results;
}

/**
 * Move each block out of its zone to the first free slot after the zone ends and before bedtime (`sleep`: the
 * student's healthPrefs).
 */
export function resolveDoNotScheduleConflicts(blocks: ScheduleBlock[], conflicts: ZoneConflict[], date: string, sleep: SleepWindow = DEFAULT_HEALTH_PREFS): BlockMove[] {
  return resolve(blocks, conflicts, date, (c) => timeToMinutes(c.zone.endTime), sleep, 15, 48);
}

/** Apply moves the way a manual edit does: the block keeps its new slot through later re-plans (userEdited). */
export function applyBlockMoves(blocks: ScheduleBlock[], moves: BlockMove[]): ScheduleBlock[] {
  if (moves.length === 0) return blocks;
  const byId = new Map(moves.map((move) => [move.id, move]));
  return blocks.map((block) => {
    const move = byId.get(block.id);
    return move ? { ...block, startTime: move.startTime, endTime: move.endTime, userEdited: true } : block;
  });
}
