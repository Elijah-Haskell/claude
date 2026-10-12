import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleTasksIntelligently, convertToScheduleBlocks } from "../../src/engine/intelligent-scheduler";
import { BLOCK_COLORS, ClassBlock, DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS, Task } from "../../src/engine/types";

describe("strategist to deterministic solver integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-03-11T09:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps exact placement deterministic while honoring named AI learning steps and their durations", () => {
    const task: Task = {
      id: "chem-report", name: "Organic chemistry lab report", courseId: "chem", courseName: "Organic Chemistry",
      dueDate: "2030-03-19", estimatedMinutes: 150, difficulty: 4, requiresOnCampus: false, status: "pending", createdAt: "2030-03-11T09:00:00.000Z",
      planningStrategy: {
        rationale: "Build the report in stages so the revision is not rushed.", priority: 5,
        sessions: [
          { label: "Outline results", purpose: "draft", minutes: 45, earliestDaysBeforeDue: 8, targetDaysBeforeDue: 7 },
          { label: "Write methods and analysis", purpose: "draft", minutes: 75, earliestDaysBeforeDue: 6, targetDaysBeforeDue: 4 },
          { label: "Final check and submit", purpose: "submit", minutes: 30, earliestDaysBeforeDue: 2, targetDaysBeforeDue: 1 },
        ],
      },
    };
    const classes: ClassBlock[] = [{ id: "chem", name: "Organic Chemistry", days: ["Mon", "Wed"], startTime: "10:00", endTime: "11:00", color: BLOCK_COLORS.study }];
    const result = scheduleTasksIntelligently([task], { classes, recurringEvents: [], scheduleBlocks: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS }, new Date("2030-03-11T12:00:00"));
    const blocks = convertToScheduleBlocks(result.scheduledBlocks);

    expect(result.unscheduledTasks).toEqual([]);
    expect(result.scheduledBlocks.map((block) => block.durationMinutes)).toEqual([45, 75, 30]);
    expect(result.scheduledBlocks.map((block) => block.strategyLabel)).toEqual(["Outline results", "Write methods and analysis", "Final check and submit"]);
    expect(blocks.map((block) => block.title)).toEqual([
      "Study: Organic chemistry lab report — Outline results",
      "Study: Organic chemistry lab report — Write methods and analysis",
      "Study: Organic chemistry lab report — Final check and submit",
    ]);
    expect(blocks.every((block) => block.schedulingReason?.includes("Build the report in stages"))).toBe(true);
  });
});
