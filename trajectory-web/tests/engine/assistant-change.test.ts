import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { applyAssistantChange, isEmptyChange, previewAssistantChange } from "../../src/engine/assistant-change";
import { previewFixMyDay } from "../../src/engine/replan";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { createInitialState } from "../../src/engine/state-persistence";
import { AppState, ScheduleBlock, Semester } from "../../src/engine/types";
import { localMoment, makeBlock, makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-04-26", breaks: [] };
const AT = "2030-03-13T12:00:00.000Z";

function planned(): AppState {
  const state: AppState = {
    ...createInitialState(),
    onboardingComplete: true,
    semester: SEMESTER,
    classes: [makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "11:00" })],
    tasks: [makeTask({ id: "pset", name: "Chem problem set", dueDate: "2030-03-22", estimatedMinutes: 180 })],
  };
  const plan = buildSemesterPlan(state, { now: NOW });
  return { ...state, tasks: plan.tasks, scheduleBlocks: plan.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b)) };
}

describe("applyAssistantChange", () => {
  it("returns a new state and never touches the one it was given", () => {
    const state = planned();
    const frozen = JSON.stringify(state);
    const after = applyAssistantChange(state, {
      label: "x",
      newTasks: [makeTask({ id: "lab", dueDate: "2030-03-25" })],
      newClasses: [makeClass({ id: "bio", name: "Biology" })],
      sleepUpdate: { wakeTime: "09:00" },
    });

    expect(JSON.stringify(state)).toBe(frozen);
    expect(after.tasks.map((t) => t.id)).toEqual(["pset", "lab"]);
    expect(after.tasks[1]!.priorityScore).toBeGreaterThan(0); // scored like ADD_TASK
    expect(after.classes.map((c) => c.id)).toEqual(["chem", "bio"]);
    expect(after.healthPrefs).toMatchObject({ wakeTime: "09:00", bedtime: state.healthPrefs.bedtime });
  });

  it("edited blocks move, are locked and count as the student's decision", () => {
    const state = planned();
    const block = state.scheduleBlocks.find((b) => b.type === "study" && b.date > TODAY)!;
    const after = applyAssistantChange(state, { label: "x", blockEdits: [{ id: block.id, startTime: "19:00", endTime: "20:00" }] });

    expect(after.scheduleBlocks.find((b) => b.id === block.id)).toMatchObject({ startTime: "19:00", endTime: "20:00", locked: true, userEdited: true, accepted: true });
  });

  it("skips a proposed event that duplicates an edited block or a block that already exists", () => {
    const existing = makeBlock({ id: "dentist", type: "free", title: "Dentist", date: "2030-03-20", startTime: "09:00", endTime: "10:00" });
    const state: AppState = { ...planned(), scheduleBlocks: [existing] };
    const dupNew = makeBlock({ id: "n1", type: "free", title: " dentist ", date: "2030-03-20", startTime: "09:00", endTime: "10:00" });
    const fresh = makeBlock({ id: "n2", type: "free", title: "Haircut", date: "2030-03-21", startTime: "09:00", endTime: "10:00" });
    const after = applyAssistantChange(state, { label: "x", newBlocks: [dupNew, fresh], blockEdits: [{ id: "dentist", startTime: "11:00", endTime: "12:00" }] });

    expect(after.scheduleBlocks.map((b) => b.id)).toEqual(["dentist", "n2"]);
    expect(after.scheduleBlocks[0]!.startTime).toBe("11:00");
  });

  it("isEmptyChange", () => {
    expect(isEmptyChange({ label: "x" })).toBe(true);
    expect(isEmptyChange({ label: "x", newTasks: [makeTask()] })).toBe(false);
    expect(isEmptyChange({ label: "x", sleepUpdate: {} })).toBe(true);
  });
});

