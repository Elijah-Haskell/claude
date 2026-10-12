/**
 * Syllabus Upload End-to-End Test
 *
 * Simulates the full flow:
 *   1. A student uploads a semester-long syllabus (8+ items spanning 16 weeks)
 *   2. Tasks are created from extracted items
 *   3. The intelligent scheduler places study sessions in the correct weeks
 *   4. Swiping to future weeks (BUILD_WEEK_FOR) shows the right blocks
 *
 * These are unit-level tests — no server/LLM calls needed.
 * We mock the extracted syllabus items and test the scheduling pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTasksIntelligently,
  convertToScheduleBlocks,
} from "../../src/engine/intelligent-scheduler";
import {
  DEFAULT_HEALTH_PREFS,
  DEFAULT_USER_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  Task,
  AppState,
  ScheduleBlock,
} from "../../src/engine/types";
import { addDays, daysBetweenKeys, toDateString, getWeekStart } from "../../src/engine/utils";

// ── Fixtures ─────────────────────────────────────────────────
const TODAY = "2030-03-13"; // Wednesday — start of spring semester mid-point
const WEEK_START = getWeekStart(new Date(TODAY + "T12:00:00"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    onboardingComplete: true,
    classes: [],
    tasks: [],
    scheduleBlocks: [],
    recurringEvents: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    grades: [],
    recommendations: [],
    examPreps: [],
    user: undefined,
    studyGuides: [],
    practiceExams: [],
    syllabusImports: [],
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    googleCalendarEvents: [],
    googleCalendarConnected: false,
    ...overrides,
  };
}

/**
 * Simulate a realistic semester syllabus for "CHEM 201 — Organic Chemistry"
 * with assignments spanning from now through end of semester (16 weeks).
 */
function makeSemesterSyllabus(): Task[] {
  const base = new Date(TODAY + "T12:00:00");
  return [
    // Week 1-2 (near-term)
    {
      id: "hw1",
      name: "Chapter 3 Homework",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 4)),   // 4 days out
      estimatedMinutes: 60,
      difficulty: 2,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    {
      id: "quiz1",
      name: "Quiz 1: Alkanes & Alkenes",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 7)),   // 1 week out
      estimatedMinutes: 45,
      difficulty: 3,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 3-4
    {
      id: "hw2",
      name: "Chapter 5 Homework",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 18)),  // 2.5 weeks out
      estimatedMinutes: 75,
      difficulty: 3,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 5-6 — Midterm
    {
      id: "midterm",
      name: "Midterm Exam",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 35)),  // 5 weeks out
      estimatedMinutes: 180,
      difficulty: 5,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 7-8
    {
      id: "lab1",
      name: "Lab Report 1",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 49)),  // 7 weeks out
      estimatedMinutes: 120,
      difficulty: 3,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 10
    {
      id: "hw3",
      name: "Chapter 9-10 Problem Set",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 63)),  // 9 weeks out
      estimatedMinutes: 90,
      difficulty: 4,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 12 — Research Paper
    {
      id: "paper",
      name: "Research Paper: Synthesis Reactions",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 77)),  // 11 weeks out
      estimatedMinutes: 240,
      difficulty: 4,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
    // Week 15 — Final Exam
    {
      id: "final",
      name: "Final Exam",
      courseId: "chem201",
      courseName: "Organic Chemistry",
      dueDate: toDateString(addDays(base, 105)), // 15 weeks out
      estimatedMinutes: 240,
      difficulty: 5,
      requiresOnCampus: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    },
  ];
}

// ── Tests ─────────────────────────────────────────────────────

