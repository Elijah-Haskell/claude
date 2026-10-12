import { describe, expect, it } from "vitest";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { buildBusyMap, splitOvernight } from "../../src/engine/busy-windows";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, GoogleCalendarEventLocal, RecurringEvent } from "../../src/engine/types";
import { getWeekStart, timeToMinutes } from "../../src/engine/utils";
import { makeBlock, makeClass, makeTask, NOW, overlaps, schedState } from "./scheduler-fixtures";

const gcal = (overrides: Partial<GoogleCalendarEventLocal>): GoogleCalendarEventLocal => ({
  id: `g-${Math.random().toString(36).slice(2)}`,
  calendarId: "primary",
  title: "Event",
  startDate: "2030-03-14",
  isAllDay: false,
  isRecurring: false,
  status: "active",
  syncedAt: "2030-03-01T00:00:00.000Z",
  ...overrides,
});
const recurring = (overrides: Partial<RecurringEvent>): RecurringEvent => ({
  id: "rec",
  title: "Club",
  days: ["Mon"],
  startTime: "13:00",
  endTime: "17:00",
  color: "#111111",
  locked: true,
  ...overrides,
});
const open = { ...DEFAULT_USER_PREFS, noGoZones: [] };
const solveWith = (over: Parameters<typeof schedState>[0], minutes = 240, due = "2030-03-19") =>
  scheduleTasksIntelligently([makeTask({ estimatedMinutes: minutes, dueDate: due })], schedState({ userPrefs: open, ...over }), undefined, undefined, { now: NOW });
const overlapsWindow = (block: { date: string; startTime: string; endTime: string }, date: string, start: string, end: string) =>
  block.date === date && timeToMinutes(block.startTime) < timeToMinutes(end) && timeToMinutes(start) < timeToMinutes(block.endTime);

