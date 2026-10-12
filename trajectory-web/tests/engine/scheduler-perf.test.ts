import { describe, expect, it } from "vitest";
import { convertToScheduleBlocks, scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, Task } from "../../src/engine/types";
import { addDaysToKey, getWeekStart } from "../../src/engine/utils";
import { expectNoOverlaps, makeClass, NOW, schedState, TODAY } from "./scheduler-fixtures";

/** A 16-week semester: 5 courses, 60 tasks (homework, papers, quizzes, exams) spread over 112 days. */
function semester(): { tasks: Task[]; classes: ReturnType<typeof makeClass>[] } {
  const courses = ["chem", "hist", "math", "eng", "cs"];
  const classes = courses.map((id, i) => makeClass({
    id, name: id.toUpperCase(),
    days: i % 2 === 0 ? ["Mon", "Wed", "Fri"] : ["Tue", "Thu"],
    startTime: `${String(8 + i * 2).padStart(2, "0")}:00`,
    endTime: `${String(9 + i * 2).padStart(2, "0")}:15`,
  }));
  const kinds = ["Problem set", "Reading response", "Quiz", "Lab report", "Midterm exam"];
  const tasks: Task[] = Array.from({ length: 60 }, (_, i) => ({
    id: `sem-${i}`,
    name: `${kinds[i % kinds.length]} ${Math.floor(i / 5) + 1}`,
    courseId: courses[i % courses.length]!,
    courseName: courses[i % courses.length]!.toUpperCase(),
    dueDate: addDaysToKey(TODAY, 2 + Math.floor((i * 110) / 60)),
    estimatedMinutes: [45, 60, 90, 120, 180][i % 5]!,
    difficulty: ((i % 5) + 1) as Task["difficulty"],
    requiresOnCampus: false,
    status: "pending",
    createdAt: "2030-03-01T00:00:00.000Z",
  }));
  return { tasks, classes };
}

describe("determinism and performance", () => {
  it("plans a 16-week semester (60 tasks) in well under a second, without overlaps or lost minutes", () => {
    const { tasks, classes } = semester();
    const started = performance.now();
    const result = scheduleTasksIntelligently(tasks, schedState({ classes }), getWeekStart(NOW), undefined, { now: NOW });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(result.scheduledBlocks.length).toBeGreaterThan(60);
    expect(expectNoOverlaps(result.scheduledBlocks)).toBeNull();
    for (const task of tasks) {
      const placed = result.scheduledBlocks.filter((b) => b.taskId === task.id).reduce((sum, b) => sum + b.durationMinutes, 0);
      const missing = result.shortfalls.find((s) => s.taskId === task.id)?.missingMinutes ?? 0;
      expect(placed + missing).toBe(task.estimatedMinutes);
    }
  });

  it("re-planning the same week of a 60-task semester repeatedly stays fast (no accidental cubic behaviour)", () => {
    const { tasks, classes } = semester();
    const state: Parameters<typeof buildWeekPlan>[0] = { classes, recurringEvents: [], tasks, scheduleBlocks: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS };
    const started = performance.now();
    let current = state;
    for (let week = 0; week < 4; week += 1) {
      const plan = buildWeekPlan(current, addWeeks(getWeekStart(NOW), week), { now: NOW });
      current = { ...current, tasks: plan.tasks, scheduleBlocks: plan.scheduleBlocks };
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("scales roughly linearly: doubling the tasks does not blow up the runtime", () => {
    const { tasks, classes } = semester();
    const time = (n: number) => {
      const many = Array.from({ length: n }, (_, i) => ({ ...tasks[i % tasks.length]!, id: `x-${i}` }));
      const t0 = performance.now();
      scheduleTasksIntelligently(many, schedState({ classes }), getWeekStart(NOW), undefined, { now: NOW });
      return performance.now() - t0;
    };
    time(30); // warm up
    const small = Math.max(time(60), 1);
    const big = time(240);
    expect(big / small).toBeLessThan(40); // 4x the work; O(n^3) would be ~64x
    expect(big).toBeLessThan(3000);
  });

  it("is deterministic: identical inputs give identical plans and identical ids", () => {
    const { tasks, classes } = semester();
    const run = () => scheduleTasksIntelligently(tasks, schedState({ classes }), getWeekStart(NOW), undefined, { now: NOW });
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    expect(convertToScheduleBlocks(b.scheduledBlocks).map((x) => x.id)).toEqual(convertToScheduleBlocks(a.scheduledBlocks).map((x) => x.id));
  });

  it("total planned time does not depend on the order tasks are passed in", () => {
    const { tasks, classes } = semester();
    const forward = scheduleTasksIntelligently(tasks, schedState({ classes }), getWeekStart(NOW), undefined, { now: NOW });
    const reversed = scheduleTasksIntelligently([...tasks].reverse(), schedState({ classes }), getWeekStart(NOW), undefined, { now: NOW });
    const key = (r: typeof forward) => r.scheduledBlocks.map((b) => `${b.taskId}|${b.date}|${b.startTime}`).sort();
    // ties in priority may swap which task gets a slot first, but the totals must match
    expect(reversed.totalStudyMinutes).toBe(forward.totalStudyMinutes);
    expect(key(reversed).length).toBe(key(forward).length);
  });

  it("uses the injected clock, not the system clock", () => {
    const { tasks, classes } = semester();
    const early = scheduleTasksIntelligently(tasks.slice(0, 5), schedState({ classes }), undefined, undefined, { now: NOW });
    const later = scheduleTasksIntelligently(tasks.slice(0, 5), schedState({ classes }), undefined, undefined, { now: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 14, 9, 0) });
    expect(Math.min(...early.scheduledBlocks.map((b) => Number(b.date.replace(/-/g, ""))))).toBeLessThan(
      Math.min(...later.scheduledBlocks.map((b) => Number(b.date.replace(/-/g, "")))),
    );
  });
});

function addWeeks(date: Date, weeks: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}