describe("assistant change -> preview -> apply -> undo", () => {
  it("previews the sessions a new task adds, and nothing changes until it is applied", () => {
    const state = planned();
    const frozen = JSON.stringify(state);
    const change = { label: "Add Lab report", newTasks: [makeTask({ id: "lab", name: "Lab report", courseId: "chem", dueDate: "2030-03-26", estimatedMinutes: 120 })] };

    const preview = previewAssistantChange(state, change, { now: NOW });

    expect(JSON.stringify(state)).toBe(frozen);
    expect(preview.diff.byTask.find((t) => t.taskId === "lab")?.added.length).toBeGreaterThan(0);
    expect(preview.next.tasks.map((t) => t.id)).toContain("lab");
  });

  it("applying stores an undo snapshot and undo restores tasks, classes, recurring events, sleep and blocks exactly", () => {
    const state = planned();
    const change = {
      label: "Big change",
      newTasks: [makeTask({ id: "lab", courseId: "chem", dueDate: "2030-03-26" })],
      newClasses: [makeClass({ id: "bio", name: "Biology", days: ["Tue"] })],
      newRecurringEvents: [{ id: "job", title: "Job", days: ["Thu" as const], startTime: "15:00", endTime: "19:00", color: "#06B6D4", locked: true }],
      sleepUpdate: { bedtime: "00:30" },
    };
    const preview = previewAssistantChange(state, change, { now: NOW });

    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: AT, next: preview.next } });
    expect(applied.classes.map((c) => c.id)).toEqual(["chem", "bio"]);
    expect(applied.recurringEvents.map((e) => e.id)).toEqual(["job"]);
    expect(applied.healthPrefs.bedtime).toBe("00:30");
    expect(applied.undoSnapshots?.[0]?.label).toBe("Big change");

    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.classes).toEqual(state.classes);
    expect(undone.recurringEvents).toEqual(state.recurringEvents);
    expect(undone.healthPrefs).toEqual(state.healthPrefs);
    expect(undone.tasks).toEqual(state.tasks);
    expect(undone.scheduleBlocks).toEqual(state.scheduleBlocks);
  });

  it("a plain edit of one block previews as a single move and can be previewed without re-planning", () => {
    const state = planned();
    const block = state.scheduleBlocks.find((b) => b.type === "study" && b.date > TODAY)!;
    const preview = previewAssistantChange(state, { label: "Move", blockEdits: [{ id: block.id, startTime: "20:00", endTime: "21:00" }] }, { now: NOW, replan: false });

    expect(preview.diff.moved.map((m) => [m.id, m.to.startTime])).toEqual([[block.id, "20:00"]]);
    expect(preview.diff.added).toHaveLength(0);
    expect(preview.diff.removed).toHaveLength(0);
  });
});

describe("previewFixMyDay", () => {
  const study = (id: string, start: string, end: string, extra: Partial<ScheduleBlock> = {}): ScheduleBlock =>
    makeBlock({ id, type: "study", taskId: "t", title: `Work on: ${id}`, date: TODAY, startTime: start, endTime: end, accepted: true, ...extra });

  it("lists what moves (with 'Missed earlier') and does not change the blocks it was given", () => {
    const blocks = [study("morning", "09:00", "10:00"), study("evening", "19:00", "20:00")];
    const frozen = JSON.stringify(blocks);
    const preview = previewFixMyDay(
      { scheduleBlocks: blocks, tasks: [makeTask({ id: "t", name: "Essay", estimatedMinutes: 120 })], healthPrefs: createInitialState().healthPrefs },
      TODAY, "protect_sleep", { now: NOW },
    );

    expect(JSON.stringify(blocks)).toBe(frozen);
    expect(preview.diff.moved).toHaveLength(1);
    expect(preview.diff.moved[0]).toMatchObject({ id: "morning", note: "Missed earlier", taskName: "Essay" });
    expect(preview.diff.moved[0]!.to.startTime >= "12:00").toBe(true);
    expect(preview.next.scheduleBlocks.find((b) => b.id === "morning")?.accepted).toBe(true);
    expect(preview.summary).toContain("moves 1 session");
  });

  it("reports sessions that do not fit with the reason, and applying it can be undone", () => {
    const late = localMoment(2030, 3, 13, 22, 0);
    const state: AppState = { ...createInitialState(), tasks: [makeTask({ id: "t" })], scheduleBlocks: [study("missed", "20:00", "21:30")] };
    const preview = previewFixMyDay(state, TODAY, "protect_sleep", { now: late });

    expect(preview.unplaced).toHaveLength(1);
    expect(preview.unplaced[0]!.reason).toMatch(/No free slot|no free slot/);
    expect(preview.summary).toContain("will not fit today");

    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: AT, next: preview.next } });
    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks).toEqual(state.scheduleBlocks);
  });

  it("a day that already fits changes nothing", () => {
    const preview = previewFixMyDay(
      { scheduleBlocks: [study("later", "15:00", "16:00")], tasks: [makeTask({ id: "t" })], healthPrefs: createInitialState().healthPrefs },
      TODAY, "protect_sleep", { now: NOW },
    );
    expect(preview.diff.changed).toBe(false);
    expect(preview.summary).toContain("already fits");
  });
});
