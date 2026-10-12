import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildWeekPlan, findPushedBlock } from "../../src/engine/week-planner";
import {
  AppState,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_USER_PREFS,
  ScheduleBlock,
  Task,
} from "../../src/engine/types";
import { addDays, getWeekStart, timeToMinutes, toDateString } from "../../src/engine/utils";

const NOW = new Date("2030-03-13T08:00:00");
const WEEK_START = getWeekStart(NOW);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    onboardingComplete: true,
    classes: [{ id: "physics", name: "Physics 201", days: ["Wed"], startTime: "10:00", endTime: "11:15", color: "#4F6EF7" }],
    recurringEvents: [],
    tasks: [],
    scheduleBlocks: [],
    healthPrefs: { ...DEFAULT_HEALTH_PREFS, wakeTime: "07:00", bedtime: "23:00" },
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "physics-problem-set",
    name: "Physics problem set",
    courseId: "physics",
    courseName: "Physics 201",
    dueDate: toDateString(addDays(NOW, 3)),
    estimatedMinutes: 90,
    difficulty: 4,
    requiresOnCampus: false,
    status: "pending",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function overlaps(first: ScheduleBlock, second: ScheduleBlock): boolean {
  return first.date === second.date && timeToMinutes(first.startTime) < timeToMinutes(second.endTime) && timeToMinutes(second.startTime) < timeToMinutes(first.endTime);
}

describe("unified weekly planner", () => {
  it("creates one coherent calendar with class constraints and study work that does not overlap them", () => {
    const pendingTask = task();
    const result = buildWeekPlan(state({ tasks: [pendingTask] }), WEEK_START, { preserveAccepted: false });
    const classBlocks = result.scheduleBlocks.filter((block) => block.type === "class");
    const studyBlocks = result.scheduleBlocks.filter((block) => block.type === "study");

    expect(classBlocks).toHaveLength(1);
    expect(studyBlocks.length).toBeGreaterThan(0);
    for (const studyBlock of studyBlocks) {
      for (const classBlock of classBlocks) {
        expect(overlaps(studyBlock, classBlock)).toBe(false);
      }
    }
    expect(result.tasks.find((item) => item.id === pendingTask.id)?.status).toBe("scheduled");
  });

  it("preserves accepted user study sessions when regenerating a week", () => {
    const pendingTask = task();
    const acceptedStudy: ScheduleBlock = {
      id: "accepted-study",
      type: "study",
      title: "Study: Physics problem set",
      date: toDateString(addDays(WEEK_START, 2)),
      startTime: "13:00",
      endTime: "14:00",
      locked: false,
      accepted: true,
      taskId: pendingTask.id,
      courseId: pendingTask.courseId,
      color: "#4F6EF7",
      completionStatus: "pending",
    };
    const result = buildWeekPlan(state({ tasks: [pendingTask], scheduleBlocks: [acceptedStudy] }), WEEK_START);

    expect(result.scheduleBlocks.find((block) => block.id === acceptedStudy.id)).toEqual(acceptedStudy);
  });

  it("pushes a study block past later commitments instead of creating an overlap", () => {
    const study: ScheduleBlock = {
      id: "study", type: "study", title: "Study: Physics", date: "2030-03-13", startTime: "14:00", endTime: "15:00",
      locked: false, accepted: false, taskId: "physics-problem-set", courseId: "physics", color: "#4F6EF7", completionStatus: "pending",
    };
    const commitment: ScheduleBlock = {
      id: "commitment", type: "work", title: "Work shift", date: "2030-03-13", startTime: "14:30", endTime: "17:00",
      locked: true, accepted: true, color: "#EC4899", completionStatus: "pending",
    };
    const moved = findPushedBlock(study, [study, commitment], 30);

    expect(moved?.startTime).toBe("17:10");
    expect(moved?.endTime).toBe("18:10");
    expect(moved && overlaps(moved, commitment)).toBe(false);
  });

  it("honors a user-requested defer date when replanning unfinished work", () => {
    const deferredTask = task({ notBeforeDate: "2030-03-16", dueDate: "2030-03-19" });
    const result = buildWeekPlan(state({ tasks: [deferredTask] }), WEEK_START, { preserveAccepted: false });
    const studyDates = result.scheduleBlocks
      .filter((block) => block.type === "study" && block.taskId === deferredTask.id)
      .map((block) => block.date);

    expect(studyDates.length).toBeGreaterThan(0);
    expect(studyDates.every((date) => date >= "2030-03-16")).toBe(true);
  });

  it("refuses a push that would enter the protected sleep window", () => {
    const lateStudy: ScheduleBlock = {
      id: "late-study", type: "study", title: "Study", date: "2030-03-13", startTime: "21:00", endTime: "22:00",
      locked: false, accepted: false, color: "#4F6EF7", completionStatus: "pending",
    };
    const sleep: ScheduleBlock = {
      id: "sleep", type: "sleep", title: "Sleep", date: "2030-03-13", startTime: "22:30", endTime: "07:00",
      locked: true, accepted: true, color: "#64748B", completionStatus: "pending",
    };

    expect(findPushedBlock(lateStudy, [lateStudy, sleep], 30)).toBeNull();
  });

  it("routes every reducer-level week build through the one planner facade", () => {
    const contextSource = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../src/engine/app-context.ts"), "utf8");

    expect(contextSource).toContain('from "./week-planner"');
    expect(contextSource).toContain("buildWeekPlan");
    expect(contextSource).toContain('case "REGENERATE_WEEK"');
    expect(contextSource).toContain('case "AUTO_BUILD_WEEK"');
    expect(contextSource).toContain('case "BUILD_WEEK_FOR"');
    expect(contextSource).toContain('case "PUSH_BLOCK"');
    // The reducer actions that re-planned without a preview or an Undo are gone (1.0.8).
    for (const removed of ["FORCE_REBUILD_WEEK", "DEFER_STUDY_TO_TOMORROW", "FIX_MY_DAY", "RESCHEDULE_MISSED_BLOCKS"]) expect(contextSource).not.toContain(`"${removed}"`);
    expect(contextSource).not.toContain('import { scheduleTasksIntelligently, convertToScheduleBlocks } from "./intelligent-scheduler"');
  });
});
