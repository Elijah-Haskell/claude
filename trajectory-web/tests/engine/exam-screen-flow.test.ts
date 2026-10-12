import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { createInitialState } from "../../src/engine/state-persistence";
import { buildFreeStudyView } from "../../src/engine/study-free-view";
import { buildStudyHub } from "../../src/engine/study-hub";
import { examLinks, examProgress, examSessions, resolveStudyExam } from "../../src/engine/study-view";
import { finishedByStudying } from "../../src/engine/task-progress";
import type { AppState, ScheduleBlock, Task } from "../../src/engine/types";

/**
 * What the exam's screen (app/(tabs)/exam.tsx) shows as the student ticks its study sessions, run through the real
 * reducer. An independent review found that ticking the LAST session made the screen say "This exam is no longer in
 * your plan": the reducer marks the exam's task done once its study minutes are covered, and Study dropped done tasks.
 */

const TODAY = "2030-01-08";

const midterm: Task = {
  id: "t-mid",
  name: "Midterm",
  kind: "exam",
  courseId: "calc",
  courseName: "Calculus II",
  dueDate: "2030-01-13",
  estimatedMinutes: 180,
  difficulty: 3,
  requiresOnCampus: false,
  status: "scheduled",
  createdAt: "2030-01-01T12:00:00.000Z",
};

const study = (id: string, date: string, completionStatus: ScheduleBlock["completionStatus"] = "pending"): ScheduleBlock => ({
  id,
  type: "study",
  title: `Midterm ${id}`,
  date,
  startTime: "10:00",
  endTime: "11:00",
  locked: false,
  accepted: false,
  taskId: "t-mid",
  color: "#8FB3F5",
  completionStatus,
});

const start = (): AppState => ({
  ...createInitialState(),
  onboardingComplete: true,
  tasks: [midterm],
  scheduleBlocks: [study("s1", "2030-01-09"), study("s2", "2030-01-10"), study("s3", "2030-01-11")],
});

/** What the screen works out from the state, for the key it was opened with. */
function screen(state: AppState, key = "task:t-mid", lastTaskId: string | null = null) {
  const view = buildFreeStudyView(buildStudyHub(state, TODAY), state.scheduleBlocks, TODAY);
  const exam = resolveStudyExam(view, key, state.examPreps ?? [], lastTaskId);
  const links = examLinks(exam?.key ?? key, state.examPreps ?? []);
  const sessions = links ? examSessions(state.scheduleBlocks, links.sessionTaskIds) : [];
  return { view, exam, sessions, progress: examProgress(sessions) };
}

const tick = (state: AppState, id: string) => reducer(state, { type: "COMPLETE_BLOCK", payload: id });
const untick = (state: AppState, id: string) => reducer(state, { type: "UNCOMPLETE_BLOCK", payload: id });

describe("ticking an exam's study sessions on its screen", () => {
  it("counts each tick, and the exam is still there after the last one", () => {
    let state = start();
    expect(screen(state).progress).toMatchObject({ line: "3 study sessions · 3 h to go", doneLine: "0 of 3 done" });

    state = tick(state, "s1");
    state = tick(state, "s2");
    expect(screen(state).progress).toMatchObject({ line: "3 study sessions · 1 h to go", doneLine: "2 of 3 done" });

    state = tick(state, "s3");
    // The reducer calls the task done: every minute it needed is studied.
    expect(state.tasks[0]!.status).toBe("done");
    expect(finishedByStudying(state.tasks[0]!, state.scheduleBlocks)).toBe(true);
    // The exam itself is still five days off: it stays on Study and on its own screen, with every box ticked.
    const after = screen(state);
    expect(after.exam?.key).toBe("task:t-mid");
    expect(after.view.exams.map((exam) => exam.key)).toEqual(["task:t-mid"]);
    expect(after.sessions.map((session) => session.status)).toEqual(["done", "done", "done"]);
    expect(after.progress).toMatchObject({ line: "3 study sessions, all done", doneLine: "3 of 3 done", fraction: 1 });
  });

  it("a tick can be taken back, the last one too", () => {
    let state = start();
    for (const id of ["s1", "s2", "s3"]) state = tick(state, id);
    state = untick(state, "s3");
    expect(state.tasks[0]!.status).toBe("scheduled");
    expect(screen(state).progress).toMatchObject({ line: "3 study sessions · 1 h to go", doneLine: "2 of 3 done" });
  });

  it("an exam the student marked done by hand, with studying left, does leave Study", () => {
    const state: AppState = { ...start(), tasks: [{ ...midterm, status: "done", completedMinutes: midterm.estimatedMinutes }] };
    expect(finishedByStudying(state.tasks[0]!, state.scheduleBlocks)).toBe(false);
    const gone = screen(state);
    expect(gone.exam).toBeNull();
    expect(gone.view.exams).toEqual([]);
  });

  it("a finished exam leaves once its day has passed, and a skipped one right away", () => {
    let state = start();
    for (const id of ["s1", "s2", "s3"]) state = tick(state, id);
    const later = buildFreeStudyView(buildStudyHub(state, "2030-01-14"), state.scheduleBlocks, "2030-01-14");
    expect(later.exams).toEqual([]);
    expect(screen({ ...start(), tasks: [{ ...midterm, status: "skipped" }] }).exam).toBeNull();
  });

  it("a task with nothing to study is never 'finished by studying'", () => {
    expect(finishedByStudying({ id: "t", status: "done", estimatedMinutes: 0 }, [])).toBe(false);
    expect(finishedByStudying({ id: "t-mid", status: "scheduled", estimatedMinutes: 60 }, [study("s1", "2030-01-09", "done")])).toBe(false);
    // Another task's sessions and sessions that are not study do not count.
    expect(finishedByStudying({ id: "other", status: "done", estimatedMinutes: 60 }, [study("s1", "2030-01-09", "done")])).toBe(false);
    expect(finishedByStudying({ id: "t-mid", status: "done", estimatedMinutes: 60 }, [{ ...study("s1", "2030-01-09", "done"), type: "class" }])).toBe(false);
  });
});

describe("an exam prep made from the exam's screen", () => {
  const prep = { id: "p1", classId: "calc", className: "Calculus II", examDate: "2030-01-13", examTaskId: "t-mid", topics: [], rawInput: "", studyBlockIds: [], finalReviewGenerated: false, createdAt: "2030-01-08T12:00:00.000Z" };

  it("does not make the screen it was opened from say the exam is gone", () => {
    const state: AppState = { ...start(), examPreps: [prep] };
    // The list now knows the exam by its prep; the screen still holds the task's key.
    const after = screen(state, "task:t-mid");
    expect(after.view.exams.map((exam) => exam.key)).toEqual(["prep:p1"]);
    expect(after.exam?.key).toBe("prep:p1");
    // Its sessions are still the task's (and the prep's own, once it has any).
    expect(after.sessions.map((session) => session.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("nor when that prep is deleted while the screen is open on it", () => {
    const after = screen(start(), "prep:p1", "t-mid");
    expect(after.exam?.key).toBe("task:t-mid");
    expect(after.sessions).toHaveLength(3);
  });
});
