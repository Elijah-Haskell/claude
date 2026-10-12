import { describe, expect, it } from "vitest";
import { convertToScheduleBlocks, scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { assessPlanQuality } from "../../src/engine/plan-quality";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, Task } from "../../src/engine/types";
import { makeBlock, makeClass, makeTask, NOW, schedState, TODAY } from "./scheduler-fixtures";
import { localDateKey, getWeekStart } from "../../src/engine/utils";

const placedFor = (blocks: Array<{ taskId: string; durationMinutes: number }>, taskId: string) =>
  blocks.filter((b) => b.taskId === taskId).reduce((sum, b) => sum + b.durationMinutes, 0);

describe("shortfall reporting (bug: a 2000-minute task due tomorrow reported 'healthy')", () => {
  const huge = () => makeTask({ id: "huge", name: "Thesis chapter", estimatedMinutes: 2000, dueDate: "2030-03-14" });

  it("returns an explicit per-task shortfall whose numbers add up", () => {
    const task = huge();
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now: NOW });
    const placed = placedFor(result.scheduledBlocks, task.id);

    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(2000);
    expect(result.shortfalls).toHaveLength(1);
    const shortfall = result.shortfalls[0]!;
    expect(shortfall).toMatchObject({ taskId: "huge", taskName: "Thesis chapter", dueDate: "2030-03-14", requestedMinutes: 2000, overdue: false });
    expect(shortfall.placedMinutes).toBe(placed);
    expect(shortfall.missingMinutes).toBe(2000 - placed);
  });

  it("fills unscheduledTasks with a human reason and mentions the shortfall in the summary", () => {
    const result = scheduleTasksIntelligently([huge()], schedState(), undefined, undefined, { now: NOW });
    expect(result.unscheduledTasks).toHaveLength(1);
    expect(result.unscheduledTasks[0]!.taskId).toBe("huge");
    expect(result.unscheduledTasks[0]!.reason).toMatch(/Only .* of .* fit before tomorrow — you need ~\d+ more hours\./);
    expect(result.summary).toMatch(/won't fully fit/);
  });

  it("plan quality says so (with the solver's shortfalls)", () => {
    const task = huge();
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now: NOW });
    const blocks = convertToScheduleBlocks(result.scheduledBlocks);
    const report = assessPlanQuality([{ ...task, status: "scheduled" }], blocks, TODAY, { solverShortfalls: result.shortfalls });

    expect(report.severity).toBe("high");
    expect(report.shortfalls).toHaveLength(1);
    expect(report.shortfalls[0]!.missingMinutes).toBe(result.shortfalls[0]!.missingMinutes);
    expect(report.message).toMatch(/You need ~\d+ more hours before tomorrow to finish Thesis chapter/);
    expect(report.message).not.toMatch(/represented on the calendar/);
  });

  it("plan quality also catches it from the calendar alone (tasks already placed as blocks count)", () => {
    const task = makeTask({ id: "report", name: "Big report", estimatedMinutes: 600, dueDate: "2030-03-15" });
    const blocks = [
      makeBlock({ taskId: task.id, date: "2030-03-13", startTime: "14:00", endTime: "16:00" }),
      makeBlock({ taskId: task.id, date: "2030-03-14", startTime: "14:00", endTime: "17:00" }),
    ]; // 300 of 600 minutes
    const report = assessPlanQuality([{ ...task, status: "scheduled" }], blocks, TODAY);

    expect(report.shortfalls).toEqual([
      { taskId: "report", taskName: "Big report", dueDate: "2030-03-15", requestedMinutes: 600, placedMinutes: 300, missingMinutes: 300 },
    ]);
    expect(report.message).toContain("You need ~5 more hours before Fri to finish Big report");
    expect(report.severity).toBe("high");
  });

  it("does not count sessions that are after the deadline, already done, or in the past", () => {
    const task = makeTask({ id: "essay", name: "Essay", estimatedMinutes: 120, dueDate: "2030-03-15" });
    const blocks = [
      makeBlock({ taskId: task.id, date: "2030-03-16", startTime: "10:00", endTime: "12:00" }), // after the deadline
      makeBlock({ taskId: task.id, date: "2030-03-12", startTime: "10:00", endTime: "11:00" }), // yesterday
      makeBlock({ taskId: task.id, date: "2030-03-14", startTime: "10:00", endTime: "11:00", completionStatus: "done" }),
    ];
    const report = assessPlanQuality([{ ...task, status: "scheduled" }], blocks, TODAY);
    // nothing usable is on the calendar before the deadline: the task counts as not yet planned
    expect(report.unplannedTaskIds).toEqual(["essay"]);
    expect(report.message).toMatch(/not yet on the calendar/);
    expect(report.severity).not.toBe("healthy");
  });

  it("a plan that fits is reported healthy and has no shortfalls", () => {
    const task = makeTask({ estimatedMinutes: 120, dueDate: "2030-03-18" });
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now: NOW });
    expect(result.shortfalls).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
    const report = assessPlanQuality([{ ...task, status: "scheduled" }], convertToScheduleBlocks(result.scheduledBlocks), TODAY, { solverShortfalls: result.shortfalls });
    expect(report.severity).toBe("healthy");
    expect(report.shortfalls).toEqual([]);
  });

  it("uses the days before the 14-day prep window when the window itself is too small", () => {
    // 100 hours due in 30 days: cannot fit in the 14 days before the deadline (4 sessions/day cap) but fits in the month
    const task = makeTask({ estimatedMinutes: 6000, dueDate: "2030-04-12" });
    const result = scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now: NOW });
    expect(result.shortfalls).toEqual([]);
    expect(placedFor(result.scheduledBlocks, task.id)).toBe(6000);
    expect(result.scheduledBlocks.some((b) => b.date < "2030-03-29")).toBe(true);
  });

  it("reports no room at all when every day is blocked", () => {
    const task = makeTask({ estimatedMinutes: 90, dueDate: "2030-03-15" });
    const result = scheduleTasksIntelligently(
      [task],
      schedState({ userPrefs: { ...DEFAULT_USER_PREFS, noGoZones: [{ startTime: "00:00", endTime: "23:59" }] } }),
      undefined,
      undefined,
      { now: NOW },
    );
    expect(result.scheduledBlocks).toEqual([]);
    expect(result.shortfalls[0]).toMatchObject({ requestedMinutes: 90, placedMinutes: 0, missingMinutes: 90 });
    expect(result.unscheduledTasks[0]!.reason).toMatch(/No free time slots found before Fri/);
  });

  it("does not report tasks that are simply not due for planning yet (beyond the 16-week horizon)", () => {
    const far = makeTask({ estimatedMinutes: 120, dueDate: "2031-03-13" });
    const result = scheduleTasksIntelligently([far], schedState(), undefined, undefined, { now: NOW });
    expect(result.shortfalls).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
  });

  it("buildWeekPlan carries the shortfalls to the reducer/UI", () => {
    const task = huge2();
    const plan = buildWeekPlan(
      { classes: [], recurringEvents: [], tasks: [task], scheduleBlocks: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS },
      getWeekStart(NOW),
      { now: NOW },
    );
    expect(plan.shortfalls).toHaveLength(1);
    expect(plan.shortfalls[0]!.missingMinutes).toBeGreaterThan(0);
    const report = assessPlanQuality(plan.tasks, plan.scheduleBlocks, localDateKey(NOW), { solverShortfalls: plan.shortfalls });
    expect(report.severity).toBe("high");
    function huge2(): Task {
      return makeTask({ id: "huge2", name: "Portfolio", estimatedMinutes: 2000, dueDate: "2030-03-14" });
    }
  });
});

