// Shared fixtures for the tests/scheduler-*.test.ts files (not a test file itself).
import type { SchedulerState } from "../../src/engine/intelligent-scheduler";
import {
  ClassBlock,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_USER_PREFS,
  ScheduleBlock,
  Task,
} from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";

/** A wall-clock moment in the PROCESS time zone (tests run under several TZ values). */
export function localMoment(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** Wed 2030-03-13 12:00 local. Monday of that week is 2030-03-11. */
export const TODAY = "2030-03-13";
export const NOW = localMoment(2030, 3, 13, 12, 0);

export function schedState(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    classes: [],
    recurringEvents: [],
    scheduleBlocks: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    ...overrides,
  };
}

let counter = 0;
export function makeTask(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `task-${counter}`,
    name: "Chemistry problem set",
    courseId: "chem",
    courseName: "Chemistry",
    dueDate: "2030-03-18",
    estimatedMinutes: 60,
    difficulty: 3,
    requiresOnCampus: false,
    status: "pending",
    createdAt: "2030-03-01T12:00:00.000Z",
    ...overrides,
  };
}

export function makeClass(overrides: Partial<ClassBlock> = {}): ClassBlock {
  return {
    id: "chem",
    name: "Chemistry",
    days: ["Mon", "Wed", "Fri"],
    startTime: "10:00",
    endTime: "11:00",
    color: "#4F6EF7",
    ...overrides,
  };
}

export function makeBlock(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  counter += 1;
  return {
    id: `block-${counter}`,
    type: "study",
    title: "Study",
    date: TODAY,
    startTime: "15:00",
    endTime: "16:00",
    locked: false,
    accepted: true,
    color: "#4F6EF7",
    completionStatus: "pending",
    ...overrides,
  };
}

export const minutesBetween = (start: string, end: string) => timeToMinutes(end) - timeToMinutes(start);

export function overlaps(a: { date: string; startTime: string; endTime: string }, b: { date: string; startTime: string; endTime: string }): boolean {
  return a.date === b.date && timeToMinutes(a.startTime) < timeToMinutes(b.endTime) && timeToMinutes(b.startTime) < timeToMinutes(a.endTime);
}

/** No two blocks overlap (same date). */
export function expectNoOverlaps(blocks: Array<{ date: string; startTime: string; endTime: string }>): string | null {
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (overlaps(blocks[i]!, blocks[j]!)) return `${blocks[i]!.date} ${blocks[i]!.startTime}-${blocks[i]!.endTime} overlaps ${blocks[j]!.startTime}-${blocks[j]!.endTime}`;
    }
  }
  return null;
}
