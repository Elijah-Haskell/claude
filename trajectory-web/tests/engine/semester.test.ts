import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { buildBusyMap } from "../../src/engine/busy-windows";
import { scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { generateWeekSchedule } from "../../src/engine/scheduler";
import {
  getPlanningHorizon,
  isClassDay,
  isDateKey,
  MAX_INFERRED_PLAN_WEEKS,
  MAX_SEMESTER_PLAN_WEEKS,
  validateSemester,
  weekStartsInRange,
} from "../../src/engine/semester";
import { createInitialState, parsePersistedState, restorePersistedState, toLocalPersistedState } from "../../src/engine/state-persistence";
import { AppState, DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, Semester } from "../../src/engine/types";
import { addDaysToKey, parseLocalDate } from "../../src/engine/utils";
import { makeClass, makeTask, NOW, TODAY } from "./scheduler-fixtures";

// TODAY = Wed 2030-03-13 (the Monday of that week is 2030-03-11).
const FALL: Semester = {
  id: "sem-1",
  name: "Spring 2030",
  startDate: "2030-01-14",
  endDate: "2030-05-03",
  breaks: [{ name: "Spring break", startDate: "2030-03-18", endDate: "2030-03-22" }],
};

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialState(), onboardingComplete: true, ...overrides };
}

