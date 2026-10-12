import { describe, expect, it } from "vitest";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { detectDrift } from "../../src/engine/replan";
import { taskDeadline } from "../../src/engine/task-kind";
import { DEFAULT_USER_PREFS, RecurringEvent } from "../../src/engine/types";
import { timeToMinutes, weekdayOfKey } from "../../src/engine/utils";
import { makeBlock, makeClass, makeTask, NOW, schedState, TODAY } from "./scheduler-fixtures";

// NOW = Wed 2030-03-13 12:00; Sat 2030-03-16, Sun 2030-03-17.
const busyWeekdays: RecurringEvent = { id: "work", title: "Work", days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "07:00", endTime: "23:00", color: "#000", locked: true };
const solve = (...args: Parameters<typeof schedState>) => (tasks: ReturnType<typeof makeTask>[]) =>
  scheduleTasksIntelligently(tasks, schedState(...args), undefined, undefined, { now: NOW });

describe("start times are chosen inside free gaps, not just at their first minute", () => {
  it("a free weekend is not studied at 7:30 AM (the old gap-start pick): sessions start mid-morning or later", () => {
    const result = solve({ recurringEvents: [busyWeekdays] })([
      makeTask({ id: "a", name: "Problem set 5", kind: "assignment", dueDate: "2030-03-18", estimatedMinutes: 90, difficulty: 4 }),
      makeTask({ id: "b", name: "Lab report", kind: "assignment", dueDate: "2030-03-18", estimatedMinutes: 90, difficulty: 2 }),
    ]);
    const weekend = result.scheduledBlocks.filter((b) => ["Sat", "Sun"].includes(weekdayOfKey(b.date)));
    expect(weekend.length).toBeGreaterThan(0);
    for (const b of weekend) expect(timeToMinutes(b.startTime), `${b.date} ${b.startTime}`).toBeGreaterThanOrEqual(9 * 60);
  });

  it("leaves a short breather after class instead of starting the minute the transition ends", () => {
    // Only Friday afternoon is free: class 10:00-11:00, then open until the evening.
    const result = solve({
      classes: [makeClass({ id: "chem", days: ["Fri"], startTime: "10:00", endTime: "11:00" })],
      recurringEvents: [{ ...busyWeekdays, days: ["Mon", "Tue", "Wed", "Thu", "Sat", "Sun"] }, { id: "am", title: "Morning", days: ["Fri"], startTime: "07:00", endTime: "10:00", color: "#000", locked: true }],
    })([makeTask({ id: "h", name: "History essay", kind: "assignment", courseId: "hist", dueDate: "2030-03-18", estimatedMinutes: 60 })]);
    expect(result.scheduledBlocks).toHaveLength(1);
    const start = timeToMinutes(result.scheduledBlocks[0]!.startTime);
    expect(start).toBeGreaterThanOrEqual(11 * 60 + 30);
  });

  it("is deterministic and still never overlaps anything", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ id: `t${i}`, name: `Problem set ${i}`, kind: "assignment", dueDate: "2030-03-20", estimatedMinutes: 120 }));
    const a = solve({ classes: [makeClass()] })(tasks);
    const b = solve({ classes: [makeClass()] })(tasks);
    expect(b).toEqual(a);
    const byDate = new Map<string, Array<[number, number]>>();
    for (const x of a.scheduledBlocks) byDate.set(x.date, [...(byDate.get(x.date) ?? []), [timeToMinutes(x.startTime), timeToMinutes(x.endTime)]]);
    for (const spans of byDate.values()) {
      spans.sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < spans.length; i += 1) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
    }
  });
});

