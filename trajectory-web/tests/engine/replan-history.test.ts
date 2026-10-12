// Regression tests for the 1.0.7 planner review: history survives every re-plan, a deferred day stays deferred,
// Undo never throws away later edits, and the automatic re-plan does not report moves nobody made.
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer, runReplan } from "../../src/engine/app-context";
import { detectDrift, planDeferral, previewPlanChange, replanSemester } from "../../src/engine/replan";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { findInvalidPinnedSessions } from "../../src/engine/week-planner";
import { deadlinePassed, taskDeadline } from "../../src/engine/task-kind";
import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState, ScheduleBlock, Semester } from "../../src/engine/types";
import { fincState, fiveCourseState } from "./fixtures/stress-semester";
import { localMoment, makeBlock, makeClass, makeTask, NOW, schedState, TODAY } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };
const stateWith = (o: Partial<AppState> = {}): AppState => ({ ...createInitialState(), onboardingComplete: true, semester: SEMESTER, ...o });
const session = (id: string, taskId: string, date: string, start: string, end: string, extra: Partial<ScheduleBlock> = {}): ScheduleBlock =>
  makeBlock({ id, type: "study", title: "Study", taskId, date, startTime: start, endTime: end, accepted: true, ...extra });

describe("skipped / missed sessions are history on every re-plan path", () => {
  const task = makeTask({ id: "essay", name: "Essay", dueDate: "2030-03-22", estimatedMinutes: 60, status: "scheduled" });

  it("'Move to tomorrow' keeps its Skipped row through the automatic re-plan, replanSemester, buildSemesterPlan and previewPlanChange", () => {
    const state = stateWith({ tasks: [task], scheduleBlocks: [session("s1", "essay", TODAY, "15:00", "16:00")] });
    const preview = runReplan(state, { scope: "today", mode: "defer", date: TODAY }, NOW);
    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });
    const skipped = (blocks: ScheduleBlock[]) => blocks.find((b) => b.id === "s1")?.completionStatus;
    expect(skipped(applied.scheduleBlocks)).toBe("skipped");

    expect(skipped(reducer(applied, { type: "AUTO_REPLAN", payload: { now: new Date(NOW.getTime() + 1500) } }).scheduleBlocks)).toBe("skipped"); // was: gone
    expect(skipped(replanSemester(applied, { now: NOW }).next.scheduleBlocks)).toBe("skipped");
    expect(skipped(buildSemesterPlan(applied, { now: NOW }).scheduleBlocks)).toBe("skipped");
    const edited = { ...applied, tasks: applied.tasks.map((t) => ({ ...t, estimatedMinutes: 90 })) };
    expect(skipped(previewPlanChange(applied, edited, { now: NOW, label: "Task change" }).next.scheduleBlocks)).toBe("skipped");
  });

  it("a session the re-plan marks missed stays on the calendar as Missed, and the 'behind' banner clears", () => {
    const state = stateWith({ tasks: [{ ...task, estimatedMinutes: 120 }], scheduleBlocks: [session("m1", "essay", "2030-03-12", "15:00", "16:00")] });
    expect(detectDrift(state, NOW).behindMinutes).toBe(60);
    const preview = replanSemester(state, { now: NOW });
    expect(preview.diff.markedMissed.map((b) => b.id)).toEqual(["m1"]);
    expect(preview.next.scheduleBlocks.find((b) => b.id === "m1")?.completionStatus).toBe("missed"); // was: dropped
    const applied = { ...state, ...preview.next };
    expect(detectDrift(applied, NOW).severity).toBe("none"); // re-planning is how the student clears it
  });
});