describe("validateSemester", () => {
  it("accepts a well-formed semester and normalises it (trimmed name, breaks sorted by start)", () => {
    const result = validateSemester({
      ...FALL,
      name: "  Spring 2030 ",
      breaks: [
        { name: "Reading week", startDate: "2030-04-22", endDate: "2030-04-26" },
        { name: "", startDate: "2030-03-18", endDate: "2030-03-22" },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.semester.name).toBe("Spring 2030");
      expect(result.semester.breaks.map((b) => b.startDate)).toEqual(["2030-03-18", "2030-04-22"]);
      expect(result.semester.breaks[0]!.name).toBe("Break");
    }
  });

  it("rejects a semester that ends before it starts", () => {
    const result = validateSemester({ ...FALL, startDate: "2030-05-04", endDate: "2030-05-03" });
    expect(result.ok).toBe(false);
  });

  it("rejects impossible calendar dates and blank names", () => {
    expect(validateSemester({ ...FALL, endDate: "2030-02-30" }).ok).toBe(false);
    expect(validateSemester({ ...FALL, name: "   " }).ok).toBe(false);
    expect(isDateKey("2030-02-29")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
  });

  it("rejects breaks outside the semester or with start after end", () => {
    const outside = validateSemester({ ...FALL, breaks: [{ name: "Late", startDate: "2030-05-01", endDate: "2030-05-10" }] });
    const early = validateSemester({ ...FALL, breaks: [{ name: "Early", startDate: "2030-01-10", endDate: "2030-01-16" }] });
    const backwards = validateSemester({ ...FALL, breaks: [{ name: "Odd", startDate: "2030-03-20", endDate: "2030-03-18" }] });

    expect(outside.ok).toBe(false);
    expect(early.ok).toBe(false);
    expect(backwards.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toContain("Late");
  });
});

describe("class days", () => {
  it("only days from start to end that are not in a break", () => {
    expect(isClassDay(FALL, "2030-01-13")).toBe(false);
    expect(isClassDay(FALL, "2030-01-14")).toBe(true);
    expect(isClassDay(FALL, "2030-03-15")).toBe(true);
    expect(isClassDay(FALL, "2030-03-18")).toBe(false);
    expect(isClassDay(FALL, "2030-03-22")).toBe(false);
    expect(isClassDay(FALL, "2030-03-25")).toBe(true);
    expect(isClassDay(FALL, "2030-05-03")).toBe(true);
    expect(isClassDay(FALL, "2030-05-06")).toBe(false);
  });

  it("without a semester (older saves) every day is a class day", () => {
    expect(isClassDay(undefined, "1999-01-01")).toBe(true);
  });

  it("generateWeekSchedule creates no class meetings before the start, after the end or during a break", () => {
    // Starts on a Wednesday and ends on a Wednesday, so both edges cut a Mon/Wed/Fri week.
    const semester: Semester = { ...FALL, startDate: "2030-01-16", endDate: "2030-05-01" };
    const state = { classes: [makeClass({ days: ["Mon", "Wed", "Fri"] })], recurringEvents: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS, semester };
    const classDates = (weekStart: string) =>
      generateWeekSchedule(state, parseLocalDate(weekStart), NOW).filter((b) => b.type === "class" || b.title === "Transition").map((b) => b.date).sort();

    expect(classDates("2030-01-07")).toEqual([]); // the week before the term
    expect(classDates("2030-01-14")).toEqual(["2030-01-16", "2030-01-16", "2030-01-18", "2030-01-18"]); // Mon 14th is before the start
    expect(classDates("2030-03-18")).toEqual([]); // whole break week
    expect(classDates("2030-03-25")).toHaveLength(6); // back to normal
    expect(classDates("2030-04-29")).toEqual(["2030-04-29", "2030-04-29", "2030-05-01", "2030-05-01"]); // Fri 3rd is after the end
    expect(classDates("2030-05-06")).toEqual([]); // after the end
  });

  it("sleep and recurring commitments are still generated during a break", () => {
    const state = {
      classes: [makeClass()],
      recurringEvents: [{ id: "job", title: "Job", days: ["Tue" as const], startTime: "14:00", endTime: "18:00", color: "#06B6D4", locked: true }],
      healthPrefs: DEFAULT_HEALTH_PREFS,
      userPrefs: DEFAULT_USER_PREFS,
      semester: FALL,
    };
    const blocks = generateWeekSchedule(state, parseLocalDate("2030-03-18"), NOW);

    expect(blocks.filter((b) => b.type === "sleep")).toHaveLength(7);
    expect(blocks.filter((b) => b.type === "recurring")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "class")).toHaveLength(0);
  });

  it("class time is free for studying on a break day, but busy on a normal class day", () => {
    const cls = makeClass({ days: ["Mon"], startTime: "10:00", endTime: "11:00" });
    const dates = ["2030-03-18", "2030-03-25"];
    const map = buildBusyMap(dates, {
      classes: [cls], recurringEvents: [], scheduleBlocks: [], noGoZones: [],
      isClassDay: (date) => isClassDay(FALL, date),
    });

    expect(map["2030-03-18"]).toEqual([]);
    expect(map["2030-03-25"]).toEqual([{ startMinutes: 600, endMinutes: 660 }]);
  });

  it("the solver uses class time on break days: a full day of classes leaves room only during the break", () => {
    // Class 08:00-21:00 on Mondays blocks the whole planning window on class Mondays. A task due Monday 2030-03-18 (break)
    // can be studied that day; the same task due Monday 2030-03-25 (class day) has no room that day.
    const allDay = makeClass({ days: ["Mon"], startTime: "07:00", endTime: "22:00" });
    const base = { classes: [allDay], recurringEvents: [], scheduleBlocks: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS };
    const onBreak = scheduleTasksIntelligently(
      [makeTask({ id: "t", dueDate: "2030-03-18", estimatedMinutes: 60, notBeforeDate: "2030-03-18" })],
      { ...base, semester: FALL }, parseLocalDate("2030-03-11"), undefined, { now: NOW },
    );
    const normal = scheduleTasksIntelligently(
      [makeTask({ id: "t", dueDate: "2030-03-25", estimatedMinutes: 60, notBeforeDate: "2030-03-25" })],
      { ...base, semester: FALL }, parseLocalDate("2030-03-11"), undefined, { now: NOW },
    );

    expect(onBreak.scheduledBlocks.filter((b) => b.date === "2030-03-18").length).toBeGreaterThan(0);
    expect(normal.scheduledBlocks.filter((b) => b.date === "2030-03-25")).toHaveLength(0);
  });
});

describe("getPlanningHorizon", () => {
  const task = (dueDate: string, overrides = {}) => makeTask({ dueDate, ...overrides });

  it("with a semester: from today through the semester's end date", () => {
    const horizon = getPlanningHorizon({ semester: FALL, tasks: [] }, NOW);
    expect(horizon).toEqual({ startKey: TODAY, endKey: "2030-05-03" });
  });

  it("extends past the semester end when an open task is due later, and ignores finished tasks", () => {
    const later = getPlanningHorizon({ semester: FALL, tasks: [task("2030-05-10"), task("2030-06-30", { status: "done" })] }, NOW);
    expect(later.endKey).toBe("2030-05-10");
  });

  it("without a semester: latest open due date + 7 days", () => {
    const horizon = getPlanningHorizon({ tasks: [task("2030-04-01"), task("2030-03-20")] }, NOW);
    expect(horizon).toEqual({ startKey: TODAY, endKey: "2030-04-08" });
  });

  it("never before today and always at least two weeks out", () => {
    expect(getPlanningHorizon({ tasks: [] }, NOW).endKey).toBe(addDaysToKey(TODAY, 13));
    expect(getPlanningHorizon({ tasks: [task("2030-03-01")] }, NOW).endKey).toBe(addDaysToKey(TODAY, 13)); // overdue work does not push it back
    const finished = getPlanningHorizon({ semester: { endDate: "2030-03-01" }, tasks: [] }, NOW);
    expect(finished.startKey).toBe(TODAY);
    expect(finished.endKey >= TODAY).toBe(true);
  });

  it("is capped: 20 weeks without a semester, 26 weeks with one", () => {
    const far = getPlanningHorizon({ tasks: [task("2032-01-01")] }, NOW);
    expect(far.endKey).toBe(addDaysToKey(TODAY, MAX_INFERRED_PLAN_WEEKS * 7 - 1));
    const longTerm = getPlanningHorizon({ semester: { ...FALL, endDate: "2031-01-01" }, tasks: [] }, NOW);
    expect(longTerm.endKey).toBe(addDaysToKey(TODAY, MAX_SEMESTER_PLAN_WEEKS * 7 - 1));
  });

  it("weekStartsInRange lists every Monday from the start's week to the end's week", () => {
    expect(weekStartsInRange("2030-03-13", "2030-03-26")).toEqual(["2030-03-11", "2030-03-18", "2030-03-25"]);
    expect(weekStartsInRange("2030-03-13", "2030-03-13")).toEqual(["2030-03-11"]);
  });
});

describe("SET_SEMESTER", () => {
  it("stores a valid semester and keeps the profile's semester label in step", () => {
    const after = reducer(stateWith(), { type: "SET_SEMESTER", payload: FALL });

    expect(after.semester).toEqual(FALL);
    expect(after.user?.currentSemester).toBe("Spring 2030");
  });

  it("ignores an invalid semester (start after end, break outside the range) and keeps the old one", () => {
    const before = reducer(stateWith(), { type: "SET_SEMESTER", payload: FALL });
    const backwards = reducer(before, { type: "SET_SEMESTER", payload: { ...FALL, startDate: "2030-06-01" } });
    const badBreak = reducer(before, { type: "SET_SEMESTER", payload: { ...FALL, breaks: [{ name: "x", startDate: "2029-12-01", endDate: "2029-12-05" }] } });

    expect(backwards).toBe(before);
    expect(badBreak).toBe(before);
  });

  it("null clears the semester", () => {
    const set = reducer(stateWith(), { type: "SET_SEMESTER", payload: FALL });
    expect(reducer(set, { type: "SET_SEMESTER", payload: null }).semester).toBeUndefined();
  });

  it("RESET_SEMESTER also forgets the semester dates", () => {
    const set = reducer(stateWith(), { type: "SET_SEMESTER", payload: FALL });
    expect(reducer(set, { type: "RESET_SEMESTER" }).semester).toBeUndefined();
  });

  it("RESET_SEMESTER removes the uploaded syllabi and the study material made from them, but keeps preferences", () => {
    // Bug seen on the phone (2026-09-24): reset cleared classes and tasks but the syllabus history stayed.
    const base = reducer(stateWith(), { type: "SET_SEMESTER", payload: FALL });
    const withImports = {
      ...base,
      syllabusImports: [{ id: "si-1" } as unknown as NonNullable<typeof base.syllabusImports>[number]],
      studyGuides: [{ id: "sg-1" } as unknown as typeof base.studyGuides[number]],
      practiceExams: [{ id: "pe-1" } as unknown as typeof base.practiceExams[number]],
      healthPrefs: { ...base.healthPrefs, bedtime: "00:30" },
    };
    const after = reducer(withImports, { type: "RESET_SEMESTER" });
    expect(after.syllabusImports).toEqual([]);
    expect(after.studyGuides).toEqual([]);
    expect(after.practiceExams).toEqual([]);
    expect(after.healthPrefs.bedtime).toBe("00:30");
    expect(after.userPrefs).toBe(withImports.userPrefs);
  });

  it("changing the semester and re-planning removes class meetings that fall in the new break", () => {
    const cls = makeClass({ days: ["Mon"], startTime: "10:00", endTime: "11:00" });
    const noBreak = { ...FALL, breaks: [] };
    let state = stateWith({ classes: [cls], semester: noBreak });
    state = reducer(state, { type: "REGENERATE_WEEK", payload: { now: NOW } });
    expect(state.scheduleBlocks.some((b) => b.type === "class" && b.date === "2030-03-18")).toBe(true);

    state = reducer(state, { type: "SET_SEMESTER", payload: FALL });
    state = reducer(state, { type: "REGENERATE_WEEK", payload: { now: NOW } });

    expect(state.scheduleBlocks.some((b) => b.type === "class" && b.date === "2030-03-18")).toBe(false);
    expect(state.scheduleBlocks.some((b) => b.type === "class" && b.date === "2030-03-25")).toBe(true);
  });
});

describe("semester persistence", () => {
  it("an old save without a semester loads fine (semester undefined)", () => {
    const state = parsePersistedState(JSON.stringify({ onboardingComplete: true, classes: [], tasks: [], user: { id: "u", email: "", name: "", currentSemester: "Fall 2026", createdAt: "x" } }))!;

    expect(state.semester).toBeUndefined();
    expect(state.user?.currentSemester).toBe("Fall 2026");
  });

  it("a saved semester round-trips", () => {
    const original = stateWith({ semester: FALL });
    const reloaded = parsePersistedState(JSON.stringify(toLocalPersistedState(original)))!;

    expect(reloaded.semester).toEqual(FALL);
  });

  it("a malformed or inconsistent saved semester is dropped instead of breaking the load", () => {
    expect(restorePersistedState({ semester: "Fall" }).semester).toBeUndefined();
    expect(restorePersistedState({ semester: { ...FALL, startDate: "2030-09-01" } }).semester).toBeUndefined();
    expect(restorePersistedState({ semester: { ...FALL, breaks: "none" } }).semester).toEqual({ ...FALL, breaks: [] });
  });
});
