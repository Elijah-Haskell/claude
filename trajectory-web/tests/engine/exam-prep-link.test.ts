import { describe, expect, it, vi } from "vitest";

// The reducer lives next to the React provider; stub the native modules it imports.
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { reducer } from "../../src/engine/app-context";
import { applyDeadlineChanges, previewAssistantChange } from "../../src/engine/assistant-change";
import {
  examPrepsToRelink,
  examsPlannedByPrep,
  findExamTask,
  followExamDates,
  matchExamTask,
  MIXED_PRACTICE_LABEL,
  sizePrepsToExams,
  withExamTopUp,
  withLinkedExam,
} from "../../src/engine/exam-prep-link";
import { buildExamRunway, examTiming, previewRunway, runwayOutcomeMessage, runwayScheduleSummary, runwayTaskId } from "../../src/engine/exam-runway";
import { planInputsKey } from "../../src/engine/plan-inputs";
import { previewPlanChange } from "../../src/engine/replan";
import { buildSemesterPlan } from "../../src/engine/semester-plan";
import { buildStudyHub } from "../../src/engine/study-hub";
import { blockMinutes, remainingMinutes } from "../../src/engine/task-progress";
import type { AppState, ExamPrep, ScheduleBlock, Task } from "../../src/engine/types";
import { fincState } from "./fixtures/stress-semester";
import { makeBlock, makeTask, TODAY } from "./scheduler-fixtures";

const prep = (over: Partial<ExamPrep> = {}): ExamPrep => ({
  id: "p1",
  classId: "chem",
  className: "Chemistry",
  examDate: "2030-03-20",
  topics: [
    { id: "t1", title: "Stoichiometry", mastery: "needs_review", reviewCount: 0 },
    { id: "t2", title: "Equilibrium", mastery: "mostly_understood", reviewCount: 0 },
  ],
  rawInput: "",
  studyBlockIds: [],
  finalReviewGenerated: false,
  createdAt: "2030-03-01T00:00:00.000Z",
  ...over,
});

