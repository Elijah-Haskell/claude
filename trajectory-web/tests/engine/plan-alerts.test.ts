import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { currentSolverShortfalls, planAlertFor, planQualityFor, planStatusFor } from "../../src/engine/plan-alerts";
import { replanSemester } from "../../src/engine/replan";
import { createInitialState, parsePersistedState, restorePersistedState, toLocalPersistedState } from "../../src/engine/state-persistence";
import { AppState, DEFAULT_USER_PREFS, ScheduleBlock, Task } from "../../src/engine/types";
import { makeBlock, makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

function built(tasks = [makeTask({ id: "huge", name: "Thesis draft", courseId: "chem", dueDate: "2030-03-15", estimatedMinutes: 2400 })]): AppState {
  const state: AppState = { ...createInitialState(), onboardingComplete: true, classes: [makeClass()], tasks };
  return reducer(state, { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });
}

describe("plan alerts (Week, Today and Tasks share one capacity message)", () => {
  it("every whole-semester plan records what does not fit", () => {
    const state = built();

    expect(state.planAlerts?.shortfalls.map((s) => s.taskId)).toEqual(["huge"]);
    expect(state.planAlerts!.shortfalls[0]!.missingMinutes).toBeGreaterThan(0);
    expect(state.planAlerts!.computedAt).toBe(NOW.toISOString());
  });

  it("a healthy plan records no shortfalls and yields no alert", () => {
    const state = built([makeTask({ id: "ok", dueDate: "2030-03-25", estimatedMinutes: 60 })]);

    expect(state.planAlerts?.shortfalls).toEqual([]);
    expect(planAlertFor(state, NOW)).toBeNull();
  });

  it("the alert names the missing time, the deadline and the task to open", () => {
    const alert = planAlertFor(built(), NOW)!;

    expect(alert.severity).toBe("critical");
    expect(alert.taskId).toBe("huge");
    expect(alert.message).toMatch(/You need ~\d+ more hours before Fri to finish Thesis draft/);
  });

  it("the solver's word about capacity reaches the plan-quality report (it cannot be inferred from the calendar alone)", () => {
    const state = built();
    const report = planQualityFor(state, TODAY);

    expect(report.shortfalls.map((s) => s.taskId)).toEqual(["huge"]);
    expect(planQualityFor({ ...state, planAlerts: undefined }, TODAY).shortfalls.length).toBeLessThanOrEqual(report.shortfalls.length);
  });

  it("stays honest between plans: finished tasks drop out and the number never exceeds what the task still needs", () => {
    const state = built();
    const partly: AppState = { ...state, tasks: state.tasks.map((t) => ({ ...t, completedMinutes: 2380 })) };
    const done: AppState = { ...state, tasks: state.tasks.map((t) => ({ ...t, status: "done" as const })) };

    expect(currentSolverShortfalls(partly)[0]!.missingMinutes).toBe(20);
    expect(currentSolverShortfalls(done)).toEqual([]);
  });

  it("APPLY_REPLAN refreshes the alerts and UNDO_REPLAN brings the previous ones back", () => {
    const state = built();
    const relaxed: AppState = { ...state, tasks: state.tasks.map((t) => ({ ...t, dueDate: "2030-04-26" })) };
    const preview = replanSemester(relaxed, { now: NOW, reason: "Deadline moved" });
    expect(preview.next.planAlerts?.shortfalls).toEqual([]);

    const applied = reducer(relaxed, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });
    expect(applied.planAlerts?.shortfalls).toEqual([]);
    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.planAlerts).toEqual(relaxed.planAlerts);
  });

  it("persists compactly, and malformed saved alerts are dropped", () => {
    const state = built();
    const reloaded = parsePersistedState(JSON.stringify(toLocalPersistedState(state)))!;

    expect(reloaded.planAlerts).toEqual(state.planAlerts);
    expect(restorePersistedState({ planAlerts: "nope" }).planAlerts).toBeUndefined();
    expect(restorePersistedState({ planAlerts: { shortfalls: [{ nope: 1 }], overdueTasks: [] } }).planAlerts?.shortfalls).toEqual([]);
  });
});

