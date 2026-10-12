import { describe, expect, it } from "vitest";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { applyBlockCompletion, blockMinutes, remainingMinutes, revertBlockCompletion } from "../../src/engine/task-progress";
import { computePriorityScore } from "../../src/engine/priority-engine";
import { getSemesterWorkloadWarnings } from "../../src/engine/workload-analysis";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS } from "../../src/engine/types";
import { getWeekStart } from "../../src/engine/utils";
import { makeBlock, makeTask, NOW, schedState } from "./scheduler-fixtures";

const placed = (blocks: Array<{ taskId: string; durationMinutes: number }>, taskId: string) =>
  blocks.filter((b) => b.taskId === taskId).reduce((sum, b) => sum + b.durationMinutes, 0);

describe("task progress (bug: completing ONE study block marked the whole task done)", () => {
  it("remainingMinutes subtracts completed work and never goes negative", () => {
    expect(remainingMinutes({ estimatedMinutes: 240 })).toBe(240);
    expect(remainingMinutes({ estimatedMinutes: 240, completedMinutes: 90 })).toBe(150);
    expect(remainingMinutes({ estimatedMinutes: 60, completedMinutes: 120 })).toBe(0);
  });

  it("blockMinutes measures a block, including one that wraps past midnight", () => {
    expect(blockMinutes({ startTime: "09:00", endTime: "10:30" })).toBe(90);
    expect(blockMinutes({ startTime: "23:30", endTime: "00:30" })).toBe(60);
  });

  it("completing one of several sessions adds its minutes and keeps the task scheduled", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 240, status: "scheduled" });
    const block = makeBlock({ taskId: "t", startTime: "10:00", endTime: "11:30" });
    const updated = applyBlockCompletion(task, block);
    expect(updated).toMatchObject({ completedMinutes: 90, status: "scheduled" });
    expect(remainingMinutes(updated)).toBe(150);
    expect(task.completedMinutes).toBeUndefined(); // input is not mutated
  });

  it("a pending task becomes 'scheduled' (not 'done') after its first completed block", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 240, status: "pending" });
    expect(applyBlockCompletion(task, makeBlock({ taskId: "t" })).status).toBe("scheduled");
  });

  it("marks the task done only once completed minutes cover the estimate", () => {
    let task = makeTask({ id: "t", estimatedMinutes: 120, status: "scheduled" });
    task = applyBlockCompletion(task, makeBlock({ taskId: "t", startTime: "10:00", endTime: "11:00" }));
    expect(task.status).toBe("scheduled");
    task = applyBlockCompletion(task, makeBlock({ taskId: "t", startTime: "13:00", endTime: "14:00" }));
    expect(task).toMatchObject({ completedMinutes: 120, status: "done" });
    // over-completion still counts as done
    const over = applyBlockCompletion(makeTask({ id: "o", estimatedMinutes: 30, status: "scheduled" }), makeBlock({ taskId: "o", startTime: "10:00", endTime: "11:00" }));
    expect(over.status).toBe("done");
  });

  it("ignores blocks that do not belong to the task, non-study blocks, and finished/skipped tasks", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 120, status: "scheduled" });
    expect(applyBlockCompletion(task, makeBlock({ taskId: "other" }))).toBe(task);
    expect(applyBlockCompletion(task, makeBlock({ taskId: "t", type: "class" }))).toBe(task);
    const done = makeTask({ id: "d", status: "done" });
    expect(applyBlockCompletion(done, makeBlock({ taskId: "d" }))).toBe(done);
  });

  it("revertBlockCompletion undoes it, and reopens a finished task", () => {
    const block = makeBlock({ taskId: "t", startTime: "10:00", endTime: "11:00" });
    const finished = applyBlockCompletion(makeTask({ id: "t", estimatedMinutes: 60, status: "scheduled" }), block);
    expect(finished.status).toBe("done");
    const reopened = revertBlockCompletion(finished, block);
    expect(reopened).toMatchObject({ completedMinutes: 0, status: "scheduled" });
    expect(revertBlockCompletion(makeTask({ id: "t", estimatedMinutes: 60 }), block).completedMinutes).toBe(0);
  });
});

describe("the planner only plans the REMAINING minutes of partly finished tasks", () => {
  const solve = (task: ReturnType<typeof makeTask>) => scheduleTasksIntelligently([task], schedState(), undefined, undefined, { now: NOW });

  it("plans 240 - 120 = 120 minutes", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 240, completedMinutes: 120, status: "scheduled", dueDate: "2030-03-18" });
    const result = solve(task);
    expect(placed(result.scheduledBlocks, "t")).toBe(120);
    expect(result.shortfalls).toEqual([]);
  });

  it("does not plan a task whose completed minutes already cover the estimate", () => {
    const result = solve(makeTask({ id: "t", estimatedMinutes: 90, completedMinutes: 90, status: "scheduled" }));
    expect(result.scheduledBlocks).toEqual([]);
    expect(result.shortfalls).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
  });

  it("reports a shortfall in terms of the remaining minutes", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 2500, completedMinutes: 500, status: "scheduled", dueDate: "2030-03-14" });
    const result = solve(task);
    expect(result.shortfalls[0]!.requestedMinutes).toBe(2000);
    expect(result.shortfalls[0]!.placedMinutes + result.shortfalls[0]!.missingMinutes).toBe(2000);
  });

  it("trims a strategist's session plan by the work already done", () => {
    const task = makeTask({
      id: "t", name: "Lab report", estimatedMinutes: 150, completedMinutes: 60, status: "scheduled", dueDate: "2030-03-19",
      planningStrategy: {
        rationale: "Stage it.", priority: 4,
        sessions: [
          { label: "Outline", purpose: "draft", minutes: 45, earliestDaysBeforeDue: 7, targetDaysBeforeDue: 6 },
          { label: "Write", purpose: "draft", minutes: 75, earliestDaysBeforeDue: 5, targetDaysBeforeDue: 4 },
          { label: "Polish", purpose: "submit", minutes: 30, earliestDaysBeforeDue: 2, targetDaysBeforeDue: 1 },
        ],
      },
    });
    const result = solve(task);
    expect(result.scheduledBlocks.map((b) => [b.strategyLabel, b.durationMinutes])).toEqual([["Write", 60], ["Polish", 30]]);
  });

  it("buildWeekPlan uses remaining minutes, minus sessions it keeps", () => {
    const task = makeTask({ id: "t", estimatedMinutes: 240, completedMinutes: 60, status: "scheduled", dueDate: "2030-03-18" });
    const keep = makeBlock({ id: "keep", taskId: "t", date: "2030-03-14", startTime: "15:00", endTime: "16:00", accepted: true });
    const plan = buildWeekPlan(
      { classes: [], recurringEvents: [], tasks: [task], scheduleBlocks: [keep], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS },
      getWeekStart(NOW),
      { now: NOW },
    );
    const total = plan.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "t").reduce((sum, b) => sum + blockMinutes(b), 0);
    expect(total).toBe(240 - 60); // 60 kept + 120 newly planned
  });

  it("priority scores and workload warnings use remaining minutes too", () => {
    const fresh = makeTask({ estimatedMinutes: 240, dueDate: "2030-03-20", difficulty: 1 });
    const mostlyDone = { ...fresh, completedMinutes: 200 };
    expect(computePriorityScore(mostlyDone, NOW)).toBeLessThan(computePriorityScore(fresh, NOW));
    const big = makeTask({ estimatedMinutes: 1200, completedMinutes: 1100, dueDate: "2030-03-20", difficulty: 5 });
    expect(getSemesterWorkloadWarnings([big], 50, NOW)).toEqual([]);
  });
});
