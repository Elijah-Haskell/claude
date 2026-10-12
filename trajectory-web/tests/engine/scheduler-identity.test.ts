import { describe, expect, it } from "vitest";
import { convertToScheduleBlocks, scheduleTasksIntelligently, stableStudyBlockId } from "../../src/engine/intelligent-scheduler";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, ScheduleBlock, Task } from "../../src/engine/types";
import { blockMinutes } from "../../src/engine/task-progress";
import { getWeekStart } from "../../src/engine/utils";
import { makeBlock, makeClass, makeTask, NOW, overlaps, schedState } from "./scheduler-fixtures";

const WEEK = getWeekStart(NOW);

type PlanState = Parameters<typeof buildWeekPlan>[0];
function planState(tasks: Task[], scheduleBlocks: ScheduleBlock[] = []): PlanState {
  return {
    classes: [makeClass()],
    recurringEvents: [],
    tasks,
    scheduleBlocks,
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
  };
}
const rebuild = (state: PlanState, options: Parameters<typeof buildWeekPlan>[2] = {}) => buildWeekPlan(state, WEEK, { now: NOW, ...options });
const next = (state: PlanState, plan: ReturnType<typeof buildWeekPlan>): PlanState => ({ ...state, tasks: plan.tasks, scheduleBlocks: plan.scheduleBlocks });

const tasks = () => [
  makeTask({ id: "essay", name: "History essay", dueDate: "2030-03-15", estimatedMinutes: 180 }),
  makeTask({ id: "pset", name: "Chemistry problem set", dueDate: "2030-03-16", estimatedMinutes: 120 }),
];

