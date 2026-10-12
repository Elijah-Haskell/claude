import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { lockTogglePatch, moveDayPatch, timeEditPatch } from "../../src/engine/week-layout";
import { AppState, ScheduleBlock, Task } from "../../src/engine/types";

/**
 * The Week tab's sheet edits a block through UPDATE_BLOCK / PUSH_BLOCK / DELETE_BLOCK by id. These tests run
 * the real reducer and the real planner: an edit must keep the block's id and survive the next re-plan.
 */

const NOW = new Date(2030, 2, 4, 8, 0); // Monday 2030-03-04, local time
const WEEK_START = new Date(2030, 2, 4);

const essay: Task = {
  id: "t1", name: "Essay", courseId: "c1", courseName: "English 101", dueDate: "2030-03-08", estimatedMinutes: 180,
  difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2030-03-01T12:00:00.000Z",
};

// "Regenerate" is what the app does after any change: the reducer's AUTO_BUILD_WEEK (the semester planner).
const replan = (state: AppState) => reducer(state, { type: "AUTO_BUILD_WEEK", payload: { weekStart: WEEK_START, now: NOW } });

function plannedState(): { state: AppState; target: ScheduleBlock } {
  const base: AppState = { ...createInitialState(), onboardingComplete: true, tasks: [essay] };
  const state = replan(base);
  const target = state.scheduleBlocks.find((block) => block.type === "study" && block.taskId === "t1");
  if (!target) throw new Error("fixture: the planner placed no study block");
  return { state, target };
}
const byId = (state: AppState, id: string) => state.scheduleBlocks.filter((block) => block.id === id);
const overlapsAnother = (state: AppState, block: ScheduleBlock) =>
  state.scheduleBlocks.some((other) => other.id !== block.id && other.type === "study" && other.date === block.date && other.startTime < block.endTime && block.startTime < other.endTime);

describe("a re-plan keeps identities stable (the id the sheet was opened with stays valid)", () => {
  it("regenerating an untouched plan yields the same block ids", () => {
    const { state } = plannedState();
    const again = replan(state);
    const ids = (s: AppState) => s.scheduleBlocks.map((block) => block.id).sort();
    expect(ids(again)).toEqual(ids(state));
  });
});

