import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import {
  detectDrift,
  diffPlans,
  MAX_UNDO_SNAPSHOTS,
  previewPlanChange,
  replanSemester,
  undoableChange,
} from "../../src/engine/replan";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { createInitialState, restorePersistedState, toLocalPersistedState } from "../../src/engine/state-persistence";
import { AppState, ScheduleBlock, Semester, Task } from "../../src/engine/types";
import { blockMinutes } from "../../src/engine/task-progress";
import { localMoment, makeBlock, makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

// NOW = Wed 2030-03-13 12:00 local. The plan below was made on Monday morning.
const MONDAY = localMoment(2030, 3, 11, 8, 0);
const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-04-26", breaks: [] };

function baseState(tasks: Task[], extra: Partial<AppState> = {}): AppState {
  return {
    ...createInitialState(),
    onboardingComplete: true,
    classes: [makeClass({ id: "chem", days: ["Mon", "Wed", "Fri"], startTime: "10:00", endTime: "11:00" })],
    semester: SEMESTER,
    tasks,
    ...extra,
  };
}

/** Plan on Monday morning and accept every session, as a student who confirmed the week would have. */
function plannedOnMonday(tasks: Task[]): AppState {
  const state = baseState(tasks);
  const plan = buildSemesterPlan(state, { now: MONDAY });
  return {
    ...state,
    tasks: plan.tasks,
    scheduleBlocks: plan.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b)),
  };
}

const openStudy = (state: AppState, taskId: string) =>
  state.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === taskId && b.completionStatus === "pending");
const minutes = (blocks: ScheduleBlock[]) => blocks.reduce((sum, b) => sum + blockMinutes(b), 0);

// Due this week: the planner works back from each deadline (a week for homework), so only work due soon has sessions
// on Monday-Wednesday morning, before NOW - which is what the drift tests need.
function tasks(): Task[] {
  return [
    makeTask({ id: "essay", name: "History essay", courseId: "chem", courseName: "History", dueDate: "2030-03-15", estimatedMinutes: 240, difficulty: 3 }),
    makeTask({ id: "pset", name: "Chem problem set", courseId: "chem", dueDate: "2030-03-16", estimatedMinutes: 180, difficulty: 4 }),
  ];
}

describe("detectDrift", () => {
  it("counts sessions that ended unfinished as missed, and how far behind the student is", () => {
    const state = plannedOnMonday(tasks());
    const past = state.scheduleBlocks.filter((b) => b.type === "study" && (b.date < TODAY || (b.date === TODAY && b.endTime <= "12:00")));
    expect(past.length).toBeGreaterThan(0);

    const drift = detectDrift(state, NOW);

    expect(drift.missedBlocks.map((b) => b.id).sort()).toEqual(past.map((b) => b.id).sort());
    expect(drift.behindMinutes).toBe(Math.min(minutes(past), 240 + 180));
    expect(drift.severity).not.toBe("none");
  });

  it("does not count finished, started or skipped sessions, sessions of finished tasks, or old history", () => {
    const state = plannedOnMonday(tasks());
    const past = state.scheduleBlocks.filter((b) => b.type === "study" && (b.date < TODAY || (b.date === TODAY && b.endTime <= "12:00")));
    const [first, second, ...others] = past;
    const modified: AppState = {
      ...state,
      scheduleBlocks: state.scheduleBlocks.map((b) => {
        if (b.id === first!.id) return { ...b, completionStatus: "done" as const };
        if (b.id === second?.id) return { ...b, startedAt: "2030-03-11T09:00:00.000Z" };
        if (others.some((o) => o.id === b.id)) return { ...b, completionStatus: "skipped" as const };
        return b;
      }),
    };

    expect(detectDrift(modified, NOW).missedBlocks).toHaveLength(0);
    expect(detectDrift(modified, NOW).severity).toBe("none");

    const old = makeBlock({ id: "old", type: "study", taskId: "essay", date: "2030-02-01", startTime: "10:00", endTime: "12:00" });
    expect(detectDrift({ ...state, scheduleBlocks: [old] }, NOW).missedBlocks).toHaveLength(0);
    const finishedTasks = state.tasks.map((t) => ({ ...t, status: "done" as const }));
    expect(detectDrift({ ...state, tasks: finishedTasks }, NOW).missedBlocks).toHaveLength(0);
  });

  it("overdue open work is always high severity, with all of its remaining minutes counted as behind", () => {
    const overdue = makeTask({ id: "late", name: "Lab report", dueDate: "2030-03-10", estimatedMinutes: 120, completedMinutes: 30 });
    const drift = detectDrift({ tasks: [overdue], scheduleBlocks: [] }, NOW);

    expect(drift.severity).toBe("high");
    expect(drift.overdueTasks.map((t) => [t.taskId, t.daysOverdue])).toEqual([["late", 3]]);
    expect(drift.behindMinutes).toBe(90);
  });

  it("severity grows with the minutes behind: watch from 30 minutes, high from 3 hours", () => {
    const task = makeTask({ id: "t", dueDate: "2030-03-25", estimatedMinutes: 600 });
    const missed = (mins: number): AppState => ({
      ...baseState([task]),
      scheduleBlocks: [makeBlock({ id: "m", type: "study", taskId: "t", date: "2030-03-12", startTime: "10:00", endTime: `${String(10 + Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`, accepted: true })],
    });

    expect(detectDrift(missed(15), NOW).severity).toBe("none");
    expect(detectDrift(missed(45), NOW).severity).toBe("watch");
    expect(detectDrift(missed(200), NOW).severity).toBe("high");
  });
});