describe("Google Calendar events are fixed busy windows for the task solver", () => {
  it("a timed event blocks exactly its hours", () => {
    const result = solveWith({ googleCalendarEvents: [gcal({ startDate: "2030-03-14", endDate: "2030-03-14", startTime: "10:00", endTime: "16:00" })] });
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result.scheduledBlocks.some((b) => overlapsWindow(b, "2030-03-14", "10:00", "16:00"))).toBe(false);
  });

  it("an all-day event blocks the whole day", () => {
    // Google's all-day end date is exclusive: 03-14 .. 03-15 is ONE day
    const result = solveWith({ googleCalendarEvents: [gcal({ isAllDay: true, startDate: "2030-03-14", endDate: "2030-03-15" })] }, 600);
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-14")).toBe(false);
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-15" || b.date === "2030-03-13")).toBe(true);
  });

  it("a multi-day all-day event (a trip) blocks every day it covers but not the day after", () => {
    const trip = gcal({ isAllDay: true, startDate: "2030-03-14", endDate: "2030-03-17" }); // Thu, Fri, Sat
    const map = buildBusyMap(["2030-03-13", "2030-03-14", "2030-03-15", "2030-03-16", "2030-03-17"], {
      classes: [], recurringEvents: [], scheduleBlocks: [], noGoZones: [], googleCalendarEvents: [trip],
    });
    expect(map["2030-03-13"]).toEqual([]);
    for (const day of ["2030-03-14", "2030-03-15", "2030-03-16"]) expect(map[day]).toEqual([{ startMinutes: 0, endMinutes: 1440 }]);
    expect(map["2030-03-17"]).toEqual([]);
    const result = solveWith({ googleCalendarEvents: [trip] }, 300, "2030-03-19");
    expect(result.scheduledBlocks.some((b) => ["2030-03-14", "2030-03-15", "2030-03-16"].includes(b.date))).toBe(false);
  });

  it("a multi-day timed event blocks the tail of the first day, the full middle days and the head of the last", () => {
    const conference = gcal({ startDate: "2030-03-14", endDate: "2030-03-16", startTime: "20:00", endTime: "09:00" });
    const map = buildBusyMap(["2030-03-14", "2030-03-15", "2030-03-16"], { classes: [], recurringEvents: [], scheduleBlocks: [], noGoZones: [], googleCalendarEvents: [conference] });
    expect(map["2030-03-14"]).toEqual([{ startMinutes: 1200, endMinutes: 1440 }]);
    expect(map["2030-03-15"]).toEqual([{ startMinutes: 0, endMinutes: 1440 }]);
    expect(map["2030-03-16"]).toEqual([{ startMinutes: 0, endMinutes: 540 }]);
  });

  it("an event that runs past midnight busies the start of the next day", () => {
    const late = gcal({ startDate: "2030-03-14", endDate: "2030-03-15", startTime: "22:00", endTime: "01:30" });
    const map = buildBusyMap(["2030-03-14", "2030-03-15"], { classes: [], recurringEvents: [], scheduleBlocks: [], noGoZones: [], googleCalendarEvents: [late] });
    expect(map["2030-03-14"]).toEqual([{ startMinutes: 1320, endMinutes: 1440 }]);
    expect(map["2030-03-15"]).toEqual([{ startMinutes: 0, endMinutes: 90 }]);
  });

  it("cancelled events, and events without a start date, are ignored; an event with no end time lasts an hour", () => {
    const map = buildBusyMap(["2030-03-14"], {
      classes: [], recurringEvents: [], scheduleBlocks: [], noGoZones: [],
      googleCalendarEvents: [
        gcal({ status: "cancelled", startDate: "2030-03-14", startTime: "09:00", endTime: "12:00" }),
        gcal({ startDate: "" }),
        gcal({ startDate: "2030-03-14", startTime: "15:00" }),
      ],
    });
    expect(map["2030-03-14"]).toEqual([{ startMinutes: 900, endMinutes: 960 }]);
  });

  it("buildWeekPlan passes googleCalendarEvents to the solver", () => {
    const plan = buildWeekPlan(
      {
        classes: [], recurringEvents: [], tasks: [makeTask({ estimatedMinutes: 480, dueDate: "2030-03-15" })], scheduleBlocks: [],
        healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: open,
        googleCalendarEvents: [gcal({ startDate: "2030-03-14", endDate: "2030-03-14", startTime: "08:00", endTime: "20:00" })],
      },
      getWeekStart(NOW),
      { now: NOW },
    );
    const study = plan.scheduleBlocks.filter((b) => b.type === "study");
    expect(study.length).toBeGreaterThan(0);
    expect(study.some((b) => overlapsWindow(b, "2030-03-14", "08:00", "20:00"))).toBe(false);
  });

  it("events read from the iPhone's calendars are busy time too, next to Google's", () => {
    const plan = buildWeekPlan(
      {
        classes: [], recurringEvents: [], tasks: [makeTask({ estimatedMinutes: 480, dueDate: "2030-03-15" })], scheduleBlocks: [],
        healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: open,
        googleCalendarEvents: [gcal({ startDate: "2030-03-13", endDate: "2030-03-13", startTime: "12:00", endTime: "22:00" })],
        deviceCalendarEvents: [gcal({ id: "shift@2030-03-14", source: "device", startDate: "2030-03-14", endDate: "2030-03-14", startTime: "08:00", endTime: "20:00" })],
      },
      getWeekStart(NOW),
      { now: NOW },
    );
    const study = plan.scheduleBlocks.filter((b) => b.type === "study");
    expect(study.length).toBeGreaterThan(0);
    expect(study.some((b) => overlapsWindow(b, "2030-03-14", "08:00", "20:00"))).toBe(false);
    expect(study.some((b) => overlapsWindow(b, "2030-03-13", "12:00", "22:00"))).toBe(false);
  });
});