describe("sheet edits survive a re-plan", () => {
  it("why the sheet marks edits: a moved block that is neither accepted nor edited is regenerated (its move is lost)", () => {
    const { state, target } = plannedState();
    // Bypass the reducer (which now flags moves itself) to show what the planner does with an unflagged edit.
    const naive = { ...state, scheduleBlocks: state.scheduleBlocks.map((block) => (block.id === target.id ? { ...block, startTime: "21:15", endTime: "22:15" } : block)) };
    const after = replan(naive);
    expect(after.scheduleBlocks.some((block) => block.id === target.id && block.startTime === "21:15")).toBe(false);
  });

  it("Edit Time keeps the id, marks the block edited + accepted, and the new time survives", () => {
    const { state, target } = plannedState();
    const edited = reducer(state, { type: "UPDATE_BLOCK", payload: timeEditPatch(target, "21:15", "22:15") });
    expect(byId(edited, target.id)[0]).toMatchObject({ startTime: "21:15", endTime: "22:15", userEdited: true, accepted: true });

    const after = replan(edited);
    const kept = byId(after, target.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ date: target.date, startTime: "21:15", endTime: "22:15", userEdited: true });
    expect(overlapsAnother(after, kept[0]!)).toBe(false);
  });

  it("Move Day keeps the id on the new day and survives", () => {
    const { state, target } = plannedState();
    // (1.0.8: the new day must be on or before the essay's deadline, Fri 03-08. This test used Sat 03-09 / Sun 03-10,
    // which are after it - such a session is now released, see the next test.)
    const newDate = target.date === "2030-03-05" ? "2030-03-06" : "2030-03-05";
    const moved = reducer(state, { type: "UPDATE_BLOCK", payload: moveDayPatch(target, newDate) });
    const after = replan(moved);
    expect(byId(after, target.id)).toHaveLength(1);
    expect(byId(after, target.id)[0]).toMatchObject({ date: newDate, userEdited: true, accepted: true });
  });

  it("a session moved past its task's deadline is released on the next re-plan and its minutes are planned before the deadline", () => {
    const { state, target } = plannedState();
    const moved = reducer(state, { type: "UPDATE_BLOCK", payload: moveDayPatch(target, "2030-03-09") });
    const after = replan(moved);
    const essayStudy = after.scheduleBlocks.filter((block) => block.type === "study" && block.taskId === "t1" && block.completionStatus === "pending");
    expect(essayStudy.every((block) => block.date <= "2030-03-08")).toBe(true);
    expect(essayStudy.reduce((sum, block) => sum + Number(block.endTime.slice(0, 2)) * 60 + Number(block.endTime.slice(3)) - Number(block.startTime.slice(0, 2)) * 60 - Number(block.startTime.slice(3)), 0)).toBe(180);
  });

  it("Lock keeps the block exactly where it is", () => {
    const { state, target } = plannedState();
    const locked = reducer(state, { type: "UPDATE_BLOCK", payload: lockTogglePatch(target) });
    const after = replan(locked);
    expect(byId(after, target.id)[0]).toMatchObject({ date: target.date, startTime: target.startTime, endTime: target.endTime, locked: true, userEdited: true });
    // Unlock flips it back and it is still the same block
    const unlocked = reducer(after, { type: "UPDATE_BLOCK", payload: lockTogglePatch(byId(after, target.id)[0]!) });
    expect(byId(unlocked, target.id)[0]!.locked).toBe(false);
  });

  it("Push 30m (by id, through the reducer) keeps the id, marks it edited and survives", () => {
    const { state, target } = plannedState();
    const pushed = reducer(state, { type: "PUSH_BLOCK", payload: { blockId: target.id, minutes: 30 } });
    const pushedBlock = byId(pushed, target.id)[0]!;
    expect(pushedBlock.startTime > target.startTime).toBe(true);
    expect(pushedBlock).toMatchObject({ userEdited: true, accepted: true });

    const after = replan(pushed);
    expect(byId(after, target.id)[0]).toMatchObject({ startTime: pushedBlock.startTime, endTime: pushedBlock.endTime });
  });

  it("Accept keeps the block through a re-plan", () => {
    const { state, target } = plannedState();
    const accepted = reducer(state, { type: "ACCEPT_BLOCK", payload: target.id });
    const after = replan(accepted);
    expect(byId(after, target.id)[0]).toMatchObject({ startTime: target.startTime, date: target.date, accepted: true });
  });

  it("an event added by hand (ADD_BLOCK, as the Add sheet does) is kept and study is planned around it", () => {
    const { state, target } = plannedState();
    const manual: ScheduleBlock = {
      id: "manual-1", type: "work", title: "Shift", date: target.date, startTime: target.startTime, endTime: target.endTime,
      locked: false, accepted: true, userEdited: true, color: "#EC4899", completionStatus: "pending",
    };
    const withManual = reducer(state, { type: "ADD_BLOCK", payload: manual });
    const after = replan(withManual);
    expect(byId(after, "manual-1")).toHaveLength(1);
    expect(after.scheduleBlocks.filter((block) => block.type === "study" && block.date === manual.date && block.startTime < manual.endTime && manual.startTime < block.endTime)).toEqual([]);
  });
});

describe("sheet actions work by id on the current state", () => {
  it("Delete removes exactly that block; a later action on the stale id changes nothing", () => {
    const { state, target } = plannedState();
    const deleted = reducer(state, { type: "DELETE_BLOCK", payload: target.id });
    expect(byId(deleted, target.id)).toHaveLength(0);
    expect(deleted.scheduleBlocks).toHaveLength(state.scheduleBlocks.length - 1);

    const stale = reducer(deleted, { type: "UPDATE_BLOCK", payload: timeEditPatch(target, "21:15", "22:15") });
    expect(stale.scheduleBlocks).toEqual(deleted.scheduleBlocks);
    expect(reducer(deleted, { type: "PUSH_BLOCK", payload: { blockId: target.id, minutes: 30 } })).toBe(deleted);
  });

  it("Skip and Done change only the targeted block", () => {
    const { state, target } = plannedState();
    const skipped = reducer(state, { type: "SKIP_BLOCK", payload: target.id });
    expect(byId(skipped, target.id)[0]!.completionStatus).toBe("skipped");
    expect(skipped.scheduleBlocks.filter((block) => block.completionStatus !== "pending")).toHaveLength(1);
  });
});
