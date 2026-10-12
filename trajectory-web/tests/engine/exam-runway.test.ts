import { describe, expect, it } from "vitest";
import {
  RUNWAY_LEAD_DAYS,
  buildExamRunway,
  examTiming,
  formatMinutes,
  isRunwayTask,
  leadDays,
  previewRunway,
  runwayOutcomeMessage,
  runwayScheduleSummary,
  runwayTaskId,
} from "../../src/engine/exam-runway";
import { buildWeekPlan } from "../../src/engine/week-planner";
import { classifyTaskKind, isTestedTask } from "../../src/engine/task-kind";
import { addDaysToKey, getWeekStart, localDateKey } from "../../src/engine/utils";
import type { AppState, ExamPrep, ExamTopic, MasteryLevel, ScheduleBlock } from "../../src/engine/types";
import { DEFAULT_HEALTH_PREFS, DEFAULT_USER_PREFS } from "../../src/engine/types";
import { NOW, TODAY, expectNoOverlaps, localMoment, makeBlock, makeClass, makeTask } from "./scheduler-fixtures";

// NOW = Wed 2030-03-13 12:00 local; every date below is a LOCAL date key.

function topic(title: string, mastery: MasteryLevel = "needs_review"): ExamTopic {
  return { id: `t-${title}`, title, mastery, reviewCount: 0 };
}

function exam(overrides: Partial<ExamPrep> = {}): ExamPrep {
  return {
    id: "e1",
    classId: "chem",
    className: "Chemistry",
    examDate: addDaysToKey(TODAY, 7),
    topics: [topic("Stoichiometry"), topic("Equilibrium", "mostly_understood")],
    rawInput: "",
    studyBlockIds: [],
    finalReviewGenerated: false,
    createdAt: "2030-03-01T12:00:00.000Z",
    ...overrides,
  };
}

type PlanState = Pick<AppState, "classes" | "recurringEvents" | "tasks" | "scheduleBlocks" | "healthPrefs" | "userPrefs" | "googleCalendarEvents">;

function planState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    classes: [makeClass()],
    recurringEvents: [],
    tasks: [],
    scheduleBlocks: [],
    healthPrefs: { ...DEFAULT_HEALTH_PREFS, wakeTime: "07:00", bedtime: "23:00" },
    userPrefs: DEFAULT_USER_PREFS,
    googleCalendarEvents: [],
    ...overrides,
  };
}

/**
 * Plans every week from the current one through the exam week, feeding each result back in (like the app does as
 * you browse weeks). The student accepts each week's suggestions before moving on: the planner only counts
 * ACCEPTED sessions in other weeks as already covering a task.
 */
function planWholeRunway(state: PlanState, weeks: number): { blocks: ScheduleBlock[]; tasks: PlanState["tasks"] } {
  let current = state;
  const start = getWeekStart(NOW);
  for (let w = 0; w < weeks; w++) {
    const week = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * w);
    const result = buildWeekPlan(current, week, { now: NOW, preserveAccepted: true });
    const accepted = result.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b));
    current = { ...current, scheduleBlocks: accepted, tasks: result.tasks };
  }
  return { blocks: current.scheduleBlocks, tasks: current.tasks };
}

describe("examTiming: local date keys, honest about today and the past", () => {
  it("classifies upcoming / today / past by calendar day", () => {
    expect(examTiming("2030-03-20", TODAY)).toMatchObject({ status: "upcoming", daysLeft: 7, label: "7 days" });
    expect(examTiming("2030-03-14", TODAY)).toMatchObject({ status: "upcoming", daysLeft: 1, label: "Tomorrow" });
    expect(examTiming(TODAY, TODAY)).toMatchObject({ status: "today", daysLeft: 0, label: "Today" });
    expect(examTiming("2030-03-12", TODAY)).toMatchObject({ status: "past", daysLeft: -1, label: "Yesterday" });
    expect(examTiming("2030-03-01", TODAY)).toMatchObject({ status: "past", daysLeft: -12, label: "12 days ago" });
  });

  it("garbage dates are 'invalid', never NaN or 'TODAY'", () => {
    for (const bad of ["", "soon", "2030-3-1", "2030-03-13T00:00:00Z", "13/03/2030"]) {
      expect(examTiming(bad, TODAY).status).toBe("invalid");
    }
  });

  it("uses calendar days across a DST change", () => {
    // US DST started 2030-03-10; Europe 2030-03-31.
    expect(examTiming("2030-04-01", "2030-03-30").daysLeft).toBe(2);
    expect(examTiming("2030-11-04", "2030-11-02").daysLeft).toBe(2);
  });
});

