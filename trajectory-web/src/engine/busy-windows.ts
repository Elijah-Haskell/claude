import type { ClassBlock, GoogleCalendarEventLocal, RecurringEvent, ScheduleBlock } from "./types";
import { addDaysToKey, daysBetweenKeys, timeToMinutes, weekdayOfKey } from "./utils";

export interface Interval {
  startMinutes: number;
  endMinutes: number;
}

/** Where a busy interval comes from (see buildBusyMap). */
export type BusySource = "class" | "recurring" | "no-go" | "block" | "calendar" | "extra";

/** A busy interval that remembers what it is, so a conflict can be named ("clashes with Job shift"). */
export interface LabeledInterval extends Interval {
  source?: BusySource;
  label?: string;
}

export const DAY_MINUTES = 24 * 60;

/** Busy intervals per "YYYY-MM-DD" date, in minutes after local midnight. Intervals built here carry a source/label. */
export type BusyMap = Record<string, LabeledInterval[]>;

/**
 * A [startTime, endTime) window that ends at or before it starts is overnight
 * (a 22:00-06:00 shift, a 22:00-07:00 no-go zone): it busies the rest of its own
 * day and the start of the next day.
 */
export function splitOvernight(startTime: string, endTime: string): { sameDay: Interval[]; nextDay: Interval[] } {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (end > start) return { sameDay: [{ startMinutes: start, endMinutes: end }], nextDay: [] };
  if (end === start) return { sameDay: [], nextDay: [] };
  return {
    sameDay: [{ startMinutes: start, endMinutes: DAY_MINUTES }],
    nextDay: end > 0 ? [{ startMinutes: 0, endMinutes: end }] : [],
  };
}

type Tag = { source?: BusySource; label?: string };

function push(map: BusyMap, date: string, interval: Interval, tag?: Tag): void {
  const list = map[date];
  if (list && interval.endMinutes > interval.startMinutes) list.push(tag ? { ...interval, ...tag } : interval);
}

/** Mark a dated time window busy (handles overnight windows). Dates outside the map are ignored. */
export function addBusyWindow(map: BusyMap, date: string, startTime: string, endTime: string, tag?: Tag): void {
  const { sameDay, nextDay } = splitOvernight(startTime, endTime);
  for (const interval of sameDay) push(map, date, interval, tag);
  for (const interval of nextDay) push(map, addDaysToKey(date, 1), interval, tag);
}

/**
 * Outside calendar events as busy windows: synced Google Calendar events and the events read from the iPhone's
 * calendars (lib/device-calendars.ts maps those to the same shape; all-day ones arrive only when the student counts
 * them as busy).
 *  - Cancelled events are ignored.
 *  - All-day events busy the WHOLE day. Google's all-day `endDate` is exclusive
 *    (a one-day event has endDate = startDate + 1), so a 3-day trip covers 3 days.
 *  - Timed events are busy for their real span; multi-day timed events busy the
 *    tail of the first day, every full day between, and the head of the last day.
 *    A timed event with no end time is assumed to last an hour.
 */
export function addGoogleCalendarBusy(map: BusyMap, events: GoogleCalendarEventLocal[] | undefined, labels = false): void {
  for (const event of events ?? []) {
    if (!event || event.status === "cancelled" || !event.startDate) continue;
    const tag: Tag | undefined = labels ? { source: "calendar", label: event.title || "Calendar event" } : undefined;
    const startDate = event.startDate.slice(0, 10);
    const endDateRaw = (event.endDate ?? event.startDate).slice(0, 10);
    const endDate = endDateRaw < startDate ? startDate : endDateRaw;

    if (event.isAllDay || !event.startTime) {
      const lastDay = event.isAllDay && endDate > startDate ? addDaysToKey(endDate, -1) : endDate;
      const span = Math.min(400, Math.max(0, daysBetweenKeys(startDate, lastDay)));
      for (let i = 0; i <= span; i += 1) push(map, addDaysToKey(startDate, i), { startMinutes: 0, endMinutes: DAY_MINUTES }, tag);
      continue;
    }

    const startMinutes = timeToMinutes(event.startTime);
    const endMinutes = event.endTime ? timeToMinutes(event.endTime) : startMinutes + 60;
    if (endDate === startDate) {
      addBusyWindow(map, startDate, event.startTime, event.endTime ?? minutesToClock(startMinutes + 60), tag);
      continue;
    }
    const span = Math.min(400, daysBetweenKeys(startDate, endDate));
    for (let i = 0; i <= span; i += 1) {
      const date = addDaysToKey(startDate, i);
      if (i === 0) push(map, date, { startMinutes, endMinutes: DAY_MINUTES }, tag);
      else if (i === span) push(map, date, { startMinutes: 0, endMinutes }, tag);
      else push(map, date, { startMinutes: 0, endMinutes: DAY_MINUTES }, tag);
    }
  }
}