describe("overdue tasks are planned ASAP instead of silently dropped", () => {
  it("places an overdue task today/tomorrow, flags it, and it outranks work that is due later", () => {
    const overdue = makeTask({ id: "late", name: "Lab report", dueDate: "2030-03-10", estimatedMinutes: 60 });
    const far = makeTask({ id: "far", name: "Homework 9", dueDate: "2030-03-25", estimatedMinutes: 60 });
    // exactly one free hour per day (15:00-16:00), so the two tasks compete for the same slot
    const oneHourADay = { ...DEFAULT_USER_PREFS, noGoZones: [{ startTime: "00:00", endTime: "15:00" }, { startTime: "16:00", endTime: "23:59" }] };
    const result = scheduleTasksIntelligently([far, overdue], schedState({ userPrefs: oneHourADay }), undefined, undefined, { now: NOW });

    const lateBlocks = result.scheduledBlocks.filter((b) => b.taskId === "late");
    expect(lateBlocks).toHaveLength(1);
    expect(lateBlocks[0]).toMatchObject({ date: TODAY, startTime: "15:00", isOverdue: true });
    expect(lateBlocks[0]!.reason).toMatch(/Overdue since 2030-03-10/);
    expect(result.scheduledBlocks.some((b) => b.taskId === "far" && b.date === TODAY)).toBe(false);
    expect(result.overdueTasks).toEqual([{ taskId: "late", taskName: "Lab report", dueDate: "2030-03-10", daysOverdue: 3 }]);
    expect(result.summary).toMatch(/1 overdue task was planned for the next two days/);
    // the converted block reads as catch-up work, not as a normal session
    expect(convertToScheduleBlocks(lateBlocks)[0]!.title).toMatch(/^Catch up: Lab report/);
  });

  it("an overdue task that cannot fit is a shortfall, not a silent drop", () => {
    const overdue = makeTask({ id: "late", name: "Term paper", dueDate: "2030-03-01", estimatedMinutes: 3000 });
    const result = scheduleTasksIntelligently([overdue], schedState(), undefined, undefined, { now: NOW });
    expect(result.shortfalls[0]).toMatchObject({ taskId: "late", overdue: true });
    expect(result.shortfalls[0]!.missingMinutes).toBeGreaterThan(0);
    expect(result.unscheduledTasks[0]!.reason).toMatch(/in the next two days/);
  });

  it("honours a user-requested defer date on an overdue task", () => {
    const overdue = makeTask({ dueDate: "2030-03-10", notBeforeDate: "2030-03-16", estimatedMinutes: 60 });
    const result = scheduleTasksIntelligently([overdue], schedState(), undefined, undefined, { now: NOW });
    expect(result.scheduledBlocks.every((b) => b.date >= "2030-03-16")).toBe(true);
  });

  it("plan quality lists overdue work", () => {
    const overdue = makeTask({ id: "late", name: "Lab report", dueDate: "2030-03-10", estimatedMinutes: 60 });
    const report = assessPlanQuality([overdue], [], TODAY);
    expect(report.overdueTaskIds).toEqual(["late"]);
    expect(report.severity).not.toBe("healthy");
    expect(report.message).toMatch(/1 task is overdue/);
  });

  it("buildWeekPlan plans an overdue task and reports it", () => {
    const overdue = makeTask({ id: "late", name: "Lab report", dueDate: "2030-03-10", estimatedMinutes: 60 });
    const plan = buildWeekPlan(
      { classes: [makeClass()], recurringEvents: [], tasks: [overdue], scheduleBlocks: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS },
      getWeekStart(NOW),
      { now: NOW },
    );
    expect(plan.overdueTasks.map((t) => t.taskId)).toEqual(["late"]);
    expect(plan.scheduleBlocks.some((b) => b.type === "study" && b.taskId === "late" && b.date >= TODAY)).toBe(true);
  });
});

