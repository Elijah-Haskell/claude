import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { AppState, ScheduleBlock } from "../../src/engine/types";

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: "b1", type: "study", title: "Study: Essay", date: "2030-01-10", startTime: "10:00", endTime: "11:00",
    locked: false, accepted: false, color: "#8B5CF6", completionStatus: "pending", ...overrides,
  };
}

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), onboardingComplete: true, ...overrides };
}

describe("Start Block (in-place focus timer)", () => {
  it("UPDATE_BLOCK records the start time and accepts the block so a re-plan will not replace it", () => {
    const started = reducer(stateWith({ scheduleBlocks: [block()] }), {
      type: "UPDATE_BLOCK",
      payload: { id: "b1", startedAt: "2030-01-10T15:00:00.000Z", accepted: true },
    });

    expect(started.scheduleBlocks[0]).toMatchObject({ startedAt: "2030-01-10T15:00:00.000Z", accepted: true, completionStatus: "pending" });
  });

  it("Stop clears the start time and leaves the block pending", () => {
    const running = stateWith({ scheduleBlocks: [block({ startedAt: "2030-01-10T15:00:00.000Z", accepted: true })] });

    const stopped = reducer(running, { type: "UPDATE_BLOCK", payload: { id: "b1", startedAt: undefined } });

    expect(stopped.scheduleBlocks[0].startedAt).toBeUndefined();
    expect(stopped.scheduleBlocks[0].completionStatus).toBe("pending");
  });

  it("Done completes the block", () => {
    const running = stateWith({ scheduleBlocks: [block({ startedAt: "2030-01-10T15:00:00.000Z", accepted: true })] });

    const done = reducer(running, { type: "COMPLETE_BLOCK", payload: "b1" });

    expect(done.scheduleBlocks[0].completionStatus).toBe("done");
  });
});

describe("notification settings", () => {
  it("turning reminders off makes blocks forget their OS notification ids, so re-enabling reschedules them", () => {
    const enabled = stateWith({
      notificationSettings: { enabled: true, leadTimeHours: 24 },
      scheduleBlocks: [block({ notificationId: "os-1" }), block({ id: "b2", notificationId: undefined })],
    });

    const off = reducer(enabled, { type: "UPDATE_NOTIFICATION_SETTINGS", payload: { enabled: false } });

    expect(off.notificationSettings.enabled).toBe(false);
    expect(off.scheduleBlocks.every((b) => b.notificationId === undefined)).toBe(true);
  });

  it("changing the lead time while enabled keeps existing notification ids", () => {
    const enabled = stateWith({
      notificationSettings: { enabled: true, leadTimeHours: 24 },
      scheduleBlocks: [block({ notificationId: "os-1" })],
    });

    const changed = reducer(enabled, { type: "UPDATE_NOTIFICATION_SETTINGS", payload: { leadTimeHours: 6 } });

    expect(changed.scheduleBlocks[0].notificationId).toBe("os-1");
  });
});

// The account itself (who is signed in) is not in the app state: it is the session (hooks/use-auth.ts). The state
// only remembers that the welcome screen is done, and is emptied when the student signs out or deletes the account.
describe("account-related app state", () => {
  it("COMPLETE_ONBOARDING only marks the welcome screen done (it needs no profile in the state)", () => {
    const fresh = createInitialState();
    expect(fresh.user).toBeUndefined();

    const after = reducer(fresh, { type: "COMPLETE_ONBOARDING" });

    expect(after.onboardingComplete).toBe(true);
    expect(after.user).toBeUndefined();
    // Nothing else changes: a new student starts with the same empty plan.
    expect({ ...after, onboardingComplete: false }).toEqual(fresh);
  });

  it("COMPLETE_ONBOARDING is idempotent (a plan restored from the account already has it)", () => {
    const done = stateWith({ classes: [{ id: "c1", name: "Chem", days: ["Mon"], startTime: "09:00", endTime: "09:50", color: "#4F6EF7" }] });
    const again = reducer(done, { type: "COMPLETE_ONBOARDING" });
    expect(again).toEqual(done);
  });

  it("LOGOUT (the wipe behind Sign out and Delete Account) resets everything to a fresh install", () => {
    const busy = stateWith({
      classes: [{ id: "c1", name: "Chem", days: ["Mon"], startTime: "09:00", endTime: "09:50", color: "#4F6EF7" }],
      scheduleBlocks: [block()],
    });

    const after = reducer(busy, { type: "LOGOUT" });

    expect(after).toEqual(createInitialState());
    expect(after.notificationSettings.enabled).toBe(false);
  });

  it("choosing a semester works without a server-side profile (it creates a local one)", () => {
    const after = reducer(stateWith(), { type: "UPDATE_USER", payload: { currentSemester: "Fall 2026" } });

    expect(after.user?.currentSemester).toBe("Fall 2026");
  });

  it("the removed LOGIN action no longer exists", () => {
    const before = stateWith();
    const after = reducer(before, { type: "LOGIN", payload: { id: "u" } } as never);

    expect(after).toBe(before);
    expect(after).not.toHaveProperty("isLoggedIn");
  });
});
