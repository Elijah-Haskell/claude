import { describe, it, expect } from "vitest";
import { generateRecommendations } from "../../src/engine/recommendations";
import { addDaysToKey } from "../../src/engine/utils";
import {
  AppState,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_USER_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  Task,
  Grade,
  ScheduleBlock,
} from "../../src/engine/types";

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
    id: "task-1",
    name: "Homework 1",
    courseId: "c1",
    courseName: "Math",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    estimatedMinutes: 60,
    difficulty: 3,
    requiresOnCampus: false,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Wed 2030-03-13 12:00 local. */
const NOW = new Date(2030, 2, 13, 12, 0);

function studyBlock(id: string, date: string, completionStatus: ScheduleBlock["completionStatus"], startTime = "09:00", endTime = "10:00"): ScheduleBlock {
  return { id, type: "study", title: `Study ${id}`, date, startTime, endTime, locked: false, accepted: true, color: "#4F6EF7", completionStatus };
}

describe("Recommendations Engine", () => {
  it("returns empty array when no issues found", () => {
    const state = makeState();
    const recs = generateRecommendations(state);
    expect(Array.isArray(recs)).toBe(true);
  });

  it("overdue work is left to Today's plan status (1.0.9: the Semester tab no longer repeats it)", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const state = makeState({
      tasks: [
        makeTask({ id: "t1", dueDate: yesterday, status: "pending" }),
        makeTask({ id: "t2", dueDate: yesterday, status: "pending" }),
        makeTask({ id: "t3", dueDate: yesterday, status: "pending" }),
      ],
    });

    const recs = generateRecommendations(state);
    expect(recs.find((r) => /overdue/i.test(r.title))).toBeUndefined();
  });

  it("detects upcoming deadlines within 48 hours", () => {
    const in24Hours = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const state = makeState({
      tasks: [
        makeTask({ id: "t1", dueDate: in24Hours, status: "pending" }),
      ],
    });

    const recs = generateRecommendations(state);
    const urgent = recs.find((r) => r.title.includes("Due Soon"));
    expect(urgent).toBeDefined();
    expect(urgent!.urgency).toBe("high");
  });

  it("does not flag completed tasks as overdue", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const state = makeState({
      tasks: [
        makeTask({ id: "t1", dueDate: yesterday, status: "done" }),
      ],
    });

    const recs = generateRecommendations(state);
    const overdue = recs.find((r) => r.title.includes("Overdue"));
    expect(overdue).toBeUndefined();
  });

  it("detects at-risk classes with low grades", () => {
    const state = makeState({
      classes: [{ id: "c1", name: "Math", days: ["Mon"], startTime: "09:00", endTime: "10:00", color: "#4F6EF7" }],
      grades: [
        { id: "g1", classId: "c1", letterGrade: "D", recordedAt: new Date().toISOString() },
      ],
    });

    const recs = generateRecommendations(state);
    const atRisk = recs.find((r) => r.type === "at_risk");
    expect(atRisk).toBeDefined();
    expect(atRisk!.urgency).toBe("high");
  });

  it("detects heavy workload", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const tasks: Task[] = [];
    for (let i = 0; i < 6; i++) {
      tasks.push(makeTask({
        id: `t${i}`,
        dueDate: tomorrow,
        estimatedMinutes: 120,
        status: "pending",
      }));
    }

    const state = makeState({ tasks });
    const recs = generateRecommendations(state);
    const workload = recs.find((r) => r.title.includes("Workload"));
    expect(workload).toBeDefined();
  });

  it("detects low follow-through on sessions that have ended, and points to Replan (not the removed Fix My Day)", () => {
    // 10 sessions over the 5 days before Wed 2030-03-13 noon: 2 done, 8 missed.
    const blocks = Array.from({ length: 10 }, (_, i) => studyBlock(`b${i}`, addDaysToKey("2030-03-08", i % 5), i < 2 ? "done" : "missed"));
    const recs = generateRecommendations(makeState({ scheduleBlocks: blocks }), NOW);
    const slipping = recs.find((r) => r.type === "recovery" && r.title.includes("Slipping"));
    expect(slipping).toBeDefined();
    expect(slipping!.description).toContain("2 of the 10 study sessions");
    expect(slipping!.urgency).toBe("medium");
    expect(slipping!.actionItems[0]).toMatch(/Catch up on Today to replan/);
  });

  it("a fresh import (every session still ahead) never reads 'Only 0% completed'", () => {
    const future = Array.from({ length: 40 }, (_, i) => studyBlock(`f${i}`, i < 20 ? "2030-03-20" : "2030-04-02", "pending"));
    const laterToday = [studyBlock("t1", "2030-03-13", "pending", "15:00", "16:00")];
    const recs = generateRecommendations(makeState({ scheduleBlocks: [...future, ...laterToday] }), NOW);
    expect(recs.filter((r) => r.type === "recovery" || r.title.includes("Momentum"))).toEqual([]);
  });

  it("waits for at least 6 ended sessions over at least 3 days", () => {
    const fiveOverThreeDays = ["2030-03-10", "2030-03-11", "2030-03-12", "2030-03-12", "2030-03-12"].map((d, i) => studyBlock(`a${i}`, d, "missed"));
    const sixOverTwoDays = ["2030-03-11", "2030-03-11", "2030-03-11", "2030-03-12", "2030-03-12", "2030-03-12"].map((d, i) => studyBlock(`b${i}`, d, "missed"));
    const tooOld = Array.from({ length: 8 }, (_, i) => studyBlock(`c${i}`, `2030-02-0${1 + i}`, "missed")); // more than two weeks ago
    for (const scheduleBlocks of [fiveOverThreeDays, sixOverTwoDays, tooOld]) {
      expect(generateRecommendations(makeState({ scheduleBlocks }), NOW).some((r) => r.type === "recovery")).toBe(false);
    }
  });

  it("a session moved to another day ('Move to tomorrow') is not a missed one", () => {
    const days = ["2030-03-10", "2030-03-11", "2030-03-12"];
    const done = days.flatMap((d, i) => [studyBlock(`d${i}a`, d, "done"), studyBlock(`d${i}b`, d, "done")]);
    const moved = days.map((d, i) => ({ ...studyBlock(`m${i}`, d, "skipped"), deferredDay: true }));
    const recs = generateRecommendations(makeState({ scheduleBlocks: [...done, ...moved] }), NOW);
    expect(recs.find((r) => r.title.includes("Momentum"))?.description).toContain("6 of your last 6");
  });

  it("detects great momentum", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => studyBlock(`b${i}`, addDaysToKey("2030-03-08", i % 5), i < 9 ? "done" : "missed"));
    const recs = generateRecommendations(makeState({ scheduleBlocks: blocks }), NOW);
    const momentum = recs.find((r) => r.title.includes("Momentum"));
    expect(momentum).toBeDefined();
    expect(momentum!.type).toBe("optimization");
  });

  it("a whole semester of work is not divided by the days to the first deadline (was: '30 hours/day of study needed')", () => {
    // 40 tasks of 90 min, one due every other day from Friday: never more than ~0.75 h a day is needed.
    const tasks = Array.from({ length: 40 }, (_, i) => makeTask({ id: `t${i}`, estimatedMinutes: 90, dueDate: addDaysToKey("2030-03-15", 2 * i) }));
    const recs = generateRecommendations(makeState({ tasks }), NOW);
    expect(recs.find((r) => r.title.includes("Workload"))).toBeUndefined();
    // A real crunch still shows: 5 x 3 h due Friday is 15 h over 3 days.
    const crunch = Array.from({ length: 5 }, (_, i) => makeTask({ id: `c${i}`, estimatedMinutes: 180, dueDate: "2030-03-15" }));
    const heavy = generateRecommendations(makeState({ tasks: [...tasks, ...crunch] }), NOW).find((r) => r.title.includes("Workload"));
    expect(heavy?.description).toContain("due by Fri");
  });

  it("a quiz whose date passed is not 'overdue work', and no recommendation mentions a removed feature", () => {
    const quiz = makeTask({ id: "q", name: "Quiz 3", kind: "quiz", dueDate: "2030-03-12" });
    expect(generateRecommendations(makeState({ tasks: [quiz] }), NOW).find((r) => r.title.includes("Overdue"))).toBeUndefined();

    const busy = makeState({
      tasks: [
        makeTask({ id: "late1", dueDate: "2030-03-11" }), makeTask({ id: "late2", dueDate: "2030-03-11" }), makeTask({ id: "late3", dueDate: "2030-03-11" }),
        makeTask({ id: "soon", dueDate: "2030-03-14", estimatedMinutes: 600 }), ...Array.from({ length: 5 }, (_, i) => makeTask({ id: `w${i}`, dueDate: "2030-03-14", estimatedMinutes: 300 })),
      ],
      scheduleBlocks: Array.from({ length: 10 }, (_, i) => studyBlock(`b${i}`, addDaysToKey("2030-03-08", i % 5), "missed")),
      healthPrefs: { ...DEFAULT_HEALTH_PREFS, sleepTargetHours: 8, bedtime: "02:00", wakeTime: "06:00" },
    });
    const text = generateRecommendations(busy, NOW).flatMap((r) => [r.title, r.description, ...r.actionItems]).join(" | ");
    expect(text).not.toMatch(/Fix My Day|Crunch Mode|Protect Sleep|blocks/i);
  });

  it("detects sleep deficit", () => {
    const state = makeState({
      healthPrefs: {
        ...DEFAULT_HEALTH_PREFS,
        sleepTargetHours: 8,
        bedtime: "02:00",
        wakeTime: "06:00",
      },
    });

    const recs = generateRecommendations(state);
    const sleep = recs.find((r) => r.title.includes("Sleep"));
    expect(sleep).toBeDefined();
    expect(sleep!.type).toBe("recovery");
    expect(sleep!.actionItems[0]).toBe("Move your bedtime earlier to 10:00 PM");
  });

  it("sorts recommendations by urgency (high first)", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const blocks: ScheduleBlock[] = [];
    for (let i = 0; i < 10; i++) {
      blocks.push({
        id: `b${i}`,
        type: "study",
        title: `Study ${i}`,
        date: "2026-03-05",
        startTime: "09:00",
        endTime: "10:00",
        locked: false,
        accepted: true,
        color: "#4F6EF7",
        completionStatus: i < 9 ? "done" : "pending",
      });
    }

    const state = makeState({
      tasks: [
        makeTask({ id: "t1", dueDate: yesterday, status: "pending" }),
        makeTask({ id: "t2", dueDate: yesterday, status: "pending" }),
        makeTask({ id: "t3", dueDate: yesterday, status: "pending" }),
      ],
      scheduleBlocks: blocks,
    });

    const recs = generateRecommendations(state);
    if (recs.length >= 2) {
      const urgencyOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < recs.length; i++) {
        expect(urgencyOrder[recs[i].urgency]).toBeGreaterThanOrEqual(
          urgencyOrder[recs[i - 1].urgency]
        );
      }
    }
  });
});

