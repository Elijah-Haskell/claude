import { describe, expect, it } from "vitest";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { generateWeekSchedule } from "../../src/engine/scheduler";
import { getAwakeWindow, getPlanningWindow, LAST_MINUTE_OF_DAY } from "../../src/engine/awake-window";
import { findPushedBlock } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, ScheduleBlock } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import { makeBlock, makeClass, makeTask, NOW, schedState, TODAY } from "./scheduler-fixtures";

const prefs = (bedtime: string, wakeTime: string) => ({ ...DEFAULT_HEALTH_PREFS, bedtime, wakeTime });
const openDays = { ...DEFAULT_USER_PREFS, noGoZones: [] };

describe("awake window [wake, bedtime) may cross midnight", () => {
  it("treats a bedtime at or before the wake time as the next day", () => {
    expect(getAwakeWindow("07:00", "23:00")).toEqual({ wakeMinutes: 420, bedMinutes: 1380, crossesMidnight: false });
    expect(getAwakeWindow("08:00", "00:30")).toEqual({ wakeMinutes: 480, bedMinutes: 1470, crossesMidnight: true });
    expect(getAwakeWindow("08:00", "01:00")).toEqual({ wakeMinutes: 480, bedMinutes: 1500, crossesMidnight: true });
    expect(getAwakeWindow("04:30", "21:30")).toEqual({ wakeMinutes: 270, bedMinutes: 1290, crossesMidnight: false });
  });

  it("caps the planning window at 23:55 so a session never wraps past midnight", () => {
    expect(getPlanningWindow("07:00", "23:00")).toEqual({ start: 450, end: 1350 });
    expect(getPlanningWindow("07:00", "23:59")).toEqual({ start: 450, end: 1409 });
    expect(getPlanningWindow("08:00", "00:30")).toEqual({ start: 510, end: LAST_MINUTE_OF_DAY });
    expect(getPlanningWindow("08:00", "01:00")).toEqual({ start: 510, end: LAST_MINUTE_OF_DAY });
  });
});

describe("bedtime after midnight used to yield 0 blocks", () => {
  const cases: Array<{ bed: string; wake: string; latestEnd: string }> = [
    { bed: "23:00", wake: "07:00", latestEnd: "22:30" },
    { bed: "23:59", wake: "07:00", latestEnd: "23:29" },
    { bed: "00:30", wake: "08:00", latestEnd: "23:55" },
    { bed: "01:00", wake: "08:00", latestEnd: "23:55" },
  ];

  for (const { bed, wake, latestEnd } of cases) {
    it(`bedtime ${bed} / wake ${wake}: plans the work inside [wake+30, ${latestEnd}]`, () => {
      const task = makeTask({ estimatedMinutes: 180, dueDate: "2030-03-18" });
      const result = scheduleTasksIntelligently(
        [task],
        schedState({ healthPrefs: prefs(bed, wake), userPrefs: openDays }),
        undefined,
        undefined,
        { now: NOW },
      );

      expect(result.scheduledBlocks.length).toBeGreaterThan(0);
      expect(result.shortfalls).toEqual([]);
      expect(result.scheduledBlocks.reduce((sum, b) => sum + b.durationMinutes, 0)).toBe(180);
      for (const block of result.scheduledBlocks) {
        expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(timeToMinutes(wake) + 30);
        expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(timeToMinutes(latestEnd));
        expect(timeToMinutes(block.endTime)).toBeGreaterThan(timeToMinutes(block.startTime)); // never wraps past midnight
      }
    });

    it(`bedtime ${bed}: when the day is busy until 20:00, the evening before bedtime is used`, () => {
      const task = makeTask({ estimatedMinutes: 120, dueDate: "2030-03-15" });
      const busyUntilEvening = { ...DEFAULT_USER_PREFS, noGoZones: [{ startTime: "00:00", endTime: "20:00" }] };
      const result = scheduleTasksIntelligently(
        [task],
        schedState({ healthPrefs: prefs(bed, wake), userPrefs: busyUntilEvening }),
        undefined,
        undefined,
        { now: NOW },
      );

      expect(result.shortfalls).toEqual([]);
      expect(result.scheduledBlocks.length).toBeGreaterThan(0);
      for (const block of result.scheduledBlocks) {
        expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(20 * 60);
        expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(timeToMinutes(latestEnd));
      }
    });
  }

  it("a very early riser (wake 04:30, bed 21:30) can use the early morning", () => {
    const task = makeTask({ estimatedMinutes: 60, dueDate: "2030-03-15" });
    const earlyOnly = { ...DEFAULT_USER_PREFS, noGoZones: [{ startTime: "08:00", endTime: "23:59" }] };
    const result = scheduleTasksIntelligently(
      [task],
      schedState({ healthPrefs: prefs("21:30", "04:30"), userPrefs: earlyOnly }),
      undefined,
      undefined,
      { now: NOW },
    );

    expect(result.shortfalls).toEqual([]);
    for (const block of result.scheduledBlocks) {
      expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(5 * 60); // wake 04:30 + 30
      expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(8 * 60);
    }
  });

  it("a very early riser is also confined to their own window at the late end", () => {
    const task = makeTask({ estimatedMinutes: 400, dueDate: "2030-03-13" });
    const result = scheduleTasksIntelligently(
      [task],
      schedState({ healthPrefs: prefs("21:30", "04:30"), userPrefs: openDays }),
      undefined,
      undefined,
      { now: NOW },
    );
    for (const block of result.scheduledBlocks) {
      expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(21 * 60);
    }
  });

  it("the structural week keeps one sleep block per night, including a bedtime after midnight", () => {
    const blocks = generateWeekSchedule(
      { classes: [makeClass()], recurringEvents: [], healthPrefs: prefs("00:30", "08:00"), userPrefs: openDays },
      new Date(2030, 2, 11),
    );
    const sleep = blocks.filter((b) => b.type === "sleep");
    expect(sleep).toHaveLength(7);
    expect(sleep.every((b) => b.startTime === "00:30" && b.endTime === "08:00")).toBe(true);
    // a post-class transition is still produced (window end was -30 before)
    expect(blocks.filter((b) => b.type === "buffer").length).toBeGreaterThan(0);
  });

  it("pushing a study block later is allowed in the evening when bedtime is after midnight", () => {
    const sleep: ScheduleBlock = makeBlock({ id: "sleep", type: "sleep", title: "Sleep", startTime: "00:30", endTime: "08:00", locked: true });
    const study = makeBlock({ id: "study", startTime: "20:00", endTime: "21:00", accepted: false });
    const pushed = findPushedBlock(study, [study, sleep], 30);
    expect(pushed?.startTime).toBe("20:30");
  });
});

describe("no sleep-window regression", () => {
  it("still stays inside wake+30 .. bedtime-30 for the default 07:00/23:00 window", () => {
    const task = makeTask({ estimatedMinutes: 300, dueDate: "2030-03-20" });
    const result = scheduleTasksIntelligently([task], schedState({ userPrefs: openDays }), undefined, undefined, { now: NOW });
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    for (const block of result.scheduledBlocks) {
      expect(timeToMinutes(block.startTime)).toBeGreaterThanOrEqual(7 * 60 + 30);
      expect(timeToMinutes(block.endTime)).toBeLessThanOrEqual(22 * 60 + 30);
    }
    expect(TODAY).toBe("2030-03-13");
  });
});
