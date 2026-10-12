import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildVerifiedClassFromSyllabus } from "../../src/engine/course-matcher";
import {
  convertToScheduleBlocks,
  scheduleTasksIntelligently,
} from "../../src/engine/intelligent-scheduler";
import { generateWeekSchedule } from "../../src/engine/scheduler";
import {
  AppState,
  ClassBlock,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_USER_PREFS,
  ScheduleBlock,
  Task,
} from "../../src/engine/types";
import { addDays, getWeekStart, timeToMinutes, toDateString } from "../../src/engine/utils";

const TODAY = new Date("2030-03-13T12:00:00"); // Wednesday
const WEEK_START = getWeekStart(TODAY);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    onboardingComplete: true,
    classes: [],
    recurringEvents: [],
    tasks: [],
    scheduleBlocks: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    grades: [],
    recommendations: [],
    examPreps: [],
    studyGuides: [],
    practiceExams: [],
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    googleCalendarEvents: [],
    googleCalendarConnected: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "accounting-problem-set",
    name: "Accounting problem set",
    courseId: "acct-202",
    courseName: "ACCT 202",
    dueDate: toDateString(addDays(TODAY, 3)),
    estimatedMinutes: 90,
    difficulty: 3,
    requiresOnCampus: false,
    status: "pending",
    createdAt: TODAY.toISOString(),
    ...overrides,
  };
}

function makeClass(overrides: Partial<ClassBlock> = {}): ClassBlock {
  return {
    id: "acct-202",
    name: "ACCT 202",
    days: ["Mon", "Wed", "Fri"],
    startTime: "10:00",
    endTime: "11:15",
    color: "#4F6EF7",
    ...overrides,
  };
}

function overlaps(
  candidateStart: string,
  candidateEnd: string,
  fixedStart: string,
  fixedEnd: string,
) {
  return (
    timeToMinutes(candidateStart) < timeToMinutes(fixedEnd) &&
    timeToMinutes(candidateEnd) > timeToMinutes(fixedStart)
  );
}

describe("scheduling modernization baseline — syllabus class handoff", () => {
  it("requires an explicit asynchronous designation before a syllabus course can have no recurring class blocks", () => {
    const asynchronousCourse = {
      ...buildVerifiedClassFromSyllabus("ACCT 202", 0, {
        days: [], startTime: "", endTime: "", location: "Online", isAsynchronous: true,
      }),
      id: "acct-202",
    };
    const structuralBlocks = generateWeekSchedule(
      makeState({ classes: [asynchronousCourse] }),
      WEEK_START,
    );

    expect(asynchronousCourse.isAsynchronous).toBe(true);
    expect(structuralBlocks.filter((block) => block.type === "class")).toHaveLength(0);
  });

  it("creates visible recurring class blocks only after a meeting pattern is supplied", () => {
    const course = makeClass();
    const structuralBlocks = generateWeekSchedule(
      makeState({ classes: [course] }),
      WEEK_START,
    );
    const classBlocks = structuralBlocks.filter((block) => block.type === "class");

    expect(classBlocks).toHaveLength(3);
    expect(classBlocks.every((block) => block.courseId === course.id)).toBe(true);
    expect(classBlocks.map((block) => block.startTime)).toEqual(["10:00", "10:00", "10:00"]);
  });
});

describe("scheduling modernization baseline — real conflict safety", () => {
  it("does not place a course task over an actual occurrence of its class", () => {
    const course = makeClass({ days: ["Wed"], startTime: "10:00", endTime: "12:00" });
    const task = makeTask({ estimatedMinutes: 120 });
    const result = scheduleTasksIntelligently(
      [task],
      makeState({ classes: [course], tasks: [task] }),
      WEEK_START,
    );
    const wednesday = toDateString(addDays(WEEK_START, 2));

    for (const block of result.scheduledBlocks.filter((item) => item.date === wednesday)) {
      expect(overlaps(block.startTime, block.endTime, course.startTime, course.endTime)).toBe(false);
    }
  });

  it("does not place a study session over a locked commitment on the same real date", () => {
    const lockedBlock: ScheduleBlock = {
      id: "work-shift",
      type: "work",
      title: "Work shift",
      date: toDateString(addDays(WEEK_START, 3)),
      startTime: "13:00",
      endTime: "18:00",
      locked: true,
      accepted: true,
      color: "#EC4899",
      completionStatus: "pending",
    };
    const task = makeTask({ dueDate: toDateString(addDays(TODAY, 4)), estimatedMinutes: 120 });
    const result = scheduleTasksIntelligently(
      [task],
      makeState({ tasks: [task], scheduleBlocks: [lockedBlock] }),
      WEEK_START,
    );

    for (const block of result.scheduledBlocks.filter((item) => item.date === lockedBlock.date)) {
      expect(overlaps(block.startTime, block.endTime, lockedBlock.startTime, lockedBlock.endTime)).toBe(false);
    }
  });

  it("reports a fully unavailable workload instead of silently creating an invalid session", () => {
    const task = makeTask({ dueDate: toDateString(addDays(TODAY, 1)) });
    const result = scheduleTasksIntelligently(
      [task],
      makeState({
        tasks: [task],
        userPrefs: {
          ...DEFAULT_USER_PREFS,
          noGoZones: [{ startTime: "00:00", endTime: "23:59" }],
        },
      }),
      WEEK_START,
    );

    expect(result.scheduledBlocks.filter((block) => block.taskId === task.id)).toHaveLength(0);
    expect(result.unscheduledTasks.find((item) => item.taskId === task.id)?.reason).toBeTruthy();
  });

  it("keeps every generated session linked to an explainable task and a valid time range", () => {
    const task = makeTask({ estimatedMinutes: 180 });
    const result = scheduleTasksIntelligently([task], makeState({ tasks: [task] }), WEEK_START);
    const converted = convertToScheduleBlocks(result.scheduledBlocks);

    expect(converted.length).toBeGreaterThan(1);
    for (const block of converted) {
      expect(block.taskId).toBe(task.id);
      expect(block.schedulingReason).toBeTruthy();
      expect(timeToMinutes(block.endTime)).toBeGreaterThan(timeToMinutes(block.startTime));
    }
  });
});
