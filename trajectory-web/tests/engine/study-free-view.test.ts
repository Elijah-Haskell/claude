import { describe, expect, it } from "vitest";

import { runwayTaskId } from "../../src/engine/exam-prep-link";
import { buildStudyHub } from "../../src/engine/study-hub";
import { buildFreeStudyView, countdownLabel, plannedLine, prettyExamDate, sessionsFor, urgencyTone } from "../../src/engine/study-free-view";
import type { ExamPrep, ScheduleBlock, Task } from "../../src/engine/types";

const TODAY = "2026-10-01";

const task = (over: Partial<Task> & Pick<Task, "id" | "name">): Task => ({
  courseId: "chem",
  courseName: "CHEM 201",
  dueDate: "2026-10-12",
  estimatedMinutes: 180,
  difficulty: 3,
  requiresOnCampus: false,
  status: "pending",
  createdAt: "2026-09-01T12:00:00.000Z",
  ...over,
});

const prep = (over: Partial<ExamPrep> & Pick<ExamPrep, "id" | "classId" | "className" | "examDate">): ExamPrep => ({
  topics: [],
  rawInput: "",
  studyBlockIds: [],
  finalReviewGenerated: false,
  createdAt: "2026-09-01T12:00:00.000Z",
  ...over,
});

const study = (id: string, taskId: string, date: string, startTime: string, endTime: string, completionStatus: ScheduleBlock["completionStatus"] = "pending"): ScheduleBlock => ({
  id,
  type: "study",
  title: `Study ${id}`,
  date,
  startTime,
  endTime,
  locked: false,
  accepted: false,
  taskId,
  color: "#8FB3F5",
  completionStatus,
});

const tasks: Task[] = [
  task({ id: "t-mid", name: "Midterm 1", kind: "exam", dueDate: "2026-10-12", dueTime: "09:00" }),
  task({ id: "t-quiz", name: "Quiz 3", kind: "quiz", courseId: "bio", courseName: "BIO 110", dueDate: "2026-10-03" }),
  task({ id: "t-essay", name: "Essay 2", kind: "assignment", dueDate: "2026-10-08" }),
  task({ id: "t-final", name: "Old final", kind: "exam", dueDate: "2026-10-09", status: "done" }),
  task({ id: "t-linked", name: "Exam 2", kind: "exam", courseId: "hist", courseName: "HIST 101", dueDate: "2026-10-20" }),
];

const examPreps: ExamPrep[] = [
  prep({ id: "p1", classId: "hist", className: "HIST 101", subject: "Unit 2", examDate: "2026-10-20", examTaskId: "t-linked" }),
  prep({ id: "p-past", classId: "chem", className: "CHEM 201", examDate: "2026-09-20" }),
  prep({ id: "p-nodate", classId: "psy", className: "PSY 100", examDate: "" }),
];

const scheduleBlocks: ScheduleBlock[] = [
  study("b1", "t-mid", "2026-09-30", "15:00", "16:00", "done"),
  study("b2", "t-mid", "2026-10-05", "16:00", "17:30"),
  study("b3", "t-mid", "2026-10-02", "18:00", "19:00"),
  study("b4", "t-mid", "2026-10-06", "10:00", "11:00", "skipped"),
  study("b5", "t-quiz", TODAY, "08:00", "08:45"),
  study("b6", runwayTaskId("p1"), "2026-10-15", "10:00", "11:00"),
  study("b7", "t-linked", "2026-10-10", "14:00", "14:30"),
  // Not a study session: never counted.
  { ...study("c1", "t-mid", "2026-10-03", "09:00", "10:00"), type: "class" },
];

const state = { tasks, examPreps, scheduleBlocks, studyGuides: [], practiceExams: [], syllabusImports: [] };

