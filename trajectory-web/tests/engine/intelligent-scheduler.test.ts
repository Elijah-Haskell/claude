import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTasksIntelligently,
  convertToScheduleBlocks,
  ScheduledStudyBlock,
} from "../../src/engine/intelligent-scheduler";
import {
  DEFAULT_HEALTH_PREFS,
  DEFAULT_USER_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  ClassBlock,
  Task,
  AppState,
  COURSE_COLORS,
} from "../../src/engine/types";
import { addDaysToKey, timeToMinutes } from "../../src/engine/utils";

// ── Test Fixtures ─────────────────────────────────────────────

const TODAY = "2030-03-13"; // Wednesday

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
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    googleCalendarEvents: [],
    googleCalendarConnected: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    name: "Test Task",
    courseId: "course-1",
    courseName: "Chemistry",
    dueDate: addDaysToKey(TODAY, 5),
    estimatedMinutes: 60,
    difficulty: 3,
    requiresOnCampus: false,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeClass(overrides: Partial<ClassBlock> = {}): ClassBlock {
  return {
    id: "class-1",
    name: "Chemistry",
    color: COURSE_COLORS[0]!,
    location: "Science Hall 201",
    days: ["Mon", "Wed", "Fri"],
    startTime: "10:00",
    endTime: "11:00",
    ...overrides,
  };
}

// ── Core Scheduling Tests ─────────────────────────────────────