describe("matchExamTask / findExamTask: which exam a prep is for", () => {
  const midterm = makeTask({ id: "mid", name: "Midterm", kind: "exam", courseId: "chem", dueDate: "2030-03-20" });
  const quiz = makeTask({ id: "q5", name: "Quiz 5", kind: "quiz", courseId: "chem", dueDate: "2030-03-20" });

  it("an exam beats a quiz on the same day; nothing on another day, class or for a prep's own study task", () => {
    expect(matchExamTask([quiz, midterm], "chem", "2030-03-20")?.id).toBe("mid");
    expect(matchExamTask([quiz], "chem", "2030-03-20")?.id).toBe("q5");
    expect(matchExamTask([midterm], "chem", "2030-03-21")).toBeUndefined();
    expect(matchExamTask([midterm], "bio", "2030-03-20")).toBeUndefined();
    expect(matchExamTask([midterm], "", "2030-03-20")).toBeUndefined();
    expect(matchExamTask([makeTask({ id: runwayTaskId("x"), name: "Chemistry exam prep", kind: "exam", courseId: "chem", dueDate: "2030-03-20" })], "chem", "2030-03-20")).toBeUndefined();
    expect(matchExamTask([makeTask({ id: "hw", name: "Lab report", kind: "assignment", courseId: "chem", dueDate: "2030-03-20" })], "chem", "2030-03-20")).toBeUndefined();
  });

  it("never guesses between two exams of one class on one day", () => {
    const other = makeTask({ id: "mid-b", name: "Midterm part B", kind: "exam", courseId: "chem", dueDate: "2030-03-20" });
    expect(matchExamTask([midterm, other], "chem", "2030-03-20")).toBeUndefined();
  });

  it("uses the prep's link, then its study task's link, then (older preps) class + date; a broken link is not replaced by a guess", () => {
    const moved = { ...midterm, dueDate: "2030-03-17" };
    expect(findExamTask(prep({ examTaskId: "mid" }), [moved])?.id).toBe("mid");
    const runway = makeTask({ id: runwayTaskId("p1"), examTaskId: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-20" });
    expect(findExamTask(prep(), [moved, runway])?.id).toBe("mid");
    expect(findExamTask(prep(), [midterm])?.id).toBe("mid");
    expect(findExamTask(prep({ examTaskId: "deleted" }), [midterm])).toBeUndefined();
  });
});

describe("withLinkedExam: the prep shows its exam task's current date and time", () => {
  it("follows a moved exam and fills in the link; unchanged preps are returned as is", () => {
    const tasks = [makeTask({ id: "mid", name: "Midterm", kind: "exam", courseId: "chem", dueDate: "2030-03-17", dueTime: "09:30" })];
    expect(withLinkedExam(prep({ examTaskId: "mid" }), tasks)).toMatchObject({ examDate: "2030-03-17", examTime: "09:30", examTaskId: "mid" });
    const same = prep({ examTaskId: "mid", examDate: "2030-03-17", examTime: "09:30" });
    expect(withLinkedExam(same, tasks)).toBe(same);
    const handMade = prep({ classId: "bio" });
    expect(withLinkedExam(handMade, tasks)).toBe(handMade);
  });

  it("keeps the time the student typed while the day is the same, and drops it once the exam moves to another day", () => {
    const sameDay = [makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-20" })];
    expect(withLinkedExam(prep({ examTime: "14:00" }), sameDay)).toMatchObject({ examDate: "2030-03-20", examTime: "14:00", examTaskId: "mid" });
    const otherDay = [makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-18" })];
    const moved = withLinkedExam(prep({ examTaskId: "mid", examTime: "14:00" }), otherDay);
    expect(moved.examDate).toBe("2030-03-18");
    expect(moved.examTime).toBeUndefined();
  });

  it("examPrepsToRelink lists only the preps whose saved link or date is behind", () => {
    const tasks = [makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-18" })];
    const upToDate = prep({ id: "p2", examTaskId: "mid", examDate: "2030-03-18" });
    expect(examPrepsToRelink([prep({ examTaskId: "mid" }), upToDate, prep({ id: "p3", classId: "bio" })], tasks)).toEqual([
      expect.objectContaining({ id: "p1", examDate: "2030-03-18", examTaskId: "mid" }),
    ]);
    expect(examPrepsToRelink(undefined, tasks)).toEqual([]);
  });
});

describe("followExamDates: a prep's study task takes its exam's date", () => {
  it("a linked study task follows its exam; other tasks are the same objects; nothing changed returns the same array", () => {
    const exam = makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-17", dueTime: "08:00" });
    const hw = makeTask({ id: "hw" });
    const runway = makeTask({ id: runwayTaskId("p1"), kind: "exam", courseId: "chem", dueDate: "2030-03-20", examTaskId: "mid" });
    const next = followExamDates([exam, hw, runway]);
    expect(next[2]).toMatchObject({ dueDate: "2030-03-17", dueTime: "08:00", examTaskId: "mid" });
    expect(next[0]).toBe(exam);
    expect(next[1]).toBe(hw);
    expect(followExamDates(next)).toBe(next);
  });

  it("an older study task (no link) is linked by class and its old date, matched BEFORE the exam moved", () => {
    const before = [makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-20" }), makeTask({ id: runwayTaskId("p1"), kind: "exam", courseId: "chem", dueDate: "2030-03-20" })];
    const after = [{ ...before[0]!, dueDate: "2030-03-17" }, before[1]!];
    expect(followExamDates(after)[1]!.dueDate).toBe("2030-03-20"); // without the old tasks there is nothing to match
    expect(followExamDates(after, before)[1]).toMatchObject({ dueDate: "2030-03-17", examTaskId: "mid" });
  });

  it("applyDeadlineChanges (the chat) moves the exam's prep with it", () => {
    const tasks = [makeTask({ id: "mid", kind: "exam", courseId: "chem", dueDate: "2030-03-20" }), makeTask({ id: runwayTaskId("p1"), kind: "exam", courseId: "chem", dueDate: "2030-03-20" })];
    const moved = applyDeadlineChanges(tasks, [{ taskId: "mid", dueDate: "2030-03-17" }]);
    expect(moved.map((t) => t.dueDate)).toEqual(["2030-03-17", "2030-03-17"]);
    expect(moved[1]!.examTaskId).toBe("mid");
  });

  it("buildExamRunway passes the prep's link on to its study task", () => {
    const opts = { todayKey: TODAY, now: new Date(2030, 2, 13, 12, 0) };
    expect(buildExamRunway(prep({ examTaskId: "mid" }), opts).task!.examTaskId).toBe("mid");
    expect(buildExamRunway(prep(), opts).task!.examTaskId).toBeUndefined();
  });
});

// ── The audit's probe: FINC-3100 with an Exam Prep for Exam 1, then the exam moves 10-14 -> 10-11 ──────────────────

const FINC_EXAM = "finc-exam1";
const PROBE_NOW = new Date(2026, 9, 5, 8, 0); // Mon 5 Oct 2026, 9 days before Exam 1 (Wed 14 Oct)
const PROBE_TODAY = "2026-10-05";

/** An Exam Prep for FINC Exam 1 (4 topics to learn: 4 x 60 + 4 x 30 + 45 = 405 minutes of named sessions). */
function examOnePrep(topics = ["Financial Statements", "Statement Analysis", "Forecasting", "Working Capital"], mastery: "needs_review" | "mostly_understood" = "needs_review"): ExamPrep {
  return {
    id: "prep-exam1",
    classId: "class-finc",
    className: "Principles of Finance",
    subject: "Exam 1",
    examDate: "2026-10-14",
    topics: topics.map((title, i) => ({ id: `t${i}`, title, mastery, reviewCount: 0 })),
    rawInput: "",
    studyBlockIds: [],
    finalReviewGenerated: false,
    createdAt: "2026-10-01T12:00:00.000Z",
  };
}

function fincWithPrep(): { state: AppState; exam: ExamPrep } {
  const base = fincState();
  const exam = examOnePrep();
  // Saved by 1.0.7: neither the prep nor its study task carries a link yet.
  const runway = buildExamRunway(exam, { todayKey: PROBE_TODAY, now: PROBE_NOW }).task!;
  expect(runway.examTaskId).toBeUndefined();
  const withRunway: AppState = { ...base, examPreps: [exam], tasks: [...base.tasks, runway] };
  const plan = buildSemesterPlan(withRunway, { now: PROBE_NOW });
  // The student accepted every session (the hardest case: confirmed sessions are normally kept where they are).
  const scheduleBlocks = plan.scheduleBlocks.map((b) => (b.type === "study" ? { ...b, accepted: true } : b));
  return { state: { ...withRunway, scheduleBlocks }, exam };
}

const prepSessions = (blocks: ScheduleBlock[]) =>
  blocks.filter((b) => b.type === "study" && (b.taskId === runwayTaskId("prep-exam1") || b.taskId === FINC_EXAM) && b.completionStatus === "pending");

describe("audit probe: exam prep follows a moved exam (FINC-3100, Exam 1 moved 10-14 -> 10-11)", () => {
  it("before the move, prep sessions sit on 10-11..10-13 (so the probe really tests something)", () => {
    const { state } = fincWithPrep();
    const runwaySessions = state.scheduleBlocks.filter((b) => b.taskId === runwayTaskId("prep-exam1"));
    expect(runwaySessions.length).toBeGreaterThan(0);
    expect(runwaySessions.some((b) => b.date >= "2026-10-11")).toBe(true);
    expect(runwaySessions.every((b) => b.date < "2026-10-14")).toBe(true);
  });

  it("chat: 0 prep sessions on or after the new date, the prep's study task and the screen say 10-11", () => {
    const { state, exam } = fincWithPrep();
    const preview = previewAssistantChange(state, { label: "Exam 1 moved", deadlineChanges: [{ taskId: FINC_EXAM, dueDate: "2026-10-11" }] }, { now: PROBE_NOW });
    const next: AppState = { ...state, ...preview.next };

    // Sunday 11 Oct, no time: nothing may be planned on the exam day itself either.
    expect(prepSessions(next.scheduleBlocks).filter((b) => b.date >= "2026-10-11")).toEqual([]);
    expect(prepSessions(next.scheduleBlocks).filter((b) => b.taskId === runwayTaskId("prep-exam1")).length).toBeGreaterThan(0);
    expect(next.tasks.find((t) => t.id === runwayTaskId("prep-exam1"))).toMatchObject({ dueDate: "2026-10-11", examTaskId: FINC_EXAM });

    const shown = withLinkedExam(exam, next.tasks);
    expect(shown.examDate).toBe("2026-10-11");
    expect(examTiming(shown.examDate, PROBE_TODAY)).toMatchObject({ status: "upcoming", daysLeft: 6 });
    const hub = buildStudyHub(next, PROBE_TODAY);
    expect(hub.upcoming[0]!.exam.examDate).toBe("2026-10-11");
    expect(hub.upcoming[0]!.timing.daysLeft).toBe(6);
  });

  it("task editor (previewPlanChange) and the automatic re-plan: prep lands before the new date too", () => {
    const { state } = fincWithPrep();
    // Any plan after the upgrade links the older study task to its exam (the app plans once at every launch).
    const launched = reducer(state, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(launched.tasks.find((t) => t.id === runwayTaskId("prep-exam1"))!.examTaskId).toBe(FINC_EXAM);

    const moveExam = (tasks: Task[]) => tasks.map((t) => (t.id === FINC_EXAM ? { ...t, dueDate: "2026-10-11" } : t));
    const edited = previewPlanChange(launched, { ...launched, tasks: moveExam(launched.tasks) }, { now: PROBE_NOW, label: "Deadline change" });
    expect(prepSessions(edited.next.scheduleBlocks!).filter((b) => b.date >= "2026-10-11")).toEqual([]);

    // Saved and applied like the task editor does it, then undone: the prep follows the exam back.
    const applied = reducer(launched, { type: "APPLY_REPLAN", payload: { label: "Deadline change", at: PROBE_NOW.toISOString(), next: edited.next } });
    expect(withLinkedExam(state.examPreps[0]!, applied.tasks).examDate).toBe("2026-10-11");
    const undone = reducer(applied, { type: "UNDO_REPLAN" });
    expect(undone.tasks.find((t) => t.id === FINC_EXAM)!.dueDate).toBe("2026-10-14");
    expect(withLinkedExam(state.examPreps[0]!, undone.tasks).examDate).toBe("2026-10-14");

    // A plain edit followed by the automatic re-plan.
    const updated = reducer(launched, { type: "UPDATE_TASK", payload: moveExam(launched.tasks).find((t) => t.id === FINC_EXAM)! });
    const replanned = reducer(updated, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(prepSessions(replanned.scheduleBlocks).filter((b) => b.date >= "2026-10-11")).toEqual([]);
    expect(replanned.tasks.find((t) => t.id === runwayTaskId("prep-exam1"))!.dueDate).toBe("2026-10-11");
  });
});

// ── One plan per exam (1.0.9): an exam with an Exam Prep is planned only through the prep ─────────────────────────

const RUNWAY = runwayTaskId("prep-exam1");
const live = (blocks: ScheduleBlock[], taskId: string) => blocks.filter((b) => b.type === "study" && b.taskId === taskId && b.completionStatus === "pending");
const minutesOf = (blocks: ScheduleBlock[]) => blocks.reduce((sum, b) => sum + blockMinutes(b), 0);
const shortOf = (state: AppState, taskId: string) => state.planAlerts?.shortfalls.find((s) => s.taskId === taskId)?.missingMinutes ?? 0;

/**
 * What 1.0.8 saved for the same student: Exam 1's own sessions AND its prep's (its planner never linked the two; here
 * the prep is planned with a dead link, then saved without one as 1.0.7 / 1.0.8 did).
 */
function fincWithDuplicates(exam = examOnePrep()): { state: AppState; exam: ExamPrep } {
  const base = fincState();
  const runway = buildExamRunway(exam, { todayKey: PROBE_TODAY, now: PROBE_NOW }).task!;
  const plan = buildSemesterPlan({ ...base, tasks: [...base.tasks, { ...runway, examTaskId: "not-linked" }] }, { now: PROBE_NOW });
  const tasks = plan.tasks.map((t) => {
    if (t.id !== runway.id) return t;
    const { examTaskId: _dead, ...saved } = t;
    return saved;
  });
  return { state: { ...base, examPreps: [exam], tasks, scheduleBlocks: plan.scheduleBlocks, planAlerts: undefined }, exam };
}

describe("an exam with an Exam Prep is planned once, through the prep (1.0.8 audit: FINC Exam 1 got 240 min of its own AND 405 of its prep)", () => {
  it("a new plan gives the exam no sessions of its own; the prep plans max(its sessions, the exam's estimate) and the screens count exactly that", () => {
    const { state } = fincWithPrep();
    expect(live(state.scheduleBlocks, FINC_EXAM)).toEqual([]); // was 240 min of "Exam 1" sessions on top of the prep
    const runway = followExamDates(state.tasks).find((t) => t.id === RUNWAY)!;
    expect(runway.examTaskId).toBe(FINC_EXAM);
    const exam1 = state.tasks.find((t) => t.id === FINC_EXAM)!;
    const plan = buildSemesterPlan(state, { now: PROBE_NOW });
    const planned = minutesOf(live(plan.scheduleBlocks, RUNWAY));
    const short = plan.shortfalls.find((s) => s.taskId === RUNWAY)?.missingMinutes ?? 0;
    expect(planned + short).toBe(Math.max(405, remainingMinutes(exam1))); // 405, not 645
    expect(plan.shortfalls.some((s) => s.taskId === FINC_EXAM)).toBe(false);
    // Exam Prep, the Study tab and Today count the exam's and the prep's sessions together: now the same number.
    const hub = buildStudyHub({ ...state, scheduleBlocks: plan.scheduleBlocks }, PROBE_TODAY);
    expect(hub.upcoming[0]!.runway.minutes).toBe(planned);
    console.log(`FINC Exam 1 with its prep: ${planned} min planned (${short} short); 1.0.8: ${remainingMinutes(exam1)} + 405`);
  });

  it("a plan saved by 1.0.8 with both heals on the next automatic re-plan: the exam's suggestions go, a session the student confirmed stays and counts toward the prep", () => {
    const { state: saved } = fincWithDuplicates();
    const own = live(saved.scheduleBlocks, FINC_EXAM).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    expect(own.length).toBeGreaterThan(1); // the duplicates really are there
    const prepBefore = live(saved.scheduleBlocks, RUNWAY);
    expect(minutesOf(own) + minutesOf(prepBefore)).toBeGreaterThan(405);
    const confirmed = own[0]!;
    const state: AppState = { ...saved, scheduleBlocks: saved.scheduleBlocks.map((b) => (b.id === confirmed.id ? { ...b, accepted: true } : b)) };

    const healed = reducer(state, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(live(healed.scheduleBlocks, FINC_EXAM).map((b) => b.id)).toEqual([confirmed.id]); // only the confirmed one
    expect(healed.scheduleBlocks.find((b) => b.id === confirmed.id)).toMatchObject({ date: confirmed.date, startTime: confirmed.startTime });
    const prep = live(healed.scheduleBlocks, RUNWAY);
    expect(blockMinutes(confirmed) + minutesOf(prep) + shortOf(healed, RUNWAY)).toBe(405);
    // Stable: the prep's sessions that stay start where they were (its latest gave way to the confirmed exam session,
    // the last one kept possibly shorter).
    const starts = new Set(prepBefore.map((b) => `${b.date}|${b.startTime}`));
    expect(prep.filter((b) => !starts.has(`${b.date}|${b.startTime}`))).toEqual([]);
    expect(reducer(healed, { type: "AUTO_REPLAN", payload: { now: new Date(PROBE_NOW.getTime() + 60_000) } }).scheduleBlocks).toEqual(healed.scheduleBlocks);
    console.log(`1.0.8 save healed: ${own.length - 1} unconfirmed Exam 1 sessions removed, ${minutesOf(own) + minutesOf(prepBefore)} -> ${blockMinutes(confirmed) + minutesOf(prep)} min`);
  });

  it("the first launch after the update cleans up 1.0.8's double time once, with no Undo and no second re-plan (1.0.9 audit: an endless clean-up/Undo loop)", () => {
    // 1.0.8 saved Exam 1's own suggestions and a small prep's (165 min, no mixed practice yet), and an older Undo.
    const { state: saved } = fincWithDuplicates(examOnePrep(["Working Capital", "Forecasting"], "mostly_understood"));
    const older = { label: "Replan this week", at: "2026-10-04T20:00:00.000Z", scheduleBlocks: saved.scheduleBlocks, tasks: saved.tasks, source: "manual" as const };
    const upgraded: AppState = { ...saved, undoSnapshots: [older] };
    expect(live(upgraded.scheduleBlocks, FINC_EXAM).length).toBeGreaterThan(0);
    const key = planInputsKey(upgraded, PROBE_TODAY);

    // The launch re-plan: the exam's suggestions go, mixed practice sizes the prep to the exam's 240 min. No Undo of its
    // own (the older one stays), and the plan inputs are the same, so the app does not plan again 1.5 s later.
    const launched = reducer(upgraded, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(live(launched.scheduleBlocks, FINC_EXAM)).toEqual([]);
    expect(minutesOf(live(launched.scheduleBlocks, RUNWAY)) + shortOf(launched, RUNWAY)).toBe(240);
    expect(live(launched.scheduleBlocks, RUNWAY).some((b) => b.title.includes(MIXED_PRACTICE_LABEL))).toBe(true);
    expect(launched.tasks.find((t) => t.id === RUNWAY)!.estimatedMinutes).toBe(240);
    expect(launched.undoSnapshots).toEqual([older]);
    expect(planInputsKey(launched, PROBE_TODAY)).toBe(key);
    expect(reducer(launched, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } }).scheduleBlocks).toEqual(launched.scheduleBlocks);

    // Undoing the older change brings 1.0.8's plan back once; the re-plan that follows cleans it up quietly again, and
    // then there is nothing left to undo and no input left to re-plan for.
    const undone = reducer(launched, { type: "UNDO_REPLAN", now: PROBE_NOW });
    expect(undone.undoSnapshots).toBeUndefined();
    const again = reducer(undone, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(live(again.scheduleBlocks, FINC_EXAM)).toEqual([]);
    expect(again.undoSnapshots).toBeUndefined();
    expect(planInputsKey(again, PROBE_TODAY)).toBe(planInputsKey(undone, PROBE_TODAY));
  });

  it("finishing the prep does not bring the exam's own sessions back; deleting the prep does", () => {
    const { state } = fincWithPrep();
    const linked = reducer(state, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    const finished = reducer(linked, { type: "COMPLETE_TASK", payload: RUNWAY, now: PROBE_NOW });
    const afterDone = reducer(finished, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(live(afterDone.scheduleBlocks, FINC_EXAM)).toEqual([]);
    expect(shortOf(afterDone, FINC_EXAM)).toBe(0); // its 405 finished minutes cover the exam's 240

    // Exam Prep's "Delete": the prep's study task and its sessions go, then the planner runs again.
    const deleted = [
      { type: "DELETE_TASK" as const, payload: RUNWAY },
      { type: "DELETE_EXAM_PREP" as const, payload: "prep-exam1" },
      { type: "AUTO_REPLAN" as const, payload: { now: PROBE_NOW } },
    ].reduce(reducer, linked);
    expect(live(deleted.scheduleBlocks, RUNWAY)).toEqual([]);
    const exam1 = deleted.tasks.find((t) => t.id === FINC_EXAM)!;
    expect(minutesOf(live(deleted.scheduleBlocks, FINC_EXAM)) + shortOf(deleted, FINC_EXAM)).toBe(remainingMinutes(exam1)); // its 240 min are back
  });

  it("a finished prep's minutes count toward its exam: an estimate raised afterwards gets the difference (1.0.9 audit: 0 planned, no alert)", () => {
    // A small prep (2 topics, 165 min) topped up to Exam 1's 240 min, all of it done; then Exam 1 is re-estimated at 6 h.
    const planned = reducer(fincState(), { type: "AUTO_BUILD_WEEK", payload: { now: PROBE_NOW } });
    const prep = withLinkedExam(examOnePrep(["Working Capital", "Forecasting"], "mostly_understood"), planned.tasks);
    const runway = buildExamRunway(prep, { todayKey: PROBE_TODAY, now: PROBE_NOW }).task!;
    let state = [{ type: "ADD_TASK" as const, payload: runway }, { type: "AUTO_REPLAN" as const, payload: { now: PROBE_NOW } }].reduce(reducer, { ...planned, examPreps: [prep] });
    expect(minutesOf(live(state.scheduleBlocks, RUNWAY)) + shortOf(state, RUNWAY)).toBe(240);
    for (const block of live(state.scheduleBlocks, RUNWAY)) state = reducer(state, { type: "COMPLETE_BLOCK", payload: block.id });
    expect(state.tasks.find((t) => t.id === RUNWAY)).toMatchObject({ status: "done", completedMinutes: 240 });
    state = reducer(state, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } });
    expect(live(state.scheduleBlocks, FINC_EXAM)).toEqual([]); // the prep covered it: nothing comes back
    const exam1 = state.tasks.find((t) => t.id === FINC_EXAM)!;
    const raised = [{ type: "UPDATE_TASK" as const, payload: { ...exam1, estimatedMinutes: 360 } }, { type: "AUTO_REPLAN" as const, payload: { now: PROBE_NOW } }].reduce(reducer, state);
    expect(minutesOf(live(raised.scheduleBlocks, FINC_EXAM)) + shortOf(raised, FINC_EXAM)).toBe(120); // was 0, with no alert
    expect(live(raised.scheduleBlocks, FINC_EXAM).length).toBeGreaterThan(0);
    expect(live(raised.scheduleBlocks, RUNWAY)).toEqual([]);
    // Stable: the next re-plan keeps it.
    expect(reducer(raised, { type: "AUTO_REPLAN", payload: { now: PROBE_NOW } }).scheduleBlocks).toEqual(raised.scheduleBlocks);
  });

  it("an exam that needs more than its prep keeps all of its time: mixed practice makes up the difference, and the preview says what it replaces", () => {
    const base = fincState();
    const planned = reducer(base, { type: "AUTO_BUILD_WEEK", payload: { now: PROBE_NOW } });
    const examOwn = live(planned.scheduleBlocks, FINC_EXAM);
    expect(examOwn.length).toBeGreaterThan(0);
    // One topic that is almost there: Review 30 + Quiz 30 + Final review 45 = 105 min, for an exam estimated at 240.
    const prep = withLinkedExam(examOnePrep(["Working Capital"], "mostly_understood"), planned.tasks);
    const plan = buildExamRunway(prep, { todayKey: PROBE_TODAY, now: PROBE_NOW });
    expect(plan.totalMinutes).toBe(105);
    const preview = previewRunway(plan, planned, PROBE_NOW)!;
    expect(preview.planned).toEqual({ sessions: 5, minutes: 240, mixedMinutes: 135 });
    expect(preview.exam).toEqual({ name: "Exam 1", minutes: 240, replacedSessions: examOwn.length, replacedMinutes: minutesOf(examOwn) });
    const message = runwayOutcomeMessage(plan, preview);
    expect(message.body).toContain("Trajectory will place 5 study sessions (4 h) for 1 topic");
    expect(message.body).toContain("including 2 h 15 min of mixed practice so Exam 1 keeps the 4 h its own estimate asks for");
    expect(message.body).toContain(`They replace the ${examOwn.length} sessions`);
    expect(message.body).toContain("already planned as flexible sessions for Exam 1, so its study time is not planned twice");
    expect(message.body).toContain("show up as flexible sessions you can keep or move.");

    // "Add to my plan" (ADD_TASK + AUTO_REPLAN): the exam's sessions are replaced, never added to.
    const added = [{ type: "ADD_TASK" as const, payload: plan.task! }, { type: "AUTO_REPLAN" as const, payload: { now: PROBE_NOW } }].reduce(reducer, { ...planned, examPreps: [prep] });
    expect(live(added.scheduleBlocks, FINC_EXAM)).toEqual([]);
    const sessions = live(added.scheduleBlocks, RUNWAY);
    expect(minutesOf(sessions) + shortOf(added, RUNWAY)).toBe(240);
    expect(sessions.some((b) => b.title.includes(MIXED_PRACTICE_LABEL))).toBe(true);
    expect(added.tasks.find((t) => t.id === RUNWAY)).toMatchObject({ estimatedMinutes: 240, examTaskId: FINC_EXAM });

    // Given the exam task, buildExamRunway sizes the plan itself, the same way every plan does.
    const exam1 = planned.tasks.find((t) => t.id === FINC_EXAM)!;
    const sized = buildExamRunway(prep, { todayKey: PROBE_TODAY, now: PROBE_NOW, examTask: exam1 });
    expect(sized.totalMinutes).toBe(240);
    expect(sized.sessions.filter((s) => s.label === MIXED_PRACTICE_LABEL).map((s) => s.minutes)).toEqual([70, 65]);
    expect(sizePrepsToExams([exam1, sized.task!], 90)[1]).toBe(sized.task);
  });

  it("two preps for one exam: only the newest plans, and the older one's suggestions go too", () => {
    const { state } = fincWithPrep();
    const older = { ...followExamDates(state.tasks).find((t) => t.id === RUNWAY)!, id: runwayTaskId("prep-old"), createdAt: "2026-09-01T00:00:00.000Z" };
    const both: AppState = { ...state, tasks: [...state.tasks, older], scheduleBlocks: state.scheduleBlocks.map((b) => (b.taskId === RUNWAY ? { ...b, accepted: false } : b)) };
    expect(examsPlannedByPrep(followExamDates(both.tasks))).toEqual(new Map([[FINC_EXAM, RUNWAY], [older.id, RUNWAY]]));
    const plan = buildSemesterPlan(both, { now: PROBE_NOW });
    expect(live(plan.scheduleBlocks, older.id)).toEqual([]);
    expect(live(plan.scheduleBlocks, FINC_EXAM)).toEqual([]);
    expect(minutesOf(live(plan.scheduleBlocks, RUNWAY)) + (plan.shortfalls.find((s) => s.taskId === RUNWAY)?.missingMinutes ?? 0)).toBe(405);
  });
});

describe("examsPlannedByPrep / withExamTopUp (pure)", () => {
  const exam = makeTask({ id: "mid", name: "Midterm", kind: "exam", courseId: "chem", dueDate: "2030-03-20", estimatedMinutes: 300 });
  const prepTask = buildExamRunway(prep({ examTaskId: "mid", topics: [{ id: "t1", title: "Stoichiometry", mastery: "mostly_understood", reviewCount: 0 }] }), { todayKey: TODAY, now: new Date(2030, 2, 13, 12, 0) }).task!;

  it("maps the exam (and older preps) to the newest prep; a prep whose exam is gone plans on its own", () => {
    expect(examsPlannedByPrep([exam, prepTask])).toEqual(new Map([["mid", prepTask.id]]));
    expect(examsPlannedByPrep([prepTask]).size).toBe(0);
    expect(examsPlannedByPrep([exam, { ...prepTask, examTaskId: undefined }]).size).toBe(0);
  });

  it("tops the prep up to the exam's remaining estimate, recomputed (never stacked), and leaves closed tasks alone", () => {
    expect(prepTask.estimatedMinutes).toBe(105);
    const sized = withExamTopUp(prepTask, exam, 90);
    expect(sized.estimatedMinutes).toBe(300);
    const mixed = sized.planningStrategy!.sessions.filter((s) => s.label === MIXED_PRACTICE_LABEL);
    expect(mixed.map((s) => s.minutes)).toEqual([65, 65, 65]);
    expect(mixed.every((s) => s.purpose === "practice" && s.targetDaysBeforeDue >= 1 && s.earliestDaysBeforeDue >= s.targetDaysBeforeDue)).toBe(true);
    expect(withExamTopUp(sized, exam, 90)).toBe(sized);
    expect(withExamTopUp(sized, { ...exam, completedMinutes: 150 }, 90).estimatedMinutes).toBe(150); // 45 of mixed practice
    expect(withExamTopUp(sized, { ...exam, estimatedMinutes: 60 }, 90).planningStrategy!.sessions).toEqual(prepTask.planningStrategy!.sessions);
    expect(withExamTopUp(sized, { ...exam, status: "done" }, 90).estimatedMinutes).toBe(105);
    expect(withExamTopUp(sized, exam, 45).planningStrategy!.sessions.filter((s) => s.label === MIXED_PRACTICE_LABEL).every((s) => s.minutes <= 45)).toBe(true);
    const finished = { ...prepTask, status: "done" as const };
    expect(withExamTopUp(finished, exam, 90)).toBe(finished);
    expect(withExamTopUp(prepTask, { ...exam, estimatedMinutes: 110 }, 90)).toBe(prepTask); // 5 minutes are not worth a session
  });
});

describe("study hub: imported exams are ready to prep and 'prepped' matches the plan", () => {
  it("syllabus items carry their kind and the sessions the plan already has (as Today counts them)", () => {
    const tasks = [
      makeTask({ id: "mid", name: "Midterm", kind: "exam", courseId: "chem", dueDate: "2030-03-25" }),
      makeTask({ id: "q8", name: "Quiz 8", kind: "quiz", courseId: "chem", dueDate: "2030-03-18" }),
    ];
    const blocks = [
      makeBlock({ taskId: "q8", date: "2030-03-16", startTime: "10:00", endTime: "10:30" }),
      makeBlock({ taskId: "q8", date: "2030-03-12", startTime: "10:00", endTime: "10:30" }), // past
      makeBlock({ taskId: "q8", date: "2030-03-17", startTime: "10:00", endTime: "10:30", completionStatus: "skipped" }),
    ];
    const hub = buildStudyHub({ examPreps: [], tasks, scheduleBlocks: blocks, studyGuides: [], practiceExams: [], syllabusImports: [] }, TODAY);
    expect(hub.syllabusExams.map((e) => [e.taskId, e.kind, e.planned.sessions, e.planned.minutes])).toEqual([
      ["q8", "quiz", 1, 30],
      ["mid", "exam", 0, 0],
    ]);
  });

  it("a prep linked to its exam covers it (even after the exam moved) and counts the exam's own sessions too", () => {
    const tasks = [makeTask({ id: "mid", name: "Midterm", kind: "exam", courseId: "chem", dueDate: "2030-03-18" })];
    const blocks = [
      makeBlock({ taskId: runwayTaskId("p1"), date: "2030-03-14", startTime: "10:00", endTime: "11:00" }),
      makeBlock({ taskId: "mid", date: "2030-03-15", startTime: "10:00", endTime: "10:45" }),
    ];
    const hub = buildStudyHub({ examPreps: [prep({ examTaskId: "mid" })], tasks, scheduleBlocks: blocks, studyGuides: [], practiceExams: [], syllabusImports: [] }, TODAY);
    expect(hub.syllabusExams).toEqual([]);
    expect(hub.upcoming[0]!.exam.examDate).toBe("2030-03-18");
    expect(hub.upcoming[0]!.runway).toMatchObject({ sessions: 2, minutes: 105 });
    expect(runwayScheduleSummary(blocks, "p1", TODAY)).toMatchObject({ sessions: 1, minutes: 60 });
  });
});