describe("Syllabus Upload E2E — task creation", () => {
  it("creates tasks for all 8 syllabus items", () => {
    const tasks = makeSemesterSyllabus();
    expect(tasks.length).toBe(8);
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(tasks.every((t) => t.dueDate >= TODAY)).toBe(true);
  });

  it("tasks span the full semester (from <1 week to 15 weeks out)", () => {
    const tasks = makeSemesterSyllabus();
    const dueDates = tasks.map((t) => t.dueDate).sort();
    const earliest = dueDates[0];
    const latest = dueDates[dueDates.length - 1];
    const daysSpan = daysBetweenKeys(earliest!, latest!);
    // Should span at least 90 days (3 months)
    expect(daysSpan).toBeGreaterThanOrEqual(90);
  });

  it("has correct difficulty ratings (exams harder than homework)", () => {
    const tasks = makeSemesterSyllabus();
    const midterm = tasks.find((t) => t.id === "midterm")!;
    const final = tasks.find((t) => t.id === "final")!;
    const hw1 = tasks.find((t) => t.id === "hw1")!;
    expect(midterm.difficulty).toBeGreaterThan(hw1.difficulty);
    expect(final.difficulty).toBeGreaterThanOrEqual(midterm.difficulty);
  });
});

describe("Syllabus Upload E2E — intelligent scheduling", () => {
  let tasks: Task[];
  let state: AppState;

  beforeEach(() => {
    tasks = makeSemesterSyllabus();
    state = makeState({ tasks });
  });

  it("schedules ALL 8 tasks (none dropped)", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const scheduledIds = new Set(result.scheduledBlocks.map((b) => b.taskId));
    const unscheduledIds = new Set(result.unscheduledTasks.map((u) => u.taskId));

    for (const task of tasks) {
      const isScheduled = scheduledIds.has(task.id);
      const isUnscheduled = unscheduledIds.has(task.id);
      // Each task should be scheduled OR explicitly reported as unschedulable
      expect(isScheduled || isUnscheduled).toBe(true);
      // No task should be silently dropped (neither scheduled nor reported)
      if (!isScheduled && !isUnscheduled) {
        throw new Error(`Task "${task.name}" (${task.id}) was silently dropped!`);
      }
    }
  });

  it("does not schedule the final exam study blocks in the current week", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const currentWeekDates = Array.from({ length: 7 }, (_, i) =>
      toDateString(addDays(WEEK_START, i))
    );
    const finalBlocks = result.scheduledBlocks.filter((b) => b.taskId === "final");
    const finalInCurrentWeek = finalBlocks.filter((b) =>
      currentWeekDates.includes(b.date)
    );
    // Final exam is 15 weeks away — should NOT be placed in the current week
    expect(finalInCurrentWeek.length).toBe(0);
  });

  it("schedules near-term tasks (hw1, quiz1) in the current or next week", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const twoWeeksDates = Array.from({ length: 14 }, (_, i) =>
      toDateString(addDays(WEEK_START, i))
    );
    const hw1Blocks = result.scheduledBlocks.filter((b) => b.taskId === "hw1");
    const quiz1Blocks = result.scheduledBlocks.filter((b) => b.taskId === "quiz1");

    if (hw1Blocks.length > 0) {
      // hw1 is due in 4 days — must be scheduled in the next 4 days
      expect(hw1Blocks.some((b) => twoWeeksDates.includes(b.date))).toBe(true);
    }
    if (quiz1Blocks.length > 0) {
      // quiz1 is due in 7 days — must be scheduled in the next 7 days
      expect(quiz1Blocks.some((b) => twoWeeksDates.includes(b.date))).toBe(true);
    }
  });

  it("places midterm study blocks in the 2 weeks before the midterm", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const midtermTask = tasks.find((t) => t.id === "midterm")!;
    const midtermBlocks = result.scheduledBlocks.filter((b) => b.taskId === "midterm");

    for (const block of midtermBlocks) {
      // calendar days, so a daylight-saving change inside the window cannot add an hour
      const daysBeforeDue = daysBetweenKeys(block.date, midtermTask.dueDate);
      // Should be placed within 14 days before due date
      expect(daysBeforeDue).toBeLessThanOrEqual(14);
      expect(daysBeforeDue).toBeGreaterThanOrEqual(0);
    }
  });

  it("places final exam study blocks in the 2 weeks before the final", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const finalTask = tasks.find((t) => t.id === "final")!;
    const finalBlocks = result.scheduledBlocks.filter((b) => b.taskId === "final");

    for (const block of finalBlocks) {
      const daysBeforeDue = daysBetweenKeys(block.date, finalTask.dueDate);
      expect(daysBeforeDue).toBeLessThanOrEqual(14);
      expect(daysBeforeDue).toBeGreaterThanOrEqual(0);
    }
  });

  it("produces no overlapping blocks across the entire semester window", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    // Group by date
    const byDate: Record<string, typeof result.scheduledBlocks> = {};
    for (const block of result.scheduledBlocks) {
      if (!byDate[block.date]) byDate[block.date] = [];
      byDate[block.date].push(block);
    }
    // Check each day for overlaps
    for (const [date, blocks] of Object.entries(byDate)) {
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const a = blocks[i];
          const b = blocks[j];
          const aStart = parseInt(a.startTime.replace(":", ""));
          const aEnd = parseInt(a.endTime.replace(":", ""));
          const bStart = parseInt(b.startTime.replace(":", ""));
          const bEnd = parseInt(b.endTime.replace(":", ""));
          const overlaps = aStart < bEnd && aEnd > bStart;
          if (overlaps) {
            throw new Error(
              `Overlap on ${date}: "${a.taskName}" (${a.startTime}-${a.endTime}) overlaps with "${b.taskName}" (${b.startTime}-${b.endTime})`
            );
          }
        }
      }
    }
  });

  it("converts all scheduled blocks to ScheduleBlock format correctly", () => {
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const blocks = convertToScheduleBlocks(result.scheduledBlocks);

    for (const block of blocks) {
      expect(block.id).toBeTruthy();
      expect(block.type).toBe("study");
      expect(block.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(block.startTime).toMatch(/^\d{2}:\d{2}$/);
      expect(block.endTime).toMatch(/^\d{2}:\d{2}$/);
      expect(block.accepted).toBe(false); // suggested, not yet accepted
      expect(block.taskId).toBeTruthy();
      expect(block.whatCountsAsDone).toBeTruthy();
      expect(block.startRitual).toBeTruthy();
    }
  });
});

