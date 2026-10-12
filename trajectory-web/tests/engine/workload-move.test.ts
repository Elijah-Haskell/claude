// Today's "Move N to tomorrow" end to end: the workload card picks only the excess over the daily cap, the defer
// preview moves exactly those sessions (planDeferral `blockIds`), and after Apply the card and the day's overload are
// gone (was: "Move 5 to tomorrow" moved every session, and the card still said "7.3 h … over your 5 h daily cap").
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer, runReplan } from "../../src/engine/app-context";
import { planDeferral } from "../../src/engine/replan";
import { planQualityFor } from "../../src/engine/plan-alerts";
import { realityCheckFor } from "../../src/engine/workload-analysis";
import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState, ScheduleBlock, Semester } from "../../src/engine/types";
import { makeBlock, makeTask, NOW, TODAY } from "./scheduler-fixtures";

const SEMESTER: Semester = { id: "s", name: "Spring 2030", startDate: "2030-01-14", endDate: "2030-05-03", breaks: [] };
const NOW_MINUTES = NOW.getHours() * 60 + NOW.getMinutes(); // 12:00
const session = (id: string, taskId: string, start: string, end: string): ScheduleBlock =>
  makeBlock({ id, type: "study", title: "Study", taskId, date: TODAY, startTime: start, endTime: end, accepted: false });

/** Wed 2030-03-13 from noon: 7 h of study left against a 5 h cap. */
function overloadedDay(): AppState {
  return {
    ...createInitialState(),
    onboardingComplete: true,
    semester: SEMESTER,
    tasks: [
      makeTask({ id: "hw", name: "Homework", dueDate: TODAY, estimatedMinutes: 60 }),
      makeTask({ id: "essay", name: "Essay", dueDate: "2030-03-25", estimatedMinutes: 120 }),
      makeTask({ id: "report", name: "Report", dueDate: "2030-03-18", estimatedMinutes: 120 }),
      makeTask({ id: "lab", name: "Lab", dueDate: "2030-03-22", estimatedMinutes: 120 }),
    ],
    scheduleBlocks: [
      session("s-hw", "hw", "12:30", "13:30"),
      session("s-essay", "essay", "13:30", "15:30"),
      session("s-report", "report", "16:00", "18:00"),
      session("s-lab", "lab", "18:00", "20:00"),
    ],
  };
}
const check = (state: AppState) => realityCheckFor(state.scheduleBlocks, state.healthPrefs, TODAY, { userPrefs: state.userPrefs, nowMinutes: NOW_MINUTES, tasks: state.tasks });

describe("'Move N to tomorrow' moves only the excess, and the warning clears after Apply", () => {
  it("suggests the one session whose deadline allows it most, not all four", () => {
    const card = check(overloadedDay())!;
    expect(card).not.toBeNull();
    expect(card.moveBlockIds).toEqual(["s-essay"]);
    expect(card.moveFixesDay).toBe(true);
  });

  it("the preview moves exactly that session; the day's others stay where they are", () => {
    const state = overloadedDay();
    const preview = runReplan(state, { scope: "today", mode: "defer", blockIds: check(state)!.moveBlockIds }, NOW);
    expect(preview.needsConfirmation).toBeUndefined();
    expect(preview.diff.moved.map((move) => move.taskId)).toEqual(["essay"]);
    expect(preview.diff.moved[0]!.to.date > TODAY).toBe(true);
    const after = new Map(preview.next.scheduleBlocks.map((block) => [block.id, block]));
    expect(after.get("s-essay")?.completionStatus).toBe("skipped");
    for (const id of ["s-hw", "s-report", "s-lab"]) {
      const before = state.scheduleBlocks.find((block) => block.id === id)!;
      expect(after.get(id)).toMatchObject({ date: TODAY, startTime: before.startTime, endTime: before.endTime, completionStatus: "pending" });
    }
  });

  it("after Apply (and the automatic re-plan that follows) Today is no longer flagged and no day from today on is overloaded", () => {
    const state = overloadedDay();
    const preview = runReplan(state, { scope: "today", mode: "defer", blockIds: check(state)!.moveBlockIds }, NOW);
    const applied = reducer(state, { type: "APPLY_REPLAN", payload: { label: preview.label, at: NOW.toISOString(), next: preview.next } });
    expect(check(applied)).toBeNull();
    expect(planQualityFor(applied, TODAY).overloadedDates).not.toContain(TODAY);
    const auto = reducer(applied, { type: "AUTO_REPLAN", payload: { now: new Date(NOW.getTime() + 2000) } });
    expect(check(auto)).toBeNull();
    expect(auto.scheduleBlocks.filter((block) => block.date === TODAY && block.type === "study" && block.completionStatus === "pending").map((block) => block.id).sort())
      .toEqual(["s-hw", "s-lab", "s-report"]);
  });

  it("without blockIds planDeferral still moves every open session of the day (the block sheet's 'Done for today')", () => {
    const state = overloadedDay();
    const all = planDeferral({ ...state, tasks: state.tasks.filter((task) => task.id !== "hw"), scheduleBlocks: state.scheduleBlocks.filter((block) => block.id !== "s-hw") }, TODAY, { now: NOW });
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.deferredTaskIds.sort()).toEqual(["essay", "lab", "report"]);
    const none = planDeferral(state, TODAY, { now: NOW, blockIds: [] });
    expect(none.ok).toBe(false);
  });
});