describe("recurring commitments, classes and no-go zones are fixed busy windows", () => {
  it("recurring events keep their hours free on every matching day", () => {
    const result = solveWith({ recurringEvents: [recurring({ days: ["Wed", "Thu", "Fri"], startTime: "08:00", endTime: "20:00" })] }, 240, "2030-03-19");
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    for (const day of ["2030-03-13", "2030-03-14", "2030-03-15"]) {
      expect(result.scheduledBlocks.some((b) => overlapsWindow(b, day, "08:00", "20:00"))).toBe(false);
    }
  });

  it("a doNotSchedule recurring commitment still blocks time (it is only hidden from the calendar)", () => {
    const result = solveWith({ recurringEvents: [recurring({ days: ["Thu"], startTime: "07:00", endTime: "23:00", doNotSchedule: true })] }, 60, "2030-03-14");
    expect(result.scheduledBlocks.every((b) => b.date !== "2030-03-14")).toBe(true);
  });

  it("overnight windows (a 22:00-06:00 shift, an overnight no-go zone) are split across midnight", () => {
    expect(splitOvernight("22:00", "06:00")).toEqual({
      sameDay: [{ startMinutes: 1320, endMinutes: 1440 }],
      nextDay: [{ startMinutes: 0, endMinutes: 360 }],
    });
    expect(splitOvernight("09:00", "10:00")).toEqual({ sameDay: [{ startMinutes: 540, endMinutes: 600 }], nextDay: [] });
    expect(splitOvernight("09:00", "09:00")).toEqual({ sameDay: [], nextDay: [] });

    const map = buildBusyMap(["2030-03-11", "2030-03-12"], {
      classes: [], scheduleBlocks: [], noGoZones: [],
      recurringEvents: [recurring({ days: ["Mon"], startTime: "22:00", endTime: "06:00" })],
    });
    expect(map["2030-03-11"]).toEqual([{ startMinutes: 1320, endMinutes: 1440 }]);
    expect(map["2030-03-12"]).toEqual([{ startMinutes: 0, endMinutes: 360 }]);

    // a shift that began the evening BEFORE the first planned date still spills into it
    const spill = buildBusyMap(["2030-03-12"], { classes: [], scheduleBlocks: [], noGoZones: [], recurringEvents: [recurring({ days: ["Mon"], startTime: "22:00", endTime: "06:00" })] });
    expect(spill["2030-03-12"]).toEqual([{ startMinutes: 0, endMinutes: 360 }]);
  });

  it("an overnight no-go zone with a wake time inside it keeps the morning free of study too", () => {
    const result = scheduleTasksIntelligently(
      [makeTask({ estimatedMinutes: 60, dueDate: "2030-03-15" })],
      schedState({ userPrefs: { ...DEFAULT_USER_PREFS, noGoZones: [{ startTime: "22:00", endTime: "09:00" }] } }),
      undefined,
      undefined,
      { now: NOW },
    );
    for (const block of result.scheduledBlocks) {
      expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(9 * 60);
      expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(22 * 60);
    }
  });

  it("classes on every date of a multi-week horizon are honoured (not just the first week)", () => {
    const cls = makeClass({ days: ["Mon"], startTime: "08:00", endTime: "22:00" });
    const result = scheduleTasksIntelligently(
      [makeTask({ estimatedMinutes: 300, dueDate: "2030-03-25" })],
      schedState({ classes: [cls], userPrefs: open }),
      undefined,
      undefined,
      { now: NOW },
    );
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result.scheduledBlocks.every((b) => b.date !== "2030-03-18" && b.date !== "2030-03-25")).toBe(true);
  });

  it("locked/accepted schedule blocks and ad-hoc busy slots block time; finished or skipped ones do not", () => {
    const fixed = makeBlock({ id: "shift", type: "work", date: "2030-03-14", startTime: "08:00", endTime: "22:00", locked: true, accepted: true });
    const finished = makeBlock({ id: "old", type: "work", date: "2030-03-15", startTime: "08:00", endTime: "22:00", completionStatus: "done" });
    const skipped = makeBlock({ id: "skip", type: "study", date: "2030-03-16", startTime: "08:00", endTime: "22:00", completionStatus: "skipped" });
    const adHoc = { date: "2030-03-18", startTime: "08:00", endTime: "22:00" };
    const result = solveWith({ scheduleBlocks: [fixed, finished, skipped] }, 480, "2030-03-18");
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-14")).toBe(false);
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-15" || b.date === "2030-03-16")).toBe(true);

    const withAdHoc = scheduleTasksIntelligently([makeTask({ estimatedMinutes: 120, dueDate: "2030-03-18" })], schedState({ userPrefs: open }), undefined, [adHoc], { now: NOW });
    expect(withAdHoc.scheduledBlocks.some((b) => overlaps(b, { ...adHoc }))).toBe(false);
  });

  it("legacy meal/workout blocks and sleep blocks in state never block study time", () => {
    const legacy = [
      makeBlock({ id: "meal", type: "meal" as never, date: "2030-03-14", startTime: "07:30", endTime: "22:00", accepted: true }),
      makeBlock({ id: "sleep", type: "sleep", date: "2030-03-14", startTime: "23:00", endTime: "07:00", locked: true }),
    ];
    const result = scheduleTasksIntelligently(
      [makeTask({ estimatedMinutes: 60, dueDate: "2030-03-14", notBeforeDate: "2030-03-14" })],
      schedState({ userPrefs: open, scheduleBlocks: legacy }),
      undefined,
      undefined,
      { now: NOW },
    );
    expect(result.shortfalls).toEqual([]);
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-14")).toBe(true);
  });
});