describe("replanSemester", () => {
  it("never mutates the state it is given", () => {
    const state = plannedOnMonday(tasks());
    const frozen = JSON.stringify(state);

    replanSemester(state, { now: NOW, reason: "You're behind" });

    expect(JSON.stringify(state)).toBe(frozen);
  });

  it("re-places the minutes of missed sessions in the future and reports what it did", () => {
    const state = plannedOnMonday(tasks());
    const beforeOpenFuture = state.scheduleBlocks.filter((b) => b.type === "study" && b.date >= TODAY && b.completionStatus === "pending").length;
    const preview = replanSemester(state, { now: NOW, reason: "You're behind" });

    expect(preview.label).toBe("You're behind");
    expect(preview.diff.markedMissed.length).toBeGreaterThan(0);
    expect(preview.diff.changed).toBe(true);
    // Missed sessions are recorded as history...
    const missedIds = new Set(preview.diff.markedMissed.map((r) => r.id));
    for (const id of missedIds) expect(preview.next.scheduleBlocks.find((b) => b.id === id)?.completionStatus).toBe("missed");
    // ...and the work they were meant to cover is planned again before the deadlines.
    const next: AppState = { ...state, ...preview.next };
    for (const task of state.tasks) {
      const upcoming = openStudy(next, task.id).filter((b) => b.date >= TODAY && !missedIds.has(b.id));
      const shortfall = preview.shortfalls.find((s) => s.taskId === task.id)?.missingMinutes ?? 0;
      expect(minutes(upcoming) + shortfall).toBe(task.estimatedMinutes);
      expect(upcoming.every((b) => b.date <= task.dueDate)).toBe(true);
    }
    expect(preview.diff.added.length + preview.diff.moved.length).toBeGreaterThan(0);
    expect(preview.diff.unchanged).toBeLessThanOrEqual(beforeOpenFuture + preview.diff.added.length);
    expect(preview.summary).toMatch(/missed session/);
  });

  it("keeps sessions the student accepted where they are (works around them)", () => {
    const state = plannedOnMonday(tasks());
    const preview = replanSemester(state, { now: NOW });
    const acceptedFuture = state.scheduleBlocks.filter((b) => b.type === "study" && b.accepted && b.date >= TODAY && b.completionStatus === "pending");
    expect(acceptedFuture.length).toBeGreaterThan(0);

    for (const block of acceptedFuture) {
      const after = preview.next.scheduleBlocks.find((b) => b.id === block.id);
      expect(after && [after.date, after.startTime, after.endTime]).toEqual([block.date, block.startTime, block.endTime]);
    }
  });

  it("moveAccepted lets the plan reshuffle accepted sessions, but never the student's own edits, locked, started or finished blocks", () => {
    const state = plannedOnMonday([
      ...tasks(),
      makeTask({ id: "reading", name: "Reading log", courseId: "chem", dueDate: "2030-03-29", estimatedMinutes: 300 }),
    ]);
    const future = state.scheduleBlocks.filter((b) => b.type === "study" && (b.date > TODAY || (b.date === TODAY && b.startTime >= "12:15")));
    expect(future.length).toBeGreaterThanOrEqual(4);
    const [edited, locked, ...rest] = future;
    const custom: AppState = {
      ...state,
      scheduleBlocks: state.scheduleBlocks.map((b) => {
        if (b.id === edited!.id) return { ...b, userEdited: true };
        if (b.id === locked!.id) return { ...b, locked: true };
        return b;
      }),
    };
    const preview = replanSemester(custom, { now: NOW, moveAccepted: true });

    expect(preview.next.scheduleBlocks.find((b) => b.id === edited!.id)).toEqual(custom.scheduleBlocks.find((b) => b.id === edited!.id));
    expect(preview.next.scheduleBlocks.find((b) => b.id === locked!.id)).toEqual(custom.scheduleBlocks.find((b) => b.id === locked!.id));
    // Untouched accepted sessions were released back to the planner (they come back as suggestions). Their ids only
    // survive when a session lands on the same day with the same number, so check that none is still pinned instead.
    expect(rest.every((b) => preview.next.scheduleBlocks.find((n) => n.id === b.id)?.accepted !== true)).toBe(true);
    expect(preview.next.scheduleBlocks.filter((b) => b.type === "study" && b.completionStatus === "pending" && !b.accepted).length).toBeGreaterThan(0);
  });

  it("a plan that already fits says so and changes nothing", () => {
    const state = plannedOnMonday(tasks());
    const caughtUp: AppState = {
      ...state,
      // Finish everything that is already in the past.
      scheduleBlocks: state.scheduleBlocks.map((b) => (b.type === "study" && (b.date < TODAY || (b.date === TODAY && b.endTime <= "12:00")) ? { ...b, completionStatus: "done" as const } : b)),
    };
    const done = reducer(caughtUp, { type: "REGENERATE_WEEK", payload: { now: NOW } });
    const preview = replanSemester(done, { now: NOW });

    expect(preview.diff.changed).toBe(false);
    expect(preview.diff.markedMissed).toHaveLength(0);
    expect(preview.summary).toContain("already fits");
  });

  it("shortfalls stay visible: work that cannot fit even after re-planning is listed with the minutes missing", () => {
    const huge = makeTask({ id: "huge", name: "Thesis draft", courseId: "chem", dueDate: "2030-03-14", estimatedMinutes: 900 });
    const state = baseState([huge]);
    const preview = replanSemester(state, { now: NOW });

    expect(preview.shortfalls.map((s) => s.taskId)).toEqual(["huge"]);
    expect(preview.diff.byTask.find((t) => t.taskId === "huge")?.missingMinutes).toBeGreaterThan(0);
    expect(preview.summary).toContain("Still short");
  });
});