describe("buildExamRunway: the plan an exam becomes", () => {
  const now = NOW;
  const opts = { todayKey: TODAY, now };

  it("is ONE task with kind 'exam' (so it goes through the same solver and gets exam-type sessions)", () => {
    const plan = buildExamRunway(exam(), opts);
    expect(plan.status).toBe("ready");
    const task = plan.task!;
    expect(task.id).toBe(runwayTaskId("e1"));
    expect(isRunwayTask(task)).toBe(true);
    expect(task.kind).toBe("exam");
    expect(classifyTaskKind(task)).toBe("exam");
    expect(isTestedTask(task)).toBe(true);
    expect(task.dueDate).toBe(addDaysToKey(TODAY, 7));
    expect(task.courseId).toBe("chem");
    expect(task.status).toBe("pending");
    expect(task.estimatedMinutes).toBe(plan.totalMinutes);
    expect(plan.sessions.reduce((s, x) => s + x.minutes, 0)).toBe(plan.totalMinutes);
  });

  it("names a session for each weak topic (learn/review then quiz) plus a final review, ordered from earliest to latest", () => {
    const plan = buildExamRunway(exam(), opts);
    expect(plan.sessions.map((s) => s.label)).toEqual([
      "Learn: Stoichiometry",
      "Review: Equilibrium",
      "Quiz yourself: Stoichiometry",
      "Quiz yourself: Equilibrium",
      "Final review before the exam",
    ]);
    expect(plan.sessions.map((s) => s.purpose)).toEqual(["learn", "review", "practice", "practice", "practice"]);
    const leads = plan.sessions.map((s) => s.targetDaysBeforeDue);
    expect([...leads].sort((a, b) => b - a)).toEqual(leads);
    expect(leads[0]).toBe(7);
    expect(leads[leads.length - 1]).toBe(1);
    for (const s of plan.sessions) {
      expect(s.minutes).toBeGreaterThanOrEqual(15);
      expect(s.earliestDaysBeforeDue).toBeGreaterThanOrEqual(s.targetDaysBeforeDue);
      expect(s.earliestDaysBeforeDue).toBeLessThanOrEqual(7);
    }
  });

  it("weak topics only: mastered topics get no time; needs_review comes before mostly_understood", () => {
    const plan = buildExamRunway(exam({ topics: [topic("Done", "mastered"), topic("Almost", "mostly_understood"), topic("Hard", "needs_review")] }), opts);
    expect(plan.weakTopics).toBe(2);
    expect(plan.sessions.map((s) => s.label).join("|")).not.toContain("Done");
    expect(plan.sessions[0]!.label).toBe("Learn: Hard");
    expect(plan.task!.difficulty).toBe(5);
    const onlyMostly = buildExamRunway(exam({ topics: [topic("Almost", "mostly_understood")] }), opts);
    expect(onlyMostly.task!.difficulty).toBe(4);
  });

  it("caps lead time at the solver's prep window (an exam 60 days out is planned from 14 days before)", () => {
    const plan = buildExamRunway(exam({ examDate: addDaysToKey(TODAY, 60) }), opts);
    expect(Math.max(...plan.sessions.map((s) => s.targetDaysBeforeDue))).toBe(RUNWAY_LEAD_DAYS);
    expect(RUNWAY_LEAD_DAYS).toBe(14);
  });

  it("an exam tomorrow puts every session on the one day before", () => {
    const plan = buildExamRunway(exam({ examDate: addDaysToKey(TODAY, 1) }), opts);
    expect(plan.status).toBe("ready");
    expect(new Set(plan.sessions.map((s) => s.targetDaysBeforeDue))).toEqual(new Set([1]));
  });

  it("an exam that has PASSED is not planned (the solver would otherwise treat it as overdue work)", () => {
    for (const examDate of [addDaysToKey(TODAY, -1), addDaysToKey(TODAY, -30)]) {
      const plan = buildExamRunway(exam({ examDate }), opts);
      expect(plan.status).toBe("exam_passed");
      expect(plan.task).toBeNull();
      expect(plan.sessions).toEqual([]);
      expect(plan.message).toMatch(/over|ago|yesterday/i);
    }
  });

  it("an exam TODAY with no start time is not planned (sessions could land after it)", () => {
    const plan = buildExamRunway(exam({ examDate: TODAY }), opts);
    expect(plan.status).toBe("exam_today_no_time");
    expect(plan.task).toBeNull();
    expect(plan.message).toMatch(/today/i);
  });

  it("an exam TODAY at a later time is planned for today only, with its start time as the deadline", () => {
    const plan = buildExamRunway(exam({ examDate: TODAY, examTime: "18:00" }), opts);
    expect(plan.status).toBe("ready");
    expect(plan.task!.dueTime).toBe("18:00");
    expect(new Set(plan.sessions.map((s) => s.targetDaysBeforeDue))).toEqual(new Set([0]));
  });

  it("an exam today whose start time has already passed is treated as over", () => {
    expect(buildExamRunway(exam({ examDate: TODAY, examTime: "09:00" }), opts).status).toBe("exam_passed");
    expect(buildExamRunway(exam({ examDate: TODAY, examTime: "12:00" }), opts).status).toBe("exam_passed");
  });

  it("nothing to plan: invalid date, no topics, everything mastered", () => {
    expect(buildExamRunway(exam({ examDate: "someday" }), opts).status).toBe("invalid_date");
    expect(buildExamRunway(exam({ topics: [] }), opts).status).toBe("no_topics");
    expect(buildExamRunway(exam({ topics: [topic("A", "mastered")] }), opts).status).toBe("all_mastered");
  });

  it("rebuilding keeps createdAt and completed minutes; long topic titles are shortened in labels", () => {
    const existing = makeTask({ id: runwayTaskId("e1"), createdAt: "2030-01-01T00:00:00.000Z", completedMinutes: 45 });
    const plan = buildExamRunway(exam({ topics: [topic("T".repeat(200))] }), { ...opts, existing });
    expect(plan.task!.createdAt).toBe("2030-01-01T00:00:00.000Z");
    expect(plan.task!.completedMinutes).toBe(45);
    expect(plan.sessions[0]!.label.length).toBeLessThanOrEqual(80);
  });

  it("leadDays spreads sessions and degrades sanely", () => {
    expect(leadDays(0, 5)).toEqual([]);
    expect(leadDays(1, 5)).toEqual([1]);
    expect(leadDays(3, 5)).toEqual([5, 3, 1]);
    expect(leadDays(4, 0)).toEqual([0, 0, 0, 0]);
    expect(leadDays(6, 1)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("the runway goes through the SAME solver as every other task (no parallel path, no double-booking)", () => {
  const opts = { todayKey: TODAY, now: NOW };

  it("places every requested minute before the exam, on the exam's own task, as 'exam'-purpose study blocks", () => {
    const plan = buildExamRunway(exam({ examDate: addDaysToKey(TODAY, 9) }), opts);
    const state = planState({ tasks: [plan.task!] });
    const { blocks } = planWholeRunway(state, 3);
    const mine = blocks.filter((b) => b.type === "study" && b.taskId === runwayTaskId("e1"));
    expect(mine.reduce((sum, b) => sum + (Number(b.endTime.slice(0, 2)) * 60 + Number(b.endTime.slice(3)) - (Number(b.startTime.slice(0, 2)) * 60 + Number(b.startTime.slice(3)))), 0)).toBe(plan.totalMinutes);
    expect(mine.every((b) => b.date <= addDaysToKey(TODAY, 9))).toBe(true);
    expect(mine.every((b) => b.date >= TODAY)).toBe(true);
    expect(mine.some((b) => /Stoichiometry/.test(b.title))).toBe(true);
  });

  it("names the sessions the plan asked for, ending with the final review, when the exam falls in the planned week", () => {
    const plan = buildExamRunway(exam({ examDate: "2030-03-15" }), opts); // Friday of the current week
    const result = buildWeekPlan(planState({ tasks: [plan.task!] }), getWeekStart(NOW), { now: NOW });
    const mine = result.scheduleBlocks.filter((b) => b.type === "study" && b.taskId === runwayTaskId("e1"));
    expect(mine.length).toBe(plan.sessions.length);
    const titles = mine.map((b) => b.title).join("|");
    for (const s of plan.sessions) expect(titles).toContain(s.label);
    const last = [...mine].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).at(-1)!;
    expect(last.title).toContain("Final review before the exam");
    expect(result.shortfalls.filter((s) => s.taskId === runwayTaskId("e1"))).toEqual([]);
  });

  it("never overlaps classes, recurring commitments, other tasks' sessions or busy Google Calendar time", () => {
    const plan = buildExamRunway(exam({ examDate: addDaysToKey(TODAY, 9) }), opts);
    const other = makeTask({ id: "essay", name: "History essay", courseId: "hist", courseName: "History", dueDate: addDaysToKey(TODAY, 8), estimatedMinutes: 240 });
    const state = planState({
      classes: [makeClass(), makeClass({ id: "hist", name: "History", days: ["Tue", "Thu"], startTime: "13:00", endTime: "14:30" })],
      recurringEvents: [{ id: "r1", title: "Club", days: ["Mon", "Wed", "Fri"], startTime: "16:00", endTime: "18:00", color: "#06B6D4", locked: true }],
      googleCalendarEvents: [
        { id: "g1", calendarId: "c", title: "Work shift", startDate: addDaysToKey(TODAY, 1), startTime: "08:00", endTime: "17:00", isAllDay: false, isRecurring: false, status: "active", syncedAt: NOW.toISOString() },
      ],
      tasks: [plan.task!, other],
    });
    const { blocks } = planWholeRunway(state, 3);
    const relevant = blocks.filter((b) => b.type !== "sleep");
    expect(relevant.some((b) => b.taskId === runwayTaskId("e1"))).toBe(true);
    expect(expectNoOverlaps(relevant)).toBeNull();
    const shiftDay = addDaysToKey(TODAY, 1);
    for (const b of blocks.filter((x) => x.type === "study" && x.date === shiftDay)) {
      const startMin = Number(b.startTime.slice(0, 2)) * 60 + Number(b.startTime.slice(3));
      const endMin = Number(b.endTime.slice(0, 2)) * 60 + Number(b.endTime.slice(3));
      expect(endMin <= 8 * 60 || startMin >= 17 * 60).toBe(true);
    }
  });

  it("a busy user gets an honest shortfall from the preview instead of a silently truncated plan", () => {
    const heavy = exam({ examDate: addDaysToKey(TODAY, 1), topics: Array.from({ length: 12 }, (_, i) => topic(`Topic ${i + 1}`)) });
    const plan = buildExamRunway(heavy, opts);
    expect(plan.status).toBe("ready");
    const preview = previewRunway(plan, planState(), NOW)!;
    expect(preview.requestedMinutes).toBe(plan.totalMinutes);
    expect(preview.missingMinutes).toBeGreaterThan(0);
    expect(preview.placedMinutes + preview.missingMinutes).toBe(preview.requestedMinutes);
    expect(preview.reason).not.toBe("");
    const message = runwayOutcomeMessage(plan, preview);
    expect(message.tone).toBe("warning");
    expect(message.body).toMatch(/short/);
    expect(message.body).toMatch(/fits before the exam/);
  });

  it("an easy week reports no shortfall and an 'added' message", () => {
    const plan = buildExamRunway(exam(), opts);
    const preview = previewRunway(plan, planState(), NOW)!;
    expect(preview.missingMinutes).toBe(0);
    expect(runwayOutcomeMessage(plan, preview)).toMatchObject({ tone: "ok", title: "Exam plan added" });
  });

  it("previewing does not mutate the caller's state", () => {
    const plan = buildExamRunway(exam(), opts);
    const state = planState({ tasks: [makeTask({ id: "keep" })] });
    const snapshot = JSON.stringify(state);
    previewRunway(plan, state, NOW);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("previewRunway is null when there is nothing to plan", () => {
    expect(previewRunway(buildExamRunway(exam({ examDate: addDaysToKey(TODAY, -3) }), { todayKey: TODAY, now: NOW }), planState(), NOW)).toBeNull();
  });

  it("a rebuilt runway replaces the old task instead of stacking a second one", () => {
    const first = buildExamRunway(exam(), { todayKey: TODAY, now: NOW });
    const second = buildExamRunway(exam({ topics: [topic("Stoichiometry", "mastered"), topic("Equilibrium")] }), { todayKey: TODAY, now: NOW, existing: first.task! });
    expect(second.task!.id).toBe(first.task!.id);
    const preview = previewRunway(second, planState({ tasks: [first.task!] }), NOW)!;
    expect(preview.requestedMinutes).toBe(second.totalMinutes);
  });
});

describe("runwayOutcomeMessage / formatMinutes", () => {
  it("blocked plans explain why", () => {
    const passed = buildExamRunway(exam({ examDate: addDaysToKey(TODAY, -2) }), { todayKey: TODAY, now: NOW });
    expect(runwayOutcomeMessage(passed, null)).toMatchObject({ tone: "blocked", body: passed.message });
  });

  it("formats durations", () => {
    expect([0, 45, 60, 90, 150].map(formatMinutes)).toEqual(["0 min", "45 min", "1 h", "1 h 30 min", "2 h 30 min"]);
  });
});

describe("runwayScheduleSummary", () => {
  it("summarises only this exam's study blocks, ignores skipped ones, finds the next session", () => {
    const id = runwayTaskId("e1");
    const blocks = [
      makeBlock({ taskId: id, date: TODAY, startTime: "09:00", endTime: "10:00", completionStatus: "done" }),
      makeBlock({ taskId: id, date: "2030-03-15", startTime: "14:00", endTime: "15:30" }),
      makeBlock({ taskId: id, date: "2030-03-14", startTime: "14:00", endTime: "14:45" }),
      makeBlock({ taskId: id, date: "2030-03-16", startTime: "14:00", endTime: "15:00", completionStatus: "skipped" }),
      makeBlock({ taskId: runwayTaskId("other"), date: "2030-03-15", startTime: "08:00", endTime: "09:00" }),
      makeBlock({ type: "class", taskId: id, date: "2030-03-15", startTime: "08:00", endTime: "09:00" }),
    ];
    const summary = runwayScheduleSummary(blocks, "e1", TODAY);
    expect(summary.sessions).toBe(3);
    expect(summary.minutes).toBe(60 + 90 + 45);
    expect(summary.done).toBe(1);
    expect(summary.upcoming).toBe(2);
    expect(summary.next?.date).toBe("2030-03-14");
    expect(runwayScheduleSummary([], "e1", TODAY)).toEqual({ sessions: 0, minutes: 0, done: 0, upcoming: 0, next: null });
  });
});

describe("local date keys (not UTC) for 'today'", () => {
  it("localDateKey of an evening moment is that local day, whatever the process time zone", () => {
    const evening = localMoment(2030, 3, 13, 23, 30);
    expect(localDateKey(evening)).toBe("2030-03-13");
    // An exam dated the same local day is 'today', not 'tomorrow' or 'yesterday'.
    expect(examTiming("2030-03-13", localDateKey(evening)).status).toBe("today");
  });
});