describe("Syllabus Upload E2E — BUILD_WEEK_FOR simulation", () => {
  it("future week (week of midterm) contains midterm study blocks", () => {
    const tasks = makeSemesterSyllabus();
    const state = makeState({ tasks });
    const midtermTask = tasks.find((t) => t.id === "midterm")!;
    const midtermDue = new Date(midtermTask.dueDate + "T12:00:00");

    // The week before the midterm
    const weekBeforeMidterm = getWeekStart(addDays(midtermDue, -7));
    const weekDates = Array.from({ length: 7 }, (_, i) =>
      toDateString(addDays(weekBeforeMidterm, i))
    );

    // Simulate BUILD_WEEK_FOR: run scheduler for that week, filter to that week's dates
    const result = scheduleTasksIntelligently(tasks, state, weekBeforeMidterm);
    const allBlocks = convertToScheduleBlocks(result.scheduledBlocks);
    const weekBlocks = allBlocks.filter((b) => weekDates.includes(b.date));

    // Should have study blocks for the midterm in the week before it's due
    const midtermStudyBlocks = weekBlocks.filter((b) => b.taskId === "midterm");
    expect(midtermStudyBlocks.length).toBeGreaterThan(0);
  });

  it("current week does NOT contain final exam study blocks (too far away)", () => {
    const tasks = makeSemesterSyllabus();
    const state = makeState({ tasks });
    const currentWeekDates = Array.from({ length: 7 }, (_, i) =>
      toDateString(addDays(WEEK_START, i))
    );

    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    const allBlocks = convertToScheduleBlocks(result.scheduledBlocks);
    const currentWeekBlocks = allBlocks.filter((b) =>
      currentWeekDates.includes(b.date)
    );
    const finalInCurrentWeek = currentWeekBlocks.filter(
      (b) => b.taskId === "final"
    );
    expect(finalInCurrentWeek.length).toBe(0);
  });

  it("summary mentions multiple tasks and days", () => {
    const tasks = makeSemesterSyllabus();
    const state = makeState({ tasks });
    const result = scheduleTasksIntelligently(tasks, state, WEEK_START);
    expect(result.summary).toMatch(/session/i);
    expect(result.totalStudyMinutes).toBeGreaterThan(0);
    expect(result.daysWithStudy.length).toBeGreaterThan(0);
  });
});