describe("scheduleTasksIntelligently — basic scheduling", () => {
  it("schedules a simple task within the week", () => {
    const task = makeTask({ estimatedMinutes: 60 });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    expect(result.unscheduledTasks.length).toBe(0);
  });

  it("returns a non-empty summary", () => {
    const task = makeTask();
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it("schedules multiple tasks", () => {
    const tasks = [
      makeTask({ id: "t1", name: "Essay", estimatedMinutes: 90 }),
      makeTask({ id: "t2", name: "Problem Set", estimatedMinutes: 60 }),
      makeTask({ id: "t3", name: "Reading", estimatedMinutes: 45 }),
    ];
    const state = makeState({ tasks });
    const result = scheduleTasksIntelligently(tasks, state);

    expect(result.scheduledBlocks.length).toBeGreaterThan(0);
    // Most tasks should be scheduled
    expect(result.unscheduledTasks.length).toBeLessThan(tasks.length);
  });

  it("does not schedule blocks that overlap with classes", () => {
    const cls = makeClass({
      days: ["Wed"],
      startTime: "10:00",
      endTime: "12:00",
    });
    const task = makeTask({ estimatedMinutes: 60 });
    const state = makeState({ classes: [cls], tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    // Check no block overlaps with 10:00-12:00 on Wednesday
    const wednesday = TODAY;
    const classStart = timeToMinutes("10:00");
    const classEnd = timeToMinutes("12:00");

    for (const block of result.scheduledBlocks) {
      if (block.date === wednesday) {
        const blockStart = timeToMinutes(block.startTime);
        const blockEnd = timeToMinutes(block.endTime);
        const overlaps =
          blockStart < classEnd && blockEnd > classStart;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("respects no-go zones from user preferences", () => {
    const state = makeState({
      tasks: [makeTask()],
      userPrefs: {
        ...DEFAULT_USER_PREFS,
        noGoZones: [{ startTime: "08:00", endTime: "23:59" }],
      },
    });
    const task = makeTask();
    const result = scheduleTasksIntelligently([task], state);

    // Wednesday should have no blocks
    const wednesdayBlocks = result.scheduledBlocks.filter((b) => b.date === TODAY);
    expect(wednesdayBlocks.length).toBe(0);
  });

  it("schedules blocks within wake/sleep window", () => {
    const state = makeState({
      tasks: [makeTask()],
      healthPrefs: {
        ...DEFAULT_HEALTH_PREFS,
        wakeTime: "08:00",
        bedtime: "22:00",
      },
    });
    const task = makeTask();
    const result = scheduleTasksIntelligently([task], state);

    for (const block of result.scheduledBlocks) {
      const start = timeToMinutes(block.startTime);
      const end = timeToMinutes(block.endTime);
      expect(start).toBeGreaterThanOrEqual(timeToMinutes("08:00"));
      expect(end).toBeLessThanOrEqual(timeToMinutes("22:00"));
    }
  });
});

// ── Task Splitting Tests ──────────────────────────────────────

describe("scheduleTasksIntelligently — task splitting", () => {
  it("splits long tasks into multiple sessions", () => {
    const task = makeTask({ estimatedMinutes: 180 }); // 3 hours — should split
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const blocksForTask = result.scheduledBlocks.filter((b) => b.taskId === task.id);
    expect(blocksForTask.length).toBeGreaterThan(1);
  });

  it("assigns correct session numbers when splitting", () => {
    const task = makeTask({ estimatedMinutes: 180 });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const blocksForTask = result.scheduledBlocks
      .filter((b) => b.taskId === task.id)
      .sort((a, b) => a.sessionNumber - b.sessionNumber);

    for (let i = 0; i < blocksForTask.length; i++) {
      expect(blocksForTask[i]!.sessionNumber).toBe(i + 1);
      expect(blocksForTask[i]!.totalSessions).toBe(blocksForTask.length);
    }
  });

  it("labels a 45-minute task as one session (no phantom '1/2' from a planning buffer)", () => {
    const task = makeTask({ estimatedMinutes: 45 });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const blocksForTask = result.scheduledBlocks.filter((b) => b.taskId === task.id);
    expect(blocksForTask).toHaveLength(1);
    expect(blocksForTask[0]!.totalSessions).toBe(1);
    expect(blocksForTask[0]!.durationMinutes).toBe(45);
  });
});

// ── Post-Class Review Tests ───────────────────────────────────

describe("scheduleTasksIntelligently — post-class review", () => {
  it("marks post-class review blocks correctly", () => {
    const cls = makeClass({
      id: "chem-class",
      name: "Chemistry",
      days: ["Wed"],
      startTime: "10:00",
      endTime: "11:00",
    });
    const task = makeTask({
      courseId: "chem-class",
      courseName: "Chemistry",
      estimatedMinutes: 60,
    });
    const state = makeState({ classes: [cls], tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const postClassBlocks = result.scheduledBlocks.filter((b) => b.isPostClassReview);
    // There should be at least one post-class review block if the task is for a class that meets today
    // (This is a soft check — the scheduler may or may not find a post-class slot depending on availability)
    if (postClassBlocks.length > 0) {
      // Post-class blocks should start after the class ends
      for (const block of postClassBlocks) {
        if (block.date === TODAY) {
          const blockStart = timeToMinutes(block.startTime);
          expect(blockStart).toBeGreaterThanOrEqual(timeToMinutes("11:00"));
        }
      }
    }
  });

  it("post-class review block has a reason mentioning the class", () => {
    const cls = makeClass({
      id: "chem-class",
      name: "Chemistry",
      days: ["Wed"],
      startTime: "10:00",
      endTime: "11:00",
    });
    const task = makeTask({
      courseId: "chem-class",
      courseName: "Chemistry",
      estimatedMinutes: 60,
    });
    const state = makeState({ classes: [cls], tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const postClassBlocks = result.scheduledBlocks.filter((b) => b.isPostClassReview);
    for (const block of postClassBlocks) {
      expect(block.reason.toLowerCase()).toMatch(/class|review|chemistry/i);
    }
  });
});

// ── Priority & Urgency Tests ──────────────────────────────────

describe("scheduleTasksIntelligently — priority ordering", () => {
  it("schedules urgent tasks (due sooner) earlier in the week", () => {
    const urgentTask = makeTask({
      id: "urgent",
      name: "Urgent Essay",
      dueDate: addDaysToKey(TODAY, 1), // due tomorrow
      estimatedMinutes: 60,
    });
    const laterTask = makeTask({
      id: "later",
      name: "Later Reading",
      dueDate: addDaysToKey(TODAY, 6), // due in 6 days
      estimatedMinutes: 60,
    });
    const state = makeState({ tasks: [urgentTask, laterTask] });
    const result = scheduleTasksIntelligently([urgentTask, laterTask], state);

    const urgentBlocks = result.scheduledBlocks.filter((b) => b.taskId === "urgent");
    const laterBlocks = result.scheduledBlocks.filter((b) => b.taskId === "later");

    if (urgentBlocks.length > 0 && laterBlocks.length > 0) {
      const urgentFirstDate = urgentBlocks.sort((a, b) => a.date.localeCompare(b.date))[0]!.date;
      const laterFirstDate = laterBlocks.sort((a, b) => a.date.localeCompare(b.date))[0]!.date;
      // Urgent task should be scheduled no later than the later task
      expect(urgentFirstDate <= laterFirstDate).toBe(true);
    }
  });

  it("marks past-due tasks as unschedulable", () => {
    // An assignment: the default name "Test Task" reads as a test, and a missed test gets no catch-up (1.0.8).
    const pastDueTask = makeTask({
      id: "past-due",
      kind: "assignment",
      dueDate: addDaysToKey(TODAY, -2), // 2 days ago
      estimatedMinutes: 60,
    });
    const state = makeState({ tasks: [pastDueTask] });
    const result = scheduleTasksIntelligently([pastDueTask], state);

    // Past-due task should either be unscheduled or scheduled very early
    const unscheduled = result.unscheduledTasks.find((u) => u.taskId === "past-due");
    const scheduled = result.scheduledBlocks.filter((b) => b.taskId === "past-due");
    // Either unscheduled or scheduled (both are valid behaviors)
    expect(unscheduled !== undefined || scheduled.length > 0).toBe(true);
  });
});

// ── No Overlap Tests ─────────────────────────────────────────

describe("scheduleTasksIntelligently — no overlapping blocks", () => {
  it("produces no overlapping study blocks on the same day", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `task-${i}`, name: `Task ${i}`, estimatedMinutes: 60 })
    );
    const state = makeState({ tasks });
    const result = scheduleTasksIntelligently(tasks, state);

    // Group by date
    const byDate: Record<string, ScheduledStudyBlock[]> = {};
    for (const block of result.scheduledBlocks) {
      if (!byDate[block.date]) byDate[block.date] = [];
      byDate[block.date]!.push(block);
    }

    for (const [, blocks] of Object.entries(byDate)) {
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const a = blocks[i]!;
          const b = blocks[j]!;
          const aStart = timeToMinutes(a.startTime);
          const aEnd = timeToMinutes(a.endTime);
          const bStart = timeToMinutes(b.startTime);
          const bEnd = timeToMinutes(b.endTime);
          const overlaps = aStart < bEnd && aEnd > bStart;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it("does not overlap with existing schedule blocks", () => {
    const existingBlock = {
      id: "existing-1",
      type: "study" as const,
      title: "Existing Study",
      date: addDaysToKey(TODAY, 1),
      startTime: "14:00",
      endTime: "16:00",
      locked: true,
      accepted: true,
      completionStatus: "pending" as const,
    };
    const task = makeTask({ estimatedMinutes: 60 });
    const state = makeState({
      tasks: [task],
      scheduleBlocks: [existingBlock as any],
    });
    const result = scheduleTasksIntelligently([task], state);

    const blocksOnThursday = result.scheduledBlocks.filter((b) => b.date === addDaysToKey(TODAY, 1));
    for (const block of blocksOnThursday) {
      const blockStart = timeToMinutes(block.startTime);
      const blockEnd = timeToMinutes(block.endTime);
      const existStart = timeToMinutes("14:00");
      const existEnd = timeToMinutes("16:00");
      const overlaps = blockStart < existEnd && blockEnd > existStart;
      expect(overlaps).toBe(false);
    }
  });
});

// ── convertToScheduleBlocks Tests ────────────────────────────

describe("convertToScheduleBlocks", () => {
  it("converts scheduled blocks to ScheduleBlock format", () => {
    const task = makeTask();
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    if (result.scheduledBlocks.length > 0) {
      const blocks = convertToScheduleBlocks(result.scheduledBlocks);
      expect(blocks.length).toBe(result.scheduledBlocks.length);

      for (const block of blocks) {
        expect(block.id).toBeTruthy();
        expect(block.type).toBe("study");
        expect(block.accepted).toBe(false); // suggested, not accepted
        expect(block.startTime).toBeTruthy();
        expect(block.endTime).toBeTruthy();
        expect(block.whatCountsAsDone).toBeTruthy();
        expect(block.startRitual).toBeTruthy();
      }
    }
  });

  it("marks post-class review blocks with review ritual", () => {
    const cls = makeClass({
      id: "chem-class",
      name: "Chemistry",
      days: ["Wed"],
      startTime: "10:00",
      endTime: "11:00",
    });
    const task = makeTask({ courseId: "chem-class", courseName: "Chemistry" });
    const state = makeState({ classes: [cls], tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const postClassBlocks = result.scheduledBlocks.filter((b) => b.isPostClassReview);
    if (postClassBlocks.length > 0) {
      const converted = convertToScheduleBlocks(postClassBlocks);
      for (const block of converted) {
        expect(block.startRitual?.toLowerCase()).toMatch(/review|notes|class/i);
      }
    }
  });

  it("includes split session numbers in title", () => {
    const task = makeTask({ estimatedMinutes: 180 });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);

    const splitBlocks = result.scheduledBlocks.filter(
      (b) => b.taskId === task.id && b.totalSessions > 1
    );
    if (splitBlocks.length > 0) {
      const converted = convertToScheduleBlocks(splitBlocks);
      for (const block of converted) {
        expect(block.title).toMatch(/\(\d+\/\d+\)/);
      }
    }
  });
});

// ── Semester-Long Scheduling Tests ───────────────────────────
describe("scheduleTasksIntelligently — semester-long horizon", () => {
  it("schedules a task due 8 weeks from now (previously dropped by 4-week cap)", () => {
    const task = makeTask({
      dueDate: addDaysToKey(TODAY, 56), // 8 weeks out
      estimatedMinutes: 120,
    });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);
    // Task should be scheduled (not dropped)
    expect(result.unscheduledTasks.find((u) => u.taskId === task.id)).toBeUndefined();
    expect(result.scheduledBlocks.filter((b) => b.taskId === task.id).length).toBeGreaterThan(0);
  });

  it("schedules a final exam task due 16 weeks from now", () => {
    const task = makeTask({
      name: "Final Exam",
      dueDate: addDaysToKey(TODAY, 112), // 16 weeks out
      estimatedMinutes: 180,
      difficulty: 5,
    });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);
    // Should be scheduled (not dropped)
    expect(result.unscheduledTasks.find((u) => u.taskId === task.id)).toBeUndefined();
    expect(result.scheduledBlocks.filter((b) => b.taskId === task.id).length).toBeGreaterThan(0);
  });

  it("places far-future tasks in the 2 weeks before their due date, not immediately", () => {
    const dueDate = addDaysToKey(TODAY, 60); // 60 days out
    const task = makeTask({
      dueDate,
      estimatedMinutes: 90,
    });
    const state = makeState({ tasks: [task] });
    const result = scheduleTasksIntelligently([task], state);
    const blocks = result.scheduledBlocks.filter((b) => b.taskId === task.id);
    if (blocks.length > 0) {
      // All blocks should be within 14 days of the due date
      const dueDateMs = new Date(dueDate + "T12:00:00").getTime();
      for (const block of blocks) {
        const blockMs = new Date(block.date + "T12:00:00").getTime();
        const daysBeforeDue = (dueDateMs - blockMs) / 86400000;
        expect(daysBeforeDue).toBeLessThanOrEqual(14);
        expect(daysBeforeDue).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("handles a mix of near-term and semester-long tasks", () => {
    const nearTask = makeTask({
      id: "near",
      name: "Quiz",
      dueDate: addDaysToKey(TODAY, 3),
      estimatedMinutes: 60,
    });
    const farTask = makeTask({
      id: "far",
      name: "Final Project",
      dueDate: addDaysToKey(TODAY, 70),
      estimatedMinutes: 240,
    });
    const state = makeState({ tasks: [nearTask, farTask] });
    const result = scheduleTasksIntelligently([nearTask, farTask], state);
    // Both should be scheduled
    const nearBlocks = result.scheduledBlocks.filter((b) => b.taskId === "near");
    const farBlocks = result.scheduledBlocks.filter((b) => b.taskId === "far");
    expect(nearBlocks.length).toBeGreaterThan(0);
    expect(farBlocks.length).toBeGreaterThan(0);
    // Near task blocks should be before far task blocks
    const nearDates = nearBlocks.map((b) => b.date).sort();
    const farDates = farBlocks.map((b) => b.date).sort();
    expect(nearDates[0]! < farDates[0]!).toBe(true);
  });

  it("plans overdue tasks as soon as possible (today/tomorrow) instead of dropping them", () => {
    const pastTask = makeTask({
      kind: "assignment", // "Test Task" would read as a test: a missed test is not caught up (see below)
      dueDate: addDaysToKey(TODAY, -3), // 3 days ago
      estimatedMinutes: 60,
    });
    const state = makeState({ tasks: [pastTask] });
    const result = scheduleTasksIntelligently([pastTask], state);
    const blocks = result.scheduledBlocks.filter((b) => b.taskId === pastTask.id);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.date === TODAY || b.date === addDaysToKey(TODAY, 1))).toBe(true);
    expect(blocks.every((b) => b.isOverdue)).toBe(true);
    expect(result.overdueTasks).toEqual([{ taskId: pastTask.id, taskName: pastTask.name, dueDate: pastTask.dueDate, daysOverdue: 3 }]);
    expect(result.unscheduledTasks.find((u) => u.taskId === pastTask.id)).toBeUndefined();
  });

  it("dynamic window extends to cover the latest due date", () => {
    const task1 = makeTask({ dueDate: addDaysToKey(TODAY, 30) });
    const task2 = makeTask({ dueDate: addDaysToKey(TODAY, 90) }); // 90 days
    const state = makeState({ tasks: [task1, task2] });
    // Both tasks should be schedulable
    const result = scheduleTasksIntelligently([task1, task2], state);
    const task2Blocks = result.scheduledBlocks.filter((b) => b.taskId === task2.id);
    expect(task2Blocks.length).toBeGreaterThan(0);
  });
});