describe("planStatusFor (one plan status for Today's card, Week's pill and the review sheet)", () => {
  // NOW is Wed 2030-03-13 12:00.
  const plan = (tasks: Task[], scheduleBlocks: ScheduleBlock[] = []) => ({ tasks, scheduleBlocks, planAlerts: undefined });
  const quiz = () => makeTask({ id: "quiz", name: "Quiz 4", kind: "quiz", dueDate: "2030-03-12" });
  const late = () => makeTask({ id: "late", name: "Lab report", dueDate: "2030-03-11", estimatedMinutes: 120 });
  const homework = () => makeTask({ id: "hw", name: "Problem set 3", dueDate: "2030-03-20", estimatedMinutes: 60 });
  const session = (taskId: string, date: string) => makeBlock({ taskId, date, startTime: "15:00", endTime: "16:00", accepted: false });

  it("is null when the plan needs nothing from the student", () => {
    expect(planStatusFor(plan([homework()], [session("hw", "2030-03-14")]), NOW)).toBeNull();
  });

  it("a quiz whose date passed is listed to record (done / skipped), never as overdue, and catching up does not help", () => {
    const status = planStatusFor(plan([quiz()]), NOW)!;

    expect(status.items.map((item) => [item.kind, item.title])).toEqual([["record", "Quiz 4"]]);
    expect(status.items[0]!.fix).toEqual({ kind: "record", taskId: "quiz" });
    expect(status.items[0]!.detail).toBe("Took place yesterday · mark it done or skipped");
    expect(status.headline).toBe("Quiz 4 took place");
    expect(status.summary).toBe("Quiz 4 to record");
    expect(status.counts.overdue).toBe(0);
    expect(`${status.headline} ${status.summary}`).not.toMatch(/overdue|behind/i);
    expect(status.severity).toBe("warning");
    expect(status.canCatchUp).toBe(false);
  });

  it("merges drift, overdue work and passed quizzes into one headline, one count line and one item each", () => {
    const status = planStatusFor(plan([late(), quiz(), homework()], [session("hw", "2030-03-12"), session("hw", "2030-03-14")]), NOW)!;

    expect(status.headline).toBe("Behind plan");
    expect(status.summary).toBe("1 overdue · ~3 h behind · Quiz 4 to record");
    expect(status.items.map((item) => item.kind)).toEqual(["overdue", "missed", "record"]);
    expect(status.items[0]).toMatchObject({ title: "Lab report", detail: "Was due Mar 11 · ~2 hours of work left", fix: { kind: "editTask", taskId: "late" } });
    expect(status.items[1]).toMatchObject({ title: "Missed sessions", detail: "1 session slipped · ~1 hour to plan again", fix: { kind: "catchUp" } });
    expect(status.severity).toBe("critical");
    expect(status.canCatchUp).toBe(true);
  });

  it("lists work that is both overdue and short on time once, as overdue", () => {
    const status = planStatusFor(plan([late()], [session("late", "2030-03-14")]), NOW)!;

    expect(status.items.map((item) => [item.kind, item.taskId])).toEqual([["overdue", "late"]]);
    expect(status.counts.short).toBe(0);
  });

  it("names the missing time and the deadline of work that will not fit, with the task to edit", () => {
    const status = planStatusFor(built(), NOW)!;

    expect(status.headline).toBe("Short on time");
    expect(status.items).toHaveLength(1);
    expect(status.items[0]).toMatchObject({ kind: "short", title: "Thesis draft", fix: { kind: "editTask", taskId: "huge" } });
    expect(status.items[0]!.detail).toMatch(/^Needs ~\d+ more hours before Fri$/);
    expect(status.summary).toBe("1 short on time");
    expect(status.canCatchUp).toBe(false);
  });

  it("work with no session on the calendar can be replanned", () => {
    const status = planStatusFor(plan([homework()]), NOW)!;

    expect(status.headline).toBe("Not planned yet");
    expect(status.items).toEqual([expect.objectContaining({ kind: "unplanned", taskId: "hw", fix: { kind: "replan" } })]);
  });

  it("adds a heavy week ahead when the study settings are known, unless its work is already listed", () => {
    // 20 hours due in the week of Mar 25, all of it on the calendar: only the heavy week is news.
    const big = makeTask({ id: "big", name: "Capstone", dueDate: "2030-03-27", estimatedMinutes: 1200 });
    const sessions = Array.from({ length: 20 }, (_, i) => makeBlock({
      taskId: "big", date: `2030-03-${String(14 + Math.floor(i / 2)).padStart(2, "0")}`, startTime: i % 2 ? "17:00" : "15:00", endTime: i % 2 ? "18:00" : "16:00",
    }));
    expect(planStatusFor(plan([big], sessions), NOW)).toBeNull();

    const status = planStatusFor({ ...plan([big], sessions), userPrefs: DEFAULT_USER_PREFS }, NOW)!;
    expect(status.items).toEqual([expect.objectContaining({ kind: "heavyWeek", title: "Heavy week ahead", fix: { kind: "viewTasks" } })]);
    expect(status.headline).toBe("Heavy week ahead");
    expect(status.summary).toBe("heavy week ahead");

    // The same week with nothing planned: "not planned yet" already says it, once.
    const unplanned = planStatusFor({ ...plan([big]), userPrefs: DEFAULT_USER_PREFS }, NOW)!;
    expect(unplanned.items.map((item) => item.kind)).toEqual(["unplanned"]);
  });

  it("finished and skipped work drops out", () => {
    const done = { ...late(), status: "done" as const };
    const skipped = { ...quiz(), status: "skipped" as const };
    expect(planStatusFor(plan([done, skipped]), NOW)).toBeNull();
  });
});