describe("a deferred day stays deferred", () => {
  it("the automatic re-plan after 'Move to tomorrow' puts no new study on that day and stacks no 'Plan updated' undo", () => {
    const now = new Date(2026, 9, 7, 9, 0);
    const date = "2026-10-07";
    for (const make of [fincState, fiveCourseState]) {
      const s = make();
      const plan = buildSemesterPlan(s, { now });
      const base: AppState = { ...createInitialState(), ...s, scheduleBlocks: plan.scheduleBlocks, tasks: plan.tasks };
      const result = planDeferral(base, date, { now, acceptLate: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const applied = reducer(base, { type: "APPLY_REPLAN", payload: { label: result.label, at: now.toISOString(), next: result.next } });
      const auto = reducer(applied, { type: "AUTO_REPLAN", payload: { now: new Date(now.getTime() + 2000) } });
      expect(auto.scheduleBlocks.filter((b) => b.date === date && b.type === "study" && b.completionStatus === "pending")).toEqual([]);
      expect(auto.undoSnapshots?.map((snap) => snap.source)).toEqual(["manual"]);
    }
  });

  it("work due tomorrow that no longer fits once today is off-limits is asked about, not left as a silent alert", () => {
    const quiz = makeTask({ id: "q", name: "Quiz 3", kind: "quiz", dueDate: "2030-03-14", estimatedMinutes: 200, status: "scheduled", courseId: "chem" });
    const state = stateWith({
      classes: [makeClass({ days: ["Mon", "Wed", "Thu", "Fri"] })], // Thursday class at 10:00: the quiz
      tasks: [quiz],
      scheduleBlocks: [session("a", "q", TODAY, "15:00", "16:00"), session("b", "q", TODAY, "17:00", "19:20")],
    });
    const asked = planDeferral(state, TODAY, { now: NOW });
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.atRisk).toEqual([expect.objectContaining({ taskId: "q", assessment: true, missingMinutes: 70 })]);
    const anyway = planDeferral(state, TODAY, { now: NOW, acceptLate: true });
    expect(anyway.ok).toBe(true);
    if (anyway.ok) expect(anyway.late.map((r) => r.taskId)).toEqual(["q"]);
  });
});

describe("Undo never restores over later edits", () => {
  it("completing a session (or any edit of tasks / schedule) after an applied change drops the stale undo", () => {
    const task = makeTask({ id: "essay", name: "Essay", dueDate: "2030-03-22", estimatedMinutes: 120, status: "scheduled" });
    const state = stateWith({ tasks: [task], scheduleBlocks: [session("s1", "essay", TODAY, "15:00", "16:00"), session("s2", "essay", "2030-03-15", "15:00", "16:00")] });
    const preview = runReplan(state, { scope: "today", mode: "protect_sleep" }, NOW);
    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: "Fix my day", at: NOW.toISOString(), next: { ...preview.next, scheduleBlocks: preview.next.scheduleBlocks.map((b) => (b.id === "s1" ? { ...b, startTime: "16:00", endTime: "17:00" } : b)) } } });
    expect(applied.undoSnapshots).toHaveLength(1);

    const completed = reducer(applied, { type: "COMPLETE_BLOCK", payload: "s2" });
    expect(completed.undoSnapshots).toBeUndefined();
    const undone = reducer(completed, { type: "UNDO_REPLAN" });
    expect(undone.scheduleBlocks.find((b) => b.id === "s2")?.completionStatus).toBe("done"); // was: back to pending
    expect(undone.tasks[0]!.completedMinutes).toBe(60);

    // Refreshing priority scores (dispatched right before every automatic re-plan) is not an edit.
    const scored = reducer(applied, { type: "BATCH_UPDATE_TASK_SCORES", payload: [{ ...task, priorityScore: 3 }] });
    expect(scored.undoSnapshots).toHaveLength(1);
  });
});

describe("the automatic re-plan does not report moves nobody made", () => {
  it("re-planned two minutes later, today's sessions keep their quarter-hour start", () => {
    const first = reducer({ ...createInitialState(), ...fiveCourseState() }, { type: "AUTO_REPLAN", payload: { now: new Date(2026, 9, 7, 14, 7) } });
    const today = first.scheduleBlocks.filter((b) => b.date === "2026-10-07" && b.type === "study");
    expect(today.length).toBeGreaterThan(0);
    expect(today.some((b) => b.startTime === "14:30")).toBe(true); // 14:07 + 15 min, on the quarter hour (was 14:22)
    const later = reducer({ ...first, undoSnapshots: undefined }, { type: "AUTO_REPLAN", payload: { now: new Date(2026, 9, 7, 14, 9) } });
    expect(later.undoSnapshots).toBeUndefined(); // was: "Plan updated — 1 session moved" (14:22 -> 14:24)
  });
});

describe("time-less quiz / exam on a day its course does not meet", () => {
  const exam = makeTask({ id: "fin", name: "Final exam", kind: "exam", dueDate: TODAY, estimatedMinutes: 120, courseId: "chem" });
  const classes = [makeClass({ days: ["Tue", "Thu"] })];

  it("has not 'already taken place' on the morning of the exam; it has the day after", () => {
    const deadline = taskDeadline(exam, classes);
    expect(deadline.source).toBe("start-of-day");
    expect(deadlinePassed(deadline, TODAY, 8 * 60)).toBe(false);
    expect(deadlinePassed(deadline, "2030-03-14", 8 * 60)).toBe(true);
    const morning = scheduleTasksIntelligently([exam], schedState({ classes }), undefined, [], { now: localMoment(2030, 3, 13, 8, 0) });
    expect(morning.overdueTasks).toEqual([]); // was: missedAssessment at 00:00 on exam day
    expect(morning.summary).not.toMatch(/already taken place/);
  });

  it("a class-time quiz still passes when its class starts", () => {
    const quiz = { ...exam, name: "Quiz 2", kind: "quiz" as const };
    const deadline = taskDeadline(quiz, [makeClass()]); // Wed 10:00
    expect(deadlinePassed(deadline, TODAY, 9 * 60)).toBe(false);
    expect(deadlinePassed(deadline, TODAY, 10 * 60)).toBe(true);
  });
});

describe("sleep window after midnight", () => {
  it("a confirmed 00:15 session is not 'in your sleep window' when bedtime is 01:00", () => {
    const task = makeTask({ id: "t", dueDate: "2030-03-20" });
    const late = session("late", "t", "2030-03-15", "00:15", "00:45", { userEdited: true });
    const base = stateWith({ tasks: [task], scheduleBlocks: [late], healthPrefs: { ...createInitialState().healthPrefs, bedtime: "01:00", wakeTime: "08:00" } });
    expect(findInvalidPinnedSessions(base, NOW)).toEqual([]);
    const asleep = { ...base, scheduleBlocks: [{ ...late, startTime: "02:00", endTime: "02:30" }] };
    expect(findInvalidPinnedSessions(asleep, NOW).map((r) => r.detail)).toEqual(["Falls in your sleep window"]);
  });
});
