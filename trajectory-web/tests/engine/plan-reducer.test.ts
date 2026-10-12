import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer, runReplan } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { AppState, ScheduleBlock, Semester, Task } from "../../src/engine/types";
import { addDaysToKey, parseLocalDate, weekStartKeyOf } from "../../src/engine/utils";
import { makeBlock, makeClass, makeTask, NOW } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), onboardingComplete: true, semester: SEMESTER, ...overrides };
}

const session = (id: string, taskId: string, date: string, start: string, end: string, extra: Partial<ScheduleBlock> = {}): ScheduleBlock =>
  makeBlock({ id, type: "study", taskId, date, startTime: start, endTime: end, accepted: false, ...extra });

describe("whole-semester build actions", () => {
  const tasks: Task[] = [
    makeTask({ id: "a", name: "Problem set 1", dueDate: "2030-03-20", estimatedMinutes: 120 }),
    makeTask({ id: "b", name: "Lab report", dueDate: "2030-04-12", estimatedMinutes: 180 }),
    makeTask({ id: "c", name: "Midterm exam", dueDate: "2030-04-24", estimatedMinutes: 300 }),
  ];
  const study = (s: AppState) => s.scheduleBlocks.filter((b) => b.type === "study");

  it("AUTO_BUILD_WEEK plans every week of the semester at once (a syllabus import needs no per-week navigation)", () => {
    const built = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
    const weeks = new Set(study(built).map((b) => weekStartKeyOf(b.date)));

    expect(weeks.size).toBeGreaterThanOrEqual(3);
    expect([...weeks].some((w) => w >= "2030-04-08")).toBe(true); // work due four weeks out is already on the calendar
    expect(built.tasks.every((t) => t.status === "scheduled")).toBe(true);
  });

  it("REGENERATE_WEEK does the same (existing callers keep working)", () => {
    const built = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "REGENERATE_WEEK", payload: { now: NOW } });
    expect(new Set(study(built).map((b) => weekStartKeyOf(b.date))).size).toBeGreaterThanOrEqual(3);
  });

  it("a week far beyond the planned horizon is still built when the student browses to it", () => {
    const far = parseLocalDate("2030-09-02");
    const built = reducer(stateWith({ classes: [makeClass()], tasks: [] }), { type: "AUTO_BUILD_WEEK", payload: { weekStart: far, now: NOW } });

    expect(built.scheduleBlocks.some((b) => b.date === "2030-09-02" && b.type === "sleep")).toBe(true);
  });

  it("BUILD_WEEK_FOR leaves a week inside the planned horizon alone once it has its structure", () => {
    const built = reducer(stateWith({ classes: [makeClass()], tasks }), { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
    expect(reducer(built, { type: "BUILD_WEEK_FOR", payload: { weekStart: parseLocalDate("2030-04-08"), now: NOW } })).toBe(built);
  });

  it("'Move to tomorrow' (previewed, then applied) re-plans the deferred work and everything after it", () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const task = makeTask({ id: "d", dueDate: addDaysToKey(today, 10), estimatedMinutes: 60 });
    const state = stateWith({
      semester: undefined, tasks: [task], scheduleBlocks: [session("d1", "d", today, "23:00", "23:45", { accepted: true })],
    });
    const preview = runReplan(state, { scope: "today", mode: "defer", date: today }, now);
    const after = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: now.toISOString(), next: preview.next } });
    const sessions = after.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "d" && b.completionStatus === "pending");

    expect(after.tasks[0]!.notBeforeDate).toBe(addDaysToKey(today, 1));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((b) => b.date >= addDaysToKey(today, 1))).toBe(true);
  });
});