describe("daily / weekly study caps", () => {
  it("a day already holding the daily cap of confirmed study gets nothing new while another day in the runway has room", () => {
    const heavy = [
      makeBlock({ id: "k1", taskId: "other", date: "2030-03-16", startTime: "09:00", endTime: "11:30" }),
      makeBlock({ id: "k2", taskId: "other", date: "2030-03-16", startTime: "13:00", endTime: "15:30" }),
    ]; // 300 min on Saturday
    const result = scheduleTasksIntelligently(
      [makeTask({ id: "q", name: "Reading response", kind: "assignment", dueDate: "2030-03-18", estimatedMinutes: 60 })],
      schedState({ scheduleBlocks: heavy }), undefined, undefined, { now: NOW },
    );
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result.scheduledBlocks.some((b) => b.date === "2030-03-16")).toBe(false);
  });

  it("respects custom caps (loadCaps option / UserPreferences.dailyStudyCapMinutes) but still places work when nothing else fits", () => {
    const tasks = [makeTask({ id: "big", name: "Term paper", kind: "assignment", dueDate: "2030-03-15", estimatedMinutes: 360 })];
    const capped = scheduleTasksIntelligently(tasks, schedState({ userPrefs: { ...DEFAULT_USER_PREFS, dailyStudyCapMinutes: 120 } }), undefined, undefined, { now: NOW });
    const perDay = new Map<string, number>();
    for (const b of capped.scheduledBlocks) perDay.set(b.date, (perDay.get(b.date) ?? 0) + b.durationMinutes);
    // Only Wed afternoon, Thu and Fri exist before the deadline: 360 min cannot fit under 120/day, so the cap bends
    // rather than dropping work - but nothing is lost.
    expect([...perDay.values()].reduce((s, m) => s + m, 0) + (capped.shortfalls[0]?.missingMinutes ?? 0)).toBe(360);
    expect(capped.shortfalls).toEqual([]);
  });
});

describe("missed quizzes / exams are not 'behind'", () => {
  it("detectDrift lists a past quiz as a missed assessment, not as overdue work to catch up on", () => {
    const quiz = makeTask({ id: "q", name: "Quiz 2", kind: "quiz", dueDate: "2030-03-11", estimatedMinutes: 30 });
    const hw = makeTask({ id: "h", name: "Problem set 2", kind: "assignment", dueDate: "2030-03-11", estimatedMinutes: 30 });
    const quizOnly = detectDrift({ tasks: [quiz], scheduleBlocks: [] }, NOW);
    expect(quizOnly.overdueTasks).toEqual([]);
    expect(quizOnly.missedAssessments?.map((t) => t.taskId)).toEqual(["q"]);
    expect(quizOnly.severity).toBe("none");
    expect(detectDrift({ tasks: [quiz, hw], scheduleBlocks: [] }, NOW).overdueTasks.map((t) => t.taskId)).toEqual(["h"]);
  });
});

describe("taskDeadline", () => {
  const cls = makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "11:00" });
  it("due time wins; a time-less quiz/exam starts with its class, or the day; other work has the whole day", () => {
    expect(taskDeadline(makeTask({ kind: "quiz", dueDate: TODAY, dueTime: "15:00" }), [cls])).toMatchObject({ cutoffMinutes: 900, source: "due-time" });
    expect(taskDeadline(makeTask({ kind: "quiz", courseId: "chem", dueDate: TODAY }), [cls])).toMatchObject({ cutoffMinutes: 600, source: "class-start" });
    expect(taskDeadline(makeTask({ kind: "exam", courseId: "chem", dueDate: "2030-03-14" }), [cls])).toMatchObject({ cutoffMinutes: 0, source: "start-of-day" });
    expect(taskDeadline(makeTask({ kind: "quiz", courseId: "chem", dueDate: TODAY }), [cls], { startDate: "2030-01-01", endDate: "2030-05-01", breaks: [{ name: "Break", startDate: TODAY, endDate: TODAY }] })).toMatchObject({ cutoffMinutes: 0 });
    expect(taskDeadline(makeTask({ kind: "assignment", courseId: "chem", dueDate: TODAY }), [cls])).toMatchObject({ cutoffMinutes: undefined, source: "none" });
  });
});