function minutesToClock(minutes: number): string {
  const wrapped = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

export interface BusySources {
  classes: Array<Pick<ClassBlock, "days" | "startTime" | "endTime"> & { name?: string }>;
  recurringEvents: Array<Pick<RecurringEvent, "days" | "startTime" | "endTime"> & { title?: string }>;
  /** Existing schedule blocks. Sleep, legacy meal/workout blocks and finished/skipped/missed blocks never busy time. */
  scheduleBlocks: ScheduleBlock[];
  /** Outside calendar events: Google and iPhone calendars together (pass busyCalendarEvents(state), lib/calendar-events.ts). */
  googleCalendarEvents?: GoogleCalendarEventLocal[];
  extraOccupied?: Array<{ date: string; startTime: string; endTime: string }>;
  noGoZones: Array<{ startTime: string; endTime: string }>;
  /** When set, a class only busies the dates for which this returns true (semester start/end and breaks). */
  isClassDay?: (date: string) => boolean;
}

const NEVER_BUSY_TYPES = new Set(["sleep", "meal", "workout"]);

function blocksTime(block: ScheduleBlock): boolean {
  if (NEVER_BUSY_TYPES.has(block.type)) return false;
  if (block.completionStatus === "done" || block.completionStatus === "skipped" || block.completionStatus === "missed") return false;
  return Boolean(block.accepted || block.locked || block.startedAt || block.userEdited);
}

/**
 * Everything that is NOT available for study, per date: classes, recurring
 * commitments, no-go zones, existing accepted/locked blocks, Google Calendar
 * events and ad-hoc busy slots. Sleep is modelled separately by the awake window.
 * With `labels`, every interval also says what it is (source + label), for naming conflicts.
 */
export function buildBusyMap(dates: string[], sources: BusySources, options: { labels?: boolean } = {}): BusyMap {
  const map: BusyMap = {};
  for (const date of dates) map[date] = [];
  const tag = (source: BusySource, label?: string): Tag | undefined => (options.labels ? { source, label } : undefined);

  // Start one day early so an overnight window that began the evening before the first date still spills in.
  const recurringDates = dates.length > 0 ? [addDaysToKey(dates[0], -1), ...dates] : dates;
  for (const date of recurringDates) {
    const weekday = weekdayOfKey(date);
    for (const cls of sources.classes) {
      if (!cls.startTime || !cls.endTime || !cls.days.includes(weekday)) continue;
      if (sources.isClassDay && !sources.isClassDay(date)) continue;
      addBusyWindow(map, date, cls.startTime, cls.endTime, tag("class", cls.name || "Class"));
    }
    for (const event of sources.recurringEvents) {
      if (!event.days.includes(weekday)) continue;
      addBusyWindow(map, date, event.startTime, event.endTime, tag("recurring", event.title || "Commitment"));
    }
    for (const zone of sources.noGoZones) addBusyWindow(map, date, zone.startTime, zone.endTime, tag("no-go", "No-study zone"));
  }

  for (const block of sources.scheduleBlocks) {
    if (!map[block.date] || !blocksTime(block)) continue;
    addBusyWindow(map, block.date, block.startTime, block.endTime, tag("block", block.title));
  }
  addGoogleCalendarBusy(map, sources.googleCalendarEvents, options.labels);
  for (const slot of sources.extraOccupied ?? []) addBusyWindow(map, slot.date, slot.startTime, slot.endTime, tag("extra"));
  return map;
}