describe("Study tab without Pro: every exam with its countdown and the study time already planned", () => {
  const hub = buildStudyHub(state, TODAY);
  const view = buildFreeStudyView(hub, scheduleBlocks, TODAY);

  it("lists the same exams as the Pro Study tab, exams and quizzes apart, soonest first, unknown dates last", () => {
    expect(view.exams.map((e) => e.key)).toEqual(["task:t-mid", "prep:p1", "prep:p-nodate"]);
    expect(view.quizzes.map((e) => e.key)).toEqual(["task:t-quiz"]);
    expect(view.past.map((e) => e.key)).toEqual(["prep:p-past"]);
    const hubKeys = [...hub.upcoming.map((h) => `prep:${h.exam.id}`), ...hub.syllabusExams.map((s) => `task:${s.taskId}`)].sort();
    expect([...view.exams, ...view.quizzes].map((e) => e.key).sort()).toEqual(hubKeys);
  });

  it("shows the sessions still ahead in calendar order: not done, not skipped, not past, only study blocks", () => {
    const mid = view.exams[0]!;
    expect(mid).toMatchObject({ name: "Midterm 1", courseName: "CHEM 201", date: "2026-10-12", time: "09:00", kind: "exam", minutes: 150, done: 1 });
    expect(mid.sessions.map((s) => s.id)).toEqual(["b3", "b2"]);
    expect(mid.sessions[1]).toMatchObject({ date: "2026-10-05", startTime: "16:00", endTime: "17:30", minutes: 90, title: "Study b2" });
    // Same count as the Study tab's "N study sessions planned" for that exam.
    const fromHub = hub.syllabusExams.find((s) => s.taskId === "t-mid")!;
    expect([mid.sessions.length, mid.minutes]).toEqual([fromHub.planned.sessions, fromHub.planned.minutes]);
    // A session today counts.
    expect(view.quizzes[0]!.sessions.map((s) => s.id)).toEqual(["b5"]);
  });

  it("an exam prep counts its plan's sessions and its linked exam task's, under the subject's name", () => {
    const p1 = view.exams[1]!;
    expect(p1).toMatchObject({ name: "Unit 2", courseName: "HIST 101", date: "2026-10-20", minutes: 90, done: 0 });
    expect(p1.sessions.map((s) => s.id)).toEqual(["b7", "b6"]);
    expect(view.exams[2]).toMatchObject({ name: "PSY 100", courseName: "", sessions: [], minutes: 0 });
  });

  it("adds up the study time ahead for every upcoming exam and quiz", () => {
    expect(view.plannedSessions).toBe(5);
    expect(view.plannedMinutes).toBe(150 + 45 + 90);
  });

  it("only reads: the plan it was given is unchanged", () => {
    const before = JSON.stringify(scheduleBlocks);
    buildFreeStudyView(hub, scheduleBlocks, TODAY);
    expect(JSON.stringify(scheduleBlocks)).toBe(before);
  });

  it("sessionsFor ignores other tasks' sessions", () => {
    expect(sessionsFor(scheduleBlocks, new Set(["t-essay"]), TODAY)).toEqual({ ahead: [], done: 0 });
  });
});

describe("Study tab wording", () => {
  it("countdown, urgency and dates", () => {
    const hub = buildStudyHub(state, TODAY);
    const view = buildFreeStudyView(hub, scheduleBlocks, TODAY);
    expect(countdownLabel(view.exams[0]!.timing)).toBe("11 DAYS");
    expect(urgencyTone(view.exams[0]!.timing)).toBe("green");
    expect(countdownLabel(view.quizzes[0]!.timing)).toBe("2 DAYS");
    expect(urgencyTone(view.quizzes[0]!.timing)).toBe("red");
    expect(countdownLabel(view.exams[2]!.timing)).toBe("DATE UNKNOWN");
    expect(urgencyTone(view.exams[2]!.timing)).toBe("neutral");
    expect(prettyExamDate("2026-10-12")).toBe("Mon, Oct 12");
    expect(prettyExamDate("garbage")).toBe("garbage");
  });

  it("says how much study time is planned, or nothing when there is none", () => {
    expect(plannedLine(2, 150)).toBe("2 study sessions planned · 2 h 30 min");
    expect(plannedLine(1, 45)).toBe("1 study session planned · 45 min");
    expect(plannedLine(0, 0)).toBe("");
  });
});
