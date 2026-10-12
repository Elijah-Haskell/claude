import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { weekDateKeys } from "../../src/engine/week-layout";

/**
 * What the Week tab dispatches for the VIEWED week: pull-to-refresh and "Build My Week" send AUTO_BUILD_WEEK, and
 * browsing to a week that has nothing in it sends BUILD_WEEK_FOR (once per week). These run the real reducer.
 */
const NOW = new Date(2030, 2, 4, 8, 0); // Monday 2030-03-04, local time
const club = { id: "club", title: "Club", days: ["Mon" as const], startTime: "18:00", endTime: "19:00", color: "#06B6D4", locked: false };
const empty = () => ({ ...createInitialState(), onboardingComplete: true, recurringEvents: [club] });
const inWeek = <T extends { date: string }>(blocks: T[], weekStart: string): T[] => blocks.filter((block) => weekDateKeys(weekStart).includes(block.date));

describe("weekly refresh / build policy", () => {
  it("AUTO_BUILD_WEEK plans the current week (pull-to-refresh / Build My Week)", () => {
    const after = reducer(empty(), { type: "AUTO_BUILD_WEEK", payload: { weekStart: new Date(2030, 2, 4), now: NOW } });
    expect(inWeek(after.scheduleBlocks, "2030-03-04").some((block) => block.type === "recurring")).toBe(true);
  });

  it("a far-future week the student browsed to is built too, never left empty", () => {
    const after = reducer(empty(), { type: "AUTO_BUILD_WEEK", payload: { weekStart: new Date(2030, 11, 2), now: NOW } });
    expect(inWeek(after.scheduleBlocks, "2030-12-02").some((block) => block.type === "recurring" && block.date === "2030-12-02")).toBe(true);
  });

  it("BUILD_WEEK_FOR fills an empty far-future week, and never touches a week that already has content", () => {
    const built = reducer(empty(), { type: "BUILD_WEEK_FOR", payload: { weekStart: new Date(2030, 11, 2), now: NOW } });
    expect(inWeek(built.scheduleBlocks, "2030-12-02").some((block) => block.type === "recurring")).toBe(true);

    const edited = { ...built, scheduleBlocks: built.scheduleBlocks.map((block) => (block.type === "recurring" ? { ...block, title: "Edited by hand" } : block)) };
    expect(reducer(edited, { type: "BUILD_WEEK_FOR", payload: { weekStart: new Date(2030, 11, 2), now: NOW } })).toBe(edited);
  });
});