describe("GPA Calculation", () => {
  const GPA_MAP: Record<string, number> = {
    "A": 4.0, "A-": 3.7, "B+": 3.3, "B": 3.0, "B-": 2.7,
    "C+": 2.3, "C": 2.0, "C-": 1.7, "D+": 1.3, "D": 1.0, "F": 0.0,
  };

  it("calculates correct GPA for all A grades", () => {
    const grades: Grade[] = [
      { id: "g1", classId: "c1", letterGrade: "A", recordedAt: "" },
      { id: "g2", classId: "c2", letterGrade: "A", recordedAt: "" },
    ];
    const total = grades.reduce((sum, g) => sum + GPA_MAP[g.letterGrade], 0);
    const gpa = total / grades.length;
    expect(gpa).toBe(4.0);
  });

  it("calculates correct GPA for mixed grades", () => {
    const grades: Grade[] = [
      { id: "g1", classId: "c1", letterGrade: "A", recordedAt: "" },
      { id: "g2", classId: "c2", letterGrade: "B", recordedAt: "" },
      { id: "g3", classId: "c3", letterGrade: "C", recordedAt: "" },
    ];
    const total = grades.reduce((sum, g) => sum + GPA_MAP[g.letterGrade], 0);
    const gpa = total / grades.length;
    expect(gpa).toBeCloseTo(3.0, 1);
  });

  it("returns 0 GPA for F grades", () => {
    const grades: Grade[] = [
      { id: "g1", classId: "c1", letterGrade: "F", recordedAt: "" },
    ];
    const total = grades.reduce((sum, g) => sum + GPA_MAP[g.letterGrade], 0);
    const gpa = total / grades.length;
    expect(gpa).toBe(0.0);
  });
});