describe("completing blocks credits the task exactly once", () => {
  const task = makeTask({ id: "t", name: "Essay", dueDate: "2030-03-20", estimatedMinutes: 120 });
  const two = (): AppState => stateWith({
    tasks: [{ ...task, status: "scheduled" }],
    scheduleBlocks: [session("s1", "t", "2030-03-14", "10:00", "11:00"), session("s2", "t", "2030-03-15", "10:00", "11:00")],
  });

  it("the task stays scheduled until the completed minutes cover its estimate", () => {
    const first = reducer(two(), { type: "COMPLETE_BLOCK", payload: "s1" });
    expect(first.tasks[0]).toMatchObject({ completedMinutes: 60, status: "scheduled" });
    expect(first.scheduleBlocks.find((b) => b.id === "s1")).toMatchObject({ completionStatus: "done", accepted: true });

    const second = reducer(first, { type: "COMPLETE_BLOCK", payload: "s2" });
    expect(second.tasks[0]).toMatchObject({ completedMinutes: 120, status: "done" });
  });

  it("completing an already finished block does not credit it twice", () => {
    const once = reducer(two(), { type: "COMPLETE_BLOCK", payload: "s1" });
    const twice = reducer(once, { type: "COMPLETE_BLOCK", payload: "s1" });

    expect(twice.tasks[0]!.completedMinutes).toBe(60);
    expect(twice).toBe(once);
  });

  it("un-completing reverts the credit and re-opens a finished task", () => {
    let state = reducer(two(), { type: "COMPLETE_BLOCK", payload: "s1" });
    state = reducer(state, { type: "COMPLETE_BLOCK", payload: "s2" });
    expect(state.tasks[0]!.status).toBe("done");

    const reopened = reducer(state, { type: "UNCOMPLETE_BLOCK", payload: "s2" });
    expect(reopened.tasks[0]).toMatchObject({ completedMinutes: 60, status: "scheduled" });
    expect(reopened.scheduleBlocks.find((b) => b.id === "s2")!.completionStatus).toBe("pending");
  });

  it("skipping a finished block also takes its minutes back", () => {
    const done = reducer(two(), { type: "COMPLETE_BLOCK", payload: "s1" });
    const skipped = reducer(done, { type: "SKIP_BLOCK", payload: "s1" });
    expect(skipped.tasks[0]!.completedMinutes).toBe(0);
  });

  it("the generic UPDATE_BLOCK path keeps the ledger straight too (any sheet may flip the status)", () => {
    const done = reducer(two(), { type: "UPDATE_BLOCK", payload: { id: "s1", completionStatus: "done" } });
    expect(done.tasks[0]!.completedMinutes).toBe(60);
    const undone = reducer(done, { type: "UPDATE_BLOCK", payload: { id: "s1", completionStatus: "pending" } });
    expect(undone.tasks[0]!.completedMinutes).toBe(0);
  });

  it("a completed block of another kind (a class) never touches tasks", () => {
    const state = stateWith({ tasks: [task], scheduleBlocks: [makeBlock({ id: "c1", type: "class", taskId: undefined })] });
    expect(reducer(state, { type: "COMPLETE_BLOCK", payload: "c1" }).tasks).toEqual([task]);
  });
});

describe("manual edits are decisions the planner must keep", () => {
  const state = stateWith({ scheduleBlocks: [session("s1", "t", "2030-03-14", "10:00", "11:00")] });

  it("moving or resizing a block marks it userEdited", () => {
    expect(reducer(state, { type: "UPDATE_BLOCK", payload: { id: "s1", startTime: "13:00", endTime: "14:00" } }).scheduleBlocks[0]!.userEdited).toBe(true);
    expect(reducer(state, { type: "UPDATE_BLOCK", payload: { id: "s1", date: "2030-03-15" } }).scheduleBlocks[0]!.userEdited).toBe(true);
  });

  it("bookkeeping updates (notification id, started time, same time) do not", () => {
    expect(reducer(state, { type: "UPDATE_BLOCK", payload: { id: "s1", notificationId: "n1" } }).scheduleBlocks[0]!.userEdited).toBeUndefined();
    expect(reducer(state, { type: "UPDATE_BLOCK", payload: { id: "s1", startedAt: "2030-03-14T10:00:00.000Z", accepted: true } }).scheduleBlocks[0]!.userEdited).toBeUndefined();
    expect(reducer(state, { type: "UPDATE_BLOCK", payload: { id: "s1", startTime: "10:00" } }).scheduleBlocks[0]!.userEdited).toBeUndefined();
  });

  it("a manually moved session survives the next whole-semester plan in its new slot", () => {
    const task = makeTask({ id: "t", dueDate: "2030-03-20", estimatedMinutes: 60 });
    let s = reducer(stateWith({ tasks: [task], classes: [makeClass()] }), { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
    const block = s.scheduleBlocks.find((b) => b.type === "study" && b.taskId === "t")!;
    s = reducer(s, { type: "UPDATE_BLOCK", payload: { id: block.id, date: "2030-03-19", startTime: "20:00", endTime: "21:00" } });
    s = reducer(s, { type: "REGENERATE_WEEK", payload: { now: NOW } });

    const kept = s.scheduleBlocks.find((b) => b.id === block.id);
    expect(kept).toMatchObject({ date: "2030-03-19", startTime: "20:00", endTime: "21:00", userEdited: true });
    expect(s.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === "t")).toHaveLength(1); // the moved one covers it
  });
});

describe("tasks and their sessions", () => {
  it("deleting a task removes its upcoming sessions but keeps finished ones as history", () => {
    const state = stateWith({
      tasks: [makeTask({ id: "t" })],
      scheduleBlocks: [
        session("open", "t", "2030-03-14", "10:00", "11:00", { accepted: true }),
        session("done", "t", "2030-03-12", "10:00", "11:00", { completionStatus: "done" }),
        session("other", "u", "2030-03-14", "12:00", "13:00"),
      ],
    });
    const after = reducer(state, { type: "DELETE_TASK", payload: "t" });

    expect(after.tasks).toHaveLength(0);
    expect(after.scheduleBlocks.map((b) => b.id).sort()).toEqual(["done", "other"]);
  });

  it("marking a task done counts all of its estimated work as finished", () => {
    const state = stateWith({ tasks: [makeTask({ id: "t", estimatedMinutes: 90, completedMinutes: 20 })] });
    expect(reducer(state, { type: "COMPLETE_TASK", payload: "t" }).tasks[0]).toMatchObject({ status: "done", completedMinutes: 90 });
  });

});