describe("robustness the planner must not paper over", () => {
  it("a task with no valid due date is reported, not silently skipped or scheduled at random", () => {
    const broken = makeTask({ id: "nodate", name: "Mystery task", dueDate: "" });
    const result = scheduleTasksIntelligently([broken], schedState(), undefined, undefined, { now: NOW });
    expect(result.scheduledBlocks).toEqual([]);
    expect(result.shortfalls[0]).toMatchObject({ taskId: "nodate", placedMinutes: 0, missingMinutes: 60 });
    expect(result.unscheduledTasks[0]!.reason).toMatch(/no valid due date/);
  });

  it("the solver no longer reads meal preferences (meals were removed from the product)", () => {
    // Old saves still carry meal times (even ones that sit inside the study day): they must change nothing.
    const legacyPrefs = { ...DEFAULT_HEALTH_PREFS, mealCount: 4, mealTimes: ["09:00", "12:00", "15:00", "19:00"] } as typeof DEFAULT_HEALTH_PREFS;
    const task = makeTask({ estimatedMinutes: 120, dueDate: "2030-03-18" });
    const result = scheduleTasksIntelligently([task], schedState({ healthPrefs: legacyPrefs }), undefined, undefined, { now: NOW });
    const clean = scheduleTasksIntelligently([task], schedState({ healthPrefs: DEFAULT_HEALTH_PREFS }), undefined, undefined, { now: NOW });
    expect(result.shortfalls).toEqual([]);
    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result).toEqual(clean);
  });
});
