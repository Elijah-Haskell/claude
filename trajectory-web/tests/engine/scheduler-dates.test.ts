import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import {
  addDays,
  addDaysToKey,
  dateKeyOf,
  daysBetweenKeys,
  getWeekStart,
  localDateKey,
  parseLocalDate,
  todayString,
  toDateString,
  weekdayOfKey,
  weekStartKeyOf,
} from "../../src/engine/utils";
import { assessPlanQuality } from "../../src/engine/plan-quality";
import { getSemesterWorkloadWarnings } from "../../src/engine/workload-analysis";
import { computePriorityScore } from "../../src/engine/priority-engine";
import { localMoment, makeTask, schedState, TODAY } from "./scheduler-fixtures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("local calendar date keys (bug: toISOString() returned the UTC date)", () => {
  it("keeps the local date late in the evening (US evenings used to become 'tomorrow')", () => {
    expect(localDateKey(localMoment(2030, 3, 13, 23, 30))).toBe("2030-03-13");
    expect(localDateKey(localMoment(2030, 3, 13, 20, 0))).toBe("2030-03-13");
  });

  it("keeps the local date early in the morning (UTC+ mornings used to become 'yesterday')", () => {
    expect(localDateKey(localMoment(2030, 3, 13, 0, 30))).toBe("2030-03-13");
    expect(localDateKey(localMoment(2030, 3, 13, 7, 0))).toBe("2030-03-13");
  });

  it("toDateString and todayString follow the local calendar", () => {
    vi.setSystemTime(localMoment(2030, 3, 13, 22, 45));
    expect(toDateString(new Date())).toBe("2030-03-13");
    expect(todayString()).toBe("2030-03-13");
    vi.setSystemTime(localMoment(2030, 3, 14, 6, 15));
    expect(todayString()).toBe("2030-03-14");
    expect(todayString(localMoment(2030, 12, 31, 23, 59))).toBe("2030-12-31");
  });

  it("parseLocalDate returns local midnight and round-trips through localDateKey", () => {
    for (const key of ["2030-01-01", "2030-03-10", "2030-03-31", "2030-04-07", "2030-10-27", "2030-12-31", "2032-02-29"]) {
      const d = parseLocalDate(key);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
      expect(localDateKey(d)).toBe(key);
    }
    expect(Number.isNaN(parseLocalDate("not a date").getTime())).toBe(true);
  });

  it("addDaysToKey matches local Date arithmetic for every day of two years, across every DST change", () => {
    let key = "2030-01-01";
    let d = parseLocalDate(key);
    for (let i = 0; i < 730; i += 1) {
      expect(localDateKey(d)).toBe(key);
      key = addDaysToKey(key, 1);
      d = addDays(d, 1);
    }
    expect(addDaysToKey("2030-03-01", -1)).toBe("2030-02-28");
    expect(addDaysToKey("2032-02-28", 1)).toBe("2032-02-29");
    expect(daysBetweenKeys("2030-03-10", "2030-03-31")).toBe(21);
    expect(daysBetweenKeys("2030-03-31", "2030-03-10")).toBe(-21);
  });

  it("getWeekStart is the Monday at local midnight for every weekday, in every zone", () => {
    const expected: Record<string, string> = {
      "2030-03-11": "2030-03-11", "2030-03-12": "2030-03-11", "2030-03-13": "2030-03-11", "2030-03-14": "2030-03-11",
      "2030-03-15": "2030-03-11", "2030-03-16": "2030-03-11", "2030-03-17": "2030-03-11", "2030-03-18": "2030-03-18",
    };
    for (const [day, monday] of Object.entries(expected)) {
      for (const hour of [0, 1, 12, 23]) {
        const start = getWeekStart(localMoment(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8)), hour, 30));
        expect(start.getDay()).toBe(1);
        expect(start.getHours()).toBe(0);
        expect(toDateString(start)).toBe(monday);
      }
    }
    expect(weekStartKeyOf("2030-03-17")).toBe("2030-03-11"); // Sunday belongs to the week that began Monday
  });

  it("weekdayOfKey names the weekday of a local date key", () => {
    expect(weekdayOfKey("2030-03-13")).toBe("Wed");
    expect(weekdayOfKey("2030-03-17")).toBe("Sun");
    expect(weekdayOfKey("2030-03-11")).toBe("Mon");
  });

  it("dateKeyOf reads plain date strings as local dates and instants as the local date they fall on", () => {
    expect(dateKeyOf("2030-03-13")).toBe("2030-03-13");
    const evening = localMoment(2030, 3, 13, 23, 0);
    expect(dateKeyOf(evening.toISOString())).toBe("2030-03-13");
  });
});

