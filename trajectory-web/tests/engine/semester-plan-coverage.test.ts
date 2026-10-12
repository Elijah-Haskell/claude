import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer, runReplan } from "../../src/engine/app-context";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { createInitialState } from "../../src/engine/state-persistence";
import { AppState, ScheduleBlock, Semester, Task } from "../../src/engine/types";
import { blockMinutes } from "../../src/engine/task-progress";
import { parseLocalDate, weekStartKeyOf } from "../../src/engine/utils";
import { localMoment, makeClass, makeTask, NOW } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };

function stateWith(tasks: Task[], extra: Partial<AppState> = {}): AppState {
  return {
    ...createInitialState(),
    onboardingComplete: true,
    semester: SEMESTER,
    classes: [makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "11:00" })],
    tasks,
    ...extra,
  };
}

const pending = (state: AppState, taskId: string) =>
  state.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === taskId && b.completionStatus === "pending");
const total = (blocks: ScheduleBlock[]) => blocks.reduce((sum, b) => sum + blockMinutes(b), 0);
const weeksOf = (blocks: ScheduleBlock[]) => new Set(blocks.map((b) => weekStartKeyOf(b.date)));

function plan(state: AppState, now = NOW): AppState {
  const result = buildSemesterPlan(state, { now });
  return { ...state, tasks: result.tasks, scheduleBlocks: result.scheduleBlocks };
}

describe("a semester-wide pass never plans the same minutes twice", () => {
  // Due Wed Apr 3 with 10 hours of work: the sessions run day after day from Mar 20, so they span several calendar weeks.
  const essay = makeTask({ id: "essay", name: "History essay", courseId: "chem", dueDate: "2030-04-03", estimatedMinutes: 600, difficulty: 3 });

  it("places exactly the estimate across several weeks", () => {
    const state = plan(stateWith([essay]));

    expect(weeksOf(pending(state, "essay")).size).toBeGreaterThanOrEqual(2);
    expect(total(pending(state, "essay"))).toBe(600);
  });

  it("stays at the estimate when suggestions from an earlier plan sit in week 1 and week 2 (nothing is 'covered elsewhere' twice)", () => {
    const first = plan(stateWith([essay]));
    // Simulate the old failure: a later pass that sees week-1 suggestions (unaccepted) and plans the task again.
    const again = plan({ ...first }, localMoment(2030, 3, 13, 12, 5));
    const third = plan(again, localMoment(2030, 3, 13, 12, 10));

    expect(total(pending(again, "essay"))).toBe(600);
    expect(total(pending(third, "essay"))).toBe(600);
  });

  it("accepting some sessions and re-planning keeps the total at the estimate", () => {
    const first = plan(stateWith([essay]));
    const [a, b] = pending(first, "essay");
    const accepted: AppState = {
      ...first,
      scheduleBlocks: first.scheduleBlocks.map((block) => (block.id === a!.id || block.id === b!.id ? { ...block, accepted: true } : block)),
    };
    const replanned = plan(accepted, localMoment(2030, 3, 13, 12, 5));

    expect(total(pending(replanned, "essay"))).toBe(600);
    for (const block of [a!, b!]) expect(replanned.scheduleBlocks.find((x) => x.id === block.id)).toMatchObject({ date: block.date, startTime: block.startTime });
  });

  it("'Replan this week' on a week inside the semester re-plans the whole semester once: no duplicates, events kept", () => {
    const event: ScheduleBlock = {
      id: "dentist", type: "free", title: "Dentist", date: "2030-03-14", startTime: "09:00", endTime: "10:00",
      locked: false, accepted: true, color: "#7C3AED", completionStatus: "pending",
    };
    const base = plan(stateWith([essay]));
    const accepted: AppState = {
      ...base,
      scheduleBlocks: [...base.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b)), event],
    };
    const preview = runReplan(accepted, { scope: "week", weekStart: "2030-03-11" }, NOW);
    const rebuilt = reducer(accepted, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });

    expect(total(pending(rebuilt, "essay"))).toBe(600);
    expect(rebuilt.scheduleBlocks.find((b) => b.id === "dentist")).toEqual(event);
  });
});