describe("stable identity (bug: regenerating a week created fresh ids and reverted user edits)", () => {
  it("derives deterministic ids from task + session + date", () => {
    const result = scheduleTasksIntelligently(tasks(), schedState(), WEEK, undefined, { now: NOW });
    const first = convertToScheduleBlocks(result.scheduledBlocks);
    const second = convertToScheduleBlocks(result.scheduledBlocks);
    expect(second.map((b) => b.id)).toEqual(first.map((b) => b.id));
    expect(new Set(first.map((b) => b.id)).size).toBe(first.length);
    for (const [i, sb] of result.scheduledBlocks.entries()) {
      expect(first[i]!.id).toBe(stableStudyBlockId(sb));
      expect(first[i]!.id).toBe(`study-${sb.taskId}-${sb.sessionNumber}-${sb.date}`);
    }
  });

  it("regenerating twice is idempotent: the second and third plans equal the first", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const state1 = next(state0, plan1);
    const plan2 = rebuild(state1);
    const plan3 = rebuild(next(state1, plan2));

    expect(plan1.scheduleBlocks.filter((b) => b.type === "study").length).toBeGreaterThan(0);
    expect(plan2.scheduleBlocks).toEqual(plan1.scheduleBlocks);
    expect(plan3.scheduleBlocks).toEqual(plan1.scheduleBlocks);
    expect(plan2.tasks).toEqual(plan1.tasks);
  });

  it("the same plan built from scratch twice is identical (deterministic)", () => {
    expect(rebuild(planState(tasks())).scheduleBlocks).toEqual(rebuild(planState(tasks())).scheduleBlocks);
  });

  it("preserves a block the user accepted and edited, and plans only the remaining minutes around it", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const state1 = next(state0, plan1);
    const target = plan1.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "essay")!;
    const edited: ScheduleBlock = { ...target, startTime: "20:00", endTime: "21:00", accepted: true, userEdited: true, title: "My own title" };
    const state2 = { ...state1, scheduleBlocks: state1.scheduleBlocks.map((b) => (b.id === target.id ? edited : b)) };

    const plan2 = rebuild(state2);
    expect(plan2.scheduleBlocks.find((b) => b.id === target.id)).toEqual(edited);
    // still idempotent with the edit in place
    const plan3 = rebuild(next(state2, plan2));
    expect(plan3.scheduleBlocks).toEqual(plan2.scheduleBlocks);

    // ids stay unique and nothing overlaps the preserved block
    const ids = plan2.scheduleBlocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const others = plan2.scheduleBlocks.filter((b) => b.type === "study" && b.id !== target.id);
    expect(others.some((b) => overlaps(b, edited))).toBe(false);
    // the essay still gets exactly its estimate in total (edited block + regenerated remainder)
    const essayMinutes = plan2.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "essay").reduce((sum, b) => sum + blockMinutes(b), 0);
    expect(essayMinutes).toBe(180);
  });

  it("an edited-but-not-accepted block is also kept (edits are decisions)", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const target = plan1.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "pset")!;
    const edited: ScheduleBlock = { ...target, startTime: "19:00", endTime: "19:45", userEdited: true, accepted: false };
    const plan2 = rebuild({ ...next(state0, plan1), scheduleBlocks: plan1.scheduleBlocks.map((b) => (b.id === target.id ? edited : b)) });
    expect(plan2.scheduleBlocks.find((b) => b.id === target.id)).toEqual(edited);
  });

  it("keeps completed, started and locked blocks, even when the user forces a rebuild", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const studies = plan1.scheduleBlocks.filter((b) => b.type === "study");
    expect(studies.length).toBeGreaterThanOrEqual(3);
    const done: ScheduleBlock = { ...studies[0]!, completionStatus: "done", accepted: true };
    const started: ScheduleBlock = { ...studies[1]!, startedAt: "2030-03-13T09:00:00.000Z", accepted: false };
    const locked: ScheduleBlock = { ...studies[2]!, locked: true, accepted: false };
    const scheduleBlocks = plan1.scheduleBlocks.map((b) => [done, started, locked].find((k) => k.id === b.id) ?? b);

    const forced = rebuild({ ...next(state0, plan1), scheduleBlocks }, { preserveAccepted: false, preserveLocked: true });
    for (const kept of [done, started, locked]) expect(forced.scheduleBlocks.find((b) => b.id === kept.id)).toEqual(kept);
  });

  it("a forced rebuild still discards merely-accepted, untouched suggestions", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const accepted = plan1.scheduleBlocks.filter((b) => b.type === "study").map((b) => ({ ...b, accepted: true }));
    const state1 = { ...next(state0, plan1), scheduleBlocks: plan1.scheduleBlocks.map((b) => accepted.find((a) => a.id === b.id) ?? b) };
    const forced = rebuild(state1, { preserveAccepted: false });
    const totals = (plan: ReturnType<typeof buildWeekPlan>, taskId: string) => plan.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === taskId).reduce((sum, b) => sum + blockMinutes(b), 0);
    // nothing was duplicated: each task still totals its estimate
    expect(totals(forced, "essay")).toBe(180);
    expect(totals(forced, "pset")).toBe(120);
  });

  it("regenerates skipped/missed sessions instead of keeping dead blocks", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const target = plan1.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "essay")!;
    const skipped: ScheduleBlock = { ...target, completionStatus: "skipped", accepted: false };
    const plan2 = rebuild({ ...next(state0, plan1), scheduleBlocks: plan1.scheduleBlocks.map((b) => (b.id === target.id ? skipped : b)) });
    const total = plan2.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "essay" && b.completionStatus === "pending").reduce((sum, b) => sum + blockMinutes(b), 0);
    expect(total).toBe(180);
  });

  it("drops legacy meal and workout blocks from persisted state", () => {
    const legacy = [makeBlock({ id: "meal", type: "meal" as never, date: "2030-03-13" }), makeBlock({ id: "gym", type: "workout" as never, date: "2030-03-20" })];
    const plan = rebuild(planState(tasks(), legacy));
    expect(plan.scheduleBlocks.some((b) => (b.type as string) === "meal" || (b.type as string) === "workout")).toBe(false);
  });

  it("gives structural blocks stable ids too (sleep / class), so a rebuild does not churn them", () => {
    const plan1 = rebuild(planState([]));
    const plan2 = rebuild(next(planState([]), plan1));
    expect(plan2.scheduleBlocks.map((b) => b.id)).toEqual(plan1.scheduleBlocks.map((b) => b.id));
  });

  it("resolves an id collision between a preserved block and a regenerated one deterministically", () => {
    const state0 = planState(tasks());
    const plan1 = rebuild(state0);
    const target = plan1.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "essay")!;
    // the user moved an accepted block to another time on the same date, keeping its id
    const moved: ScheduleBlock = { ...target, startTime: "21:00", endTime: "21:30", accepted: true, userEdited: true };
    const state = { ...next(state0, plan1), scheduleBlocks: plan1.scheduleBlocks.map((b) => (b.id === target.id ? moved : b)) };
    const a = rebuild(state);
    const b = rebuild(state);
    expect(b.scheduleBlocks).toEqual(a.scheduleBlocks);
    expect(new Set(a.scheduleBlocks.map((x) => x.id)).size).toBe(a.scheduleBlocks.length);
  });
});