describe("planning around 'today' uses the local date (bug: 8 PM New York rejected a task due today)", () => {
  it("accepts a task due today at 8 PM instead of rejecting it as 'Due date has already passed'", () => {
    const now = localMoment(2030, 3, 13, 20, 0);
    const task = makeTask({ name: "Reading response", dueDate: TODAY, estimatedMinutes: 30 });
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now });

    expect(result.overdueTasks).toEqual([]);
    expect(result.unscheduledTasks.map((u) => u.reason).join(" ")).not.toMatch(/already passed/i);
    expect(result.scheduledBlocks).toHaveLength(1);
    expect(result.scheduledBlocks[0]!.date).toBe(TODAY);
    expect(result.scheduledBlocks[0]!.isOverdue).toBeUndefined();
  });

  it("a task due today stays valid until the end of the local day, and is reported honestly when no time is left", () => {
    const now = localMoment(2030, 3, 13, 23, 30);
    const task = makeTask({ name: "Reading response", dueDate: TODAY, estimatedMinutes: 30 });
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now });

    expect(result.overdueTasks).toEqual([]);
    expect(result.shortfalls).toHaveLength(1);
    expect(result.shortfalls[0]!.missingMinutes).toBe(30);
    expect(result.shortfalls[0]!.reason).toMatch(/before today/);
    expect(result.shortfalls[0]!.reason).not.toMatch(/passed/i);
  });

  it("at 7 AM, a task due yesterday is overdue and a task due today is not (UTC+ mornings used to shift the day)", () => {
    const now = localMoment(2030, 3, 13, 7, 0);
    const overdue = makeTask({ name: "Lab write-up", dueDate: "2030-03-12", estimatedMinutes: 60 });
    const dueToday = makeTask({ name: "Discussion post", dueDate: TODAY, estimatedMinutes: 30 });
    const result = scheduleTasksIntelligently([overdue, dueToday], schedState(), undefined, undefined, { now });

    expect(result.overdueTasks.map((t) => t.taskId)).toEqual([overdue.id]);
    expect(result.overdueTasks[0]!.daysOverdue).toBe(1);
    expect(result.scheduledBlocks.every((b) => b.date >= TODAY)).toBe(true);
    expect(result.scheduledBlocks.some((b) => b.taskId === dueToday.id && b.date === TODAY)).toBe(true);
  });

  it("never places a session before now or after the due date", () => {
    for (const hour of [7, 13, 20, 23]) {
      const now = localMoment(2030, 3, 13, hour, 15);
      const task = makeTask({ dueDate: "2030-03-15", estimatedMinutes: 240 });
      const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now });
      for (const block of result.scheduledBlocks) {
        expect(block.date >= TODAY && block.date <= "2030-03-15").toBe(true);
        if (block.date === TODAY) {
          const [h, m] = block.startTime.split(":").map(Number);
          expect(h! * 60 + m!).toBeGreaterThanOrEqual(hour * 60 + 15);
        }
      }
    }
  });

  it("plan quality, workload warnings and priority scores treat 'today' as the local date", () => {
    const now = localMoment(2030, 3, 13, 23, 0);
    const dueToday = makeTask({ dueDate: TODAY, estimatedMinutes: 60 });
    expect(assessPlanQuality([dueToday], [], toDateString(now)).overdueTaskIds).toEqual([]);
    expect(getSemesterWorkloadWarnings([makeTask({ dueDate: TODAY, estimatedMinutes: 1200, difficulty: 5 })], 50, now)).toHaveLength(1);
    expect(computePriorityScore(dueToday, now)).toBeGreaterThanOrEqual(computePriorityScore({ ...dueToday, dueDate: "2030-03-20" }, now));
  });
});