describe("diffPlans", () => {
  const ctx = { tasks: tasks(), recurringEvents: [], now: NOW };
  const s = (id: string, date: string, start: string, end: string, taskId = "essay", extra: Partial<ScheduleBlock> = {}) =>
    makeBlock({ id, type: "study", taskId, title: `Work on: ${taskId}`, date, startTime: start, endTime: end, ...extra });

  it("reports a session that changed day as moved (paired with the nearest replacement), not as removed + added", () => {
    const diff = diffPlans([s("a", "2030-03-14", "15:00", "16:00")], [s("b", "2030-03-15", "15:00", "16:00")], ctx);

    expect(diff.moved).toEqual([{ id: "b", title: "Work on: essay", taskId: "essay", taskName: "History essay", from: { date: "2030-03-14", startTime: "15:00", endTime: "16:00" }, to: { date: "2030-03-15", startTime: "15:00", endTime: "16:00" } }]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("a session that keeps its slot is unchanged even when its id and numbering changed", () => {
    const diff = diffPlans(
      [s("study-essay-1-2030-03-14", "2030-03-14", "15:00", "16:00", "essay", { title: "Work on: Essay (1/2)" })],
      [s("study-essay-2-2030-03-14", "2030-03-14", "15:00", "16:00", "essay", { title: "Work on: Essay (2/3)" })],
      ctx,
    );

    expect(diff.unchanged).toBe(1);
    expect(diff.changed).toBe(false);
  });

  it("lists added and removed sessions grouped by task", () => {
    const diff = diffPlans(
      [s("a", "2030-03-14", "15:00", "16:00")],
      [s("a", "2030-03-14", "15:00", "16:00"), s("n1", "2030-03-16", "10:00", "11:00", "pset"), s("n2", "2030-03-17", "10:00", "11:00", "pset")],
      ctx,
    );

    expect(diff.added.map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(diff.byTask.map((t) => [t.taskName, t.added.length, t.unchanged])).toEqual([["Chem problem set", 2, 0]].concat([]));
    const removed = diffPlans([s("a", "2030-03-14", "15:00", "16:00")], [], ctx);
    expect(removed.removed.map((r) => r.id)).toEqual(["a"]);
  });

  it("ignores structural blocks (classes, sleep) and anything already in the past", () => {
    const cls = makeBlock({ id: "c", type: "class", title: "Chem", date: "2030-03-15", startTime: "10:00", endTime: "11:00" });
    const pastStudy = s("p", "2030-03-12", "10:00", "11:00");
    const diff = diffPlans([cls, pastStudy], [], ctx);

    expect(diff.changed).toBe(false);
    expect(diff.removed).toHaveLength(0);
  });

  it("tracks non-study blocks (events) by id: moved, added, removed", () => {
    const ev = (id: string, date: string, start: string) => makeBlock({ id, type: "free", title: "Dentist", date, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00` });
    const diff = diffPlans([ev("e1", "2030-03-15", "09:00"), ev("gone", "2030-03-16", "09:00")], [ev("e1", "2030-03-15", "13:00"), ev("new", "2030-03-17", "09:00")], ctx);

    expect(diff.moved.map((m) => m.id)).toEqual(["e1"]);
    expect(diff.added.map((r) => r.id)).toEqual(["new"]);
    expect(diff.removed.map((r) => r.id)).toEqual(["gone"]);
    expect(diff.byTask[0]!.taskName).toBe("Other changes");
  });
});

describe("previewPlanChange (assistant / input changes)", () => {
  it("previews a new task and the sessions it adds without touching the current state", () => {
    const before = plannedOnMonday(tasks());
    const frozen = JSON.stringify(before);
    const extra = makeTask({ id: "new", name: "Lab report", courseId: "chem", dueDate: "2030-03-25", estimatedMinutes: 120 });
    const after: AppState = { ...before, tasks: [...before.tasks, extra] };

    const preview = previewPlanChange(before, after, { now: NOW, label: "Add Lab report" });

    expect(JSON.stringify(before)).toBe(frozen);
    expect(preview.diff.byTask.find((t) => t.taskId === "new")?.added.length).toBeGreaterThan(0);
    expect(preview.next.tasks.find((t) => t.id === "new")?.status).toBe("scheduled");
    expect(preview.next.classes).toBeUndefined(); // untouched inputs are not part of the patch
  });

  it("includes changed classes / recurring events / sleep window in the patch", () => {
    const before = plannedOnMonday(tasks());
    const after: AppState = { ...before, healthPrefs: { ...before.healthPrefs, bedtime: "01:00" }, recurringEvents: [{ id: "r", title: "Job", days: ["Tue"], startTime: "14:00", endTime: "17:00", color: "#06B6D4", locked: true }] };
    const preview = previewPlanChange(before, after, { now: NOW, label: "Assistant change" });

    expect(preview.next.healthPrefs?.bedtime).toBe("01:00");
    expect(preview.next.recurringEvents).toHaveLength(1);
    expect(preview.next.classes).toBeUndefined();
  });
});

describe("APPLY_REPLAN / UNDO_REPLAN", () => {
  const AT = "2030-03-13T12:00:00.000Z";

  it("applies a previewed plan and undo restores the schedule and tasks exactly", () => {
    const state = plannedOnMonday(tasks());
    const preview = replanSemester(state, { now: NOW, reason: "You're behind" });

    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: AT, next: preview.next } });
    expect(applied.scheduleBlocks).toEqual(preview.next.scheduleBlocks);
    expect(applied.tasks).toEqual(preview.next.tasks);
    expect(applied.undoSnapshots).toHaveLength(1);
    expect(applied.undoSnapshots![0]).toMatchObject({ label: "You're behind", at: AT });

    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks).toEqual(state.scheduleBlocks);
    expect(undone.tasks).toEqual(state.tasks);
    expect(undone.undoSnapshots).toBeUndefined();
  });

  it("keeps only the last three snapshots and undoes them newest first", () => {
    let state = plannedOnMonday(tasks());
    const original = state.scheduleBlocks;
    const labels: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const label = `change ${i}`;
      labels.push(label);
      const next = { scheduleBlocks: state.scheduleBlocks.filter((_, idx) => idx !== 0), tasks: state.tasks };
      state = reducer(state, { type: "APPLY_REPLAN", payload: { label, at: AT, next } });
    }

    expect(MAX_UNDO_SNAPSHOTS).toBe(3);
    expect(state.undoSnapshots!.map((s) => s.label)).toEqual(["change 4", "change 3", "change 2"]);
    expect(state.scheduleBlocks).toHaveLength(original.length - 4);

    state = reducer(state, { type: "UNDO_REPLAN" });
    expect(state.scheduleBlocks).toHaveLength(original.length - 3);
    state = reducer(state, { type: "UNDO_REPLAN" });
    state = reducer(state, { type: "UNDO_REPLAN" });
    expect(state.scheduleBlocks).toHaveLength(original.length - 1); // the oldest change was evicted and cannot be undone
    expect(reducer(state, { type: "UNDO_REPLAN" })).toBe(state);
  });

  it("a change that also edits classes / recurring events / sleep restores them on undo", () => {
    const before = plannedOnMonday(tasks());
    const after: AppState = { ...before, healthPrefs: { ...before.healthPrefs, wakeTime: "09:00" }, classes: [] };
    const preview = previewPlanChange(before, after, { now: NOW, label: "Assistant" });

    const applied = reducer(before, { type: "APPLY_REPLAN", payload: { label: "Assistant", at: AT, next: preview.next } });
    expect(applied.classes).toEqual([]);
    expect(applied.healthPrefs.wakeTime).toBe("09:00");

    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.classes).toEqual(before.classes);
    expect(undone.healthPrefs).toEqual(before.healthPrefs);
    expect(undone.scheduleBlocks).toEqual(before.scheduleBlocks);
  });

  it("snapshots are never persisted, and a saved file that carries some loads without them", () => {
    const state = plannedOnMonday(tasks());
    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: "x", at: AT, next: { scheduleBlocks: [], tasks: state.tasks } } });

    expect(toLocalPersistedState(applied)).not.toHaveProperty("undoSnapshots");
    expect(JSON.stringify(toLocalPersistedState(applied))).not.toContain("undoSnapshots");
    const reloaded = restorePersistedState(JSON.parse(JSON.stringify({ ...applied, undoSnapshots: applied.undoSnapshots })));
    expect(reloaded.undoSnapshots).toBeUndefined();
  });

  it("Undo stays offered until the next change (no time limit); a later edit drops it so it never discards that edit", () => {
    const state = plannedOnMonday(tasks());
    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: "x", at: NOW.toISOString(), next: { scheduleBlocks: state.scheduleBlocks, tasks: state.tasks } } });

    expect(undoableChange(applied, new Date(NOW.getTime() + 60_000))?.label).toBe("x");
    expect(undoableChange(applied, new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000))?.label).toBe("x"); // was: gone after 30 min
    expect(undoableChange(state, NOW)).toBeUndefined();
    const study = applied.scheduleBlocks.find((b) => b.type === "study" && b.completionStatus === "pending")!;
    expect(undoableChange(reducer(applied, { type: "COMPLETE_BLOCK", payload: study.id }))).toBeUndefined();
  });
});