describe("named strategist sessions survive a partly covered plan", () => {
  const strategyTask = makeTask({
    id: "exam",
    name: "Biology midterm",
    courseId: "chem",
    dueDate: "2030-03-27",
    kind: "exam",
    estimatedMinutes: 195,
    planningStrategy: {
      rationale: "Spread the topics, finish with retrieval practice.",
      priority: 4,
      sessions: [
        { label: "Learn: Cells", purpose: "learn", minutes: 60, targetDaysBeforeDue: 12, earliestDaysBeforeDue: 14 },
        { label: "Learn: Genetics", purpose: "learn", minutes: 60, targetDaysBeforeDue: 7, earliestDaysBeforeDue: 10 },
        { label: "Final review", purpose: "practice", minutes: 75, targetDaysBeforeDue: 1, earliestDaysBeforeDue: 3 },
      ],
    },
  });
  const labels = (state: AppState) => pending(state, "exam").map((b) => b.strategyLabel).sort();

  it("a fresh plan places each named session once and tags its block with the label", () => {
    const state = plan(stateWith([strategyTask]));

    expect(labels(state)).toEqual(["Final review", "Learn: Cells", "Learn: Genetics"]);
    expect(pending(state, "exam").every((b) => b.title.includes(b.strategyLabel!))).toBe(true);
    expect(total(pending(state, "exam"))).toBe(195);
  });

  it("with one named session accepted (covered), the other named sessions keep their labels in later weeks", () => {
    const first = plan(stateWith([strategyTask]));
    const cells = pending(first, "exam").find((b) => b.strategyLabel === "Learn: Cells")!;
    const accepted: AppState = { ...first, scheduleBlocks: first.scheduleBlocks.map((b) => (b.id === cells.id ? { ...b, accepted: true } : b)) };

    const replanned = plan(accepted, localMoment(2030, 3, 13, 12, 5));

    expect(labels(replanned)).toEqual(["Final review", "Learn: Cells", "Learn: Genetics"]); // no duplicates, none lost
    expect(total(pending(replanned, "exam"))).toBe(195);
    expect(replanned.scheduleBlocks.find((b) => b.id === cells.id)).toMatchObject({ accepted: true, strategyLabel: "Learn: Cells" });
    const final = pending(replanned, "exam").find((b) => b.strategyLabel === "Final review")!;
    expect(final.title).toContain("Final review");
  });

  it("an accepted session without a label (the student's own) credits its minutes instead of duplicating work", () => {
    const first = plan(stateWith([strategyTask]));
    const own: ScheduleBlock = {
      id: "own", type: "study", title: "Study: Biology midterm", date: "2030-03-20", startTime: "19:00", endTime: "20:00",
      locked: false, accepted: true, taskId: "exam", courseId: "chem", color: "#8B5CF6", completionStatus: "pending",
    };
    const withOwn: AppState = { ...first, scheduleBlocks: [...first.scheduleBlocks.filter((b) => b.taskId !== "exam"), own] };
    const replanned = plan(withOwn, localMoment(2030, 3, 13, 12, 5));

    expect(total(pending(replanned, "exam"))).toBe(195);
    expect(pending(replanned, "exam").some((b) => b.strategyLabel === "Final review")).toBe(true);
  });

  it("the honest total holds when the exam is short on time (shortfall reported, no phantom minutes)", () => {
    const tight = { ...strategyTask, dueDate: "2030-03-14" };
    const result = buildSemesterPlan(stateWith([tight]), { now: NOW });
    const placed = total(result.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "exam"));
    const missing = result.shortfalls.find((s) => s.taskId === "exam")?.missingMinutes ?? 0;

    expect(placed + missing).toBe(195);
  });
});
