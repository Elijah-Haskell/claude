import { describe, expect, it, vi } from "vitest";

import { reducer } from "../../src/engine/app-context";
import { findExamTask, runwayTaskId, withLinkedExam } from "../../src/engine/exam-prep-link";
import {
  blocksAfterPrepDelete,
  buildExamPrepList,
  EMPTY_PREP_FORM,
  newExamPrep,
  planDoneNote,
  planOfferNote,
  prepFormCheck,
  prepPrefill,
  studyTimeLine,
  topicCounts,
  topicReviewLine,
  withMaterial,
  type ExamMaterial,
} from "../../src/engine/exam-prep-view";
import { buildExamRunway, previewRunway, runwayScheduleSummary } from "../../src/engine/exam-runway";
import { sessionLengthFor } from "../../src/engine/intelligent-scheduler";
import { createInitialState } from "../../src/engine/state-persistence";
import type { AppState, MasteryLevel, Task } from "../../src/engine/types";

// The reducer lives next to the React provider; stub the native modules it imports. (vitest lifts these above the
// imports, so they are in place before lib/app-context loads.)
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

/**
 * What the Exam prep screens (app/exam-prep.tsx and components/study/exam-prep-*.tsx) do to the student's data, run
 * through the real reducer with the same pure steps the screens take: start a prep from an exam of the syllabus,
 * mark topics, get new material, plan its study time, delete it.
 */

const TODAY = "2030-01-08";
const NOW = new Date(2030, 0, 8, 9, 0);

const midterm: Task = {
  id: "t-mid",
  name: "Midterm",
  kind: "exam",
  courseId: "calc",
  courseName: "Calculus II",
  dueDate: "2030-01-18",
  dueTime: "10:00",
  estimatedMinutes: 120,
  difficulty: 3,
  requiresOnCampus: false,
  status: "pending",
  createdAt: "2030-01-01T12:00:00.000Z",
  coversTopics: ["Integration by parts", "Series", "Partial fractions"],
};

const start = (): AppState => ({
  ...createInitialState(),
  onboardingComplete: true,
  classes: [{ id: "calc", name: "Calculus II", days: ["Mon", "Wed"], startTime: "10:00", endTime: "10:50", color: "#8B5CF6" }],
  tasks: [midterm],
});

/** "Exams without one yet" -> tap the midterm -> "Build exam prep". */
function startPrep(state: AppState): { state: AppState; prepId: string } {
  const form = { ...EMPTY_PREP_FORM, ...prepPrefill({ taskId: "t-mid" }, state.tasks, state.classes) };
  expect(prepFormCheck(form, { todayKey: TODAY, linked: true })).toMatchObject({ canBuild: true, reason: null });
  let n = 0;
  const exam = newExamPrep(form, { classes: state.classes, tasks: state.tasks, id: () => `id-${(n += 1)}`, now: NOW });
  return { state: reducer(state, { type: "ADD_EXAM_PREP", payload: exam }), prepId: exam.id };
}

const prepOf = (state: AppState, id: string) => withLinkedExam(state.examPreps.find((exam) => exam.id === id)!, state.tasks);
const mark = (state: AppState, examId: string, topicId: string, mastery: MasteryLevel) => reducer(state, { type: "UPDATE_EXAM_TOPIC_MASTERY", payload: { examId, topicId, mastery } });

describe("starting an exam prep from an exam of the syllabus", () => {
  it("moves the exam from 'Exams without one yet' to 'Your exam preps', with the syllabus's topics", () => {
    const before = buildExamPrepList(start(), TODAY);
    expect(before.exams.map((row) => row.taskId)).toEqual(["t-mid"]);
    expect(before.preps).toEqual([]);

    const { state, prepId } = startPrep(start());
    const after = buildExamPrepList(state, TODAY);
    expect(after.exams).toEqual([]);
    expect(after.preps).toHaveLength(1);
    expect(after.preps[0]).toMatchObject({ id: prepId, name: "Midterm", courseName: "Calculus II", classId: "calc", when: "Fri, Jan 18 at 10:00 AM", badge: { label: "10 days", tone: "neutral" } });
    expect(after.preps[0]!.counts.line).toBe("0 of 3 topics mastered");
    expect(state.examPreps[0]).toMatchObject({ examTaskId: "t-mid", className: "Calculus II", subject: "Midterm", examDate: "2030-01-18", examTime: "10:00" });
    expect(state.examPreps[0]!.topics.map((topic) => topic.title)).toEqual(["Integration by parts", "Series", "Partial fractions"]);
  });

  it("follows the exam when its date moves", () => {
    const { state, prepId } = startPrep(start());
    const moved = reducer(state, { type: "UPDATE_TASK", payload: { ...midterm, dueDate: "2030-01-21" } });
    expect(prepOf(moved, prepId).examDate).toBe("2030-01-21");
    expect(buildExamPrepList(moved, TODAY).preps[0]).toMatchObject({ when: "Mon, Jan 21 at 10:00 AM", badge: { label: "13 days" } });
  });
});

describe("marking how well a topic is known", () => {
  it("each answer is one review, and the progress card counts it", () => {
    let { state, prepId } = startPrep(start());
    const [first, second, third] = state.examPreps[0]!.topics.map((topic) => topic.id) as [string, string, string];
    expect(topicCounts(prepOf(state, prepId).topics)).toMatchObject({ line: "0 of 3 topics mastered", reviewLine: "3 need review", fraction: 0 });
    expect(topicReviewLine(prepOf(state, prepId).topics[0]!)).toBe("Not reviewed yet");

    state = mark(state, prepId, first, "mastered");
    state = mark(state, prepId, second, "mostly_understood");
    expect(topicCounts(prepOf(state, prepId).topics)).toMatchObject({ line: "1 of 3 topics mastered", reviewLine: "1 needs review" });

    // The same answer again is a second review of that topic, as it always was.
    state = mark(state, prepId, first, "mastered");
    const topic = prepOf(state, prepId).topics[0]!;
    expect(topic.reviewCount).toBe(2);
    expect(topicReviewLine(topic)).toMatch(/^Reviewed 2 times · last \w{3} \d{1,2}$/);

    state = mark(state, prepId, third, "mastered");
    state = mark(state, prepId, second, "mastered");
    expect(topicCounts(prepOf(state, prepId).topics)).toMatchObject({ line: "3 of 3 topics mastered", reviewLine: "", fraction: 1 });
    // Another prep's topics are never touched.
    expect(mark(state, "someone-else", first, "needs_review").examPreps).toEqual(state.examPreps);
  });

  it("is kept when the material is written, and when it is made again", () => {
    let { state, prepId } = startPrep(start());
    const [first] = state.examPreps[0]!.topics.map((topic) => topic.id) as [string];
    state = mark(state, prepId, first, "mastered");

    const material: ExamMaterial = {
      keyConcepts: ["u-substitution"],
      bigPictureSummary: "Techniques of integration.",
      topicExpansions: [{ title: "Integration by parts", explanation: "Reverses the product rule.", keyPoints: ["Choose u and dv"], commonMistakes: "Dropping the minus sign." }],
      importantDefinitions: [],
      practiceQuestions: [{ question: "Which u?", answer: "u = x" }],
      flashcards: [{ front: "LIATE", back: "An order for choosing u" }],
      inputTruncated: false,
    };
    state = reducer(state, { type: "UPDATE_EXAM_PREP", payload: withMaterial(prepOf(state, prepId), material, NOW) });
    expect(prepOf(state, prepId).topics[0]).toMatchObject({ mastery: "mastered", reviewCount: 1, description: "Reverses the product rule." });
    expect(prepOf(state, prepId).studyGuide).toMatchObject({ aiGenerated: true, flashcards: [{ front: "LIATE" }] });

    // "Make the material again": the student's own marks and the description they already read stay.
    state = mark(state, prepId, first, "mostly_understood");
    const again = { ...material, topicExpansions: [{ ...material.topicExpansions[0]!, explanation: "A different wording." }], flashcards: [] };
    state = reducer(state, { type: "UPDATE_EXAM_PREP", payload: withMaterial(prepOf(state, prepId), again, NOW) });
    expect(prepOf(state, prepId).topics[0]).toMatchObject({ mastery: "mostly_understood", reviewCount: 2, description: "Reverses the product rule." });
    expect(prepOf(state, prepId).studyGuide?.flashcards).toEqual([]);
  });
});

describe("planning its study time", () => {
  /** "Plan study time": the dry run, then what "Add to my plan" dispatches. */
  function offer(state: AppState, prepId: string) {
    const exam = prepOf(state, prepId);
    const existing = state.tasks.find((task) => task.id === runwayTaskId(prepId));
    const runway = buildExamRunway(exam, { todayKey: TODAY, now: NOW, existing, examTask: findExamTask(exam, state.tasks), maxSessionMinutes: sessionLengthFor(state.userPrefs) });
    const replanning = Boolean(existing && existing.status !== "done");
    return { runway, existing, replanning, note: planOfferNote(runway, previewRunway(runway, state, NOW), replanning) };
  }
  function accept(state: AppState, step: ReturnType<typeof offer>): AppState {
    const added = reducer(state, { type: step.existing ? "UPDATE_TASK" : "ADD_TASK", payload: step.runway.task! });
    return reducer(added, { type: "AUTO_REPLAN", payload: { now: NOW } });
  }
  const line = (state: AppState, prepId: string) => {
    const exam = prepOf(state, prepId);
    const hasPlan = state.tasks.some((task) => task.id === runwayTaskId(prepId) && task.status !== "done");
    return { summary: runwayScheduleSummary(state.scheduleBlocks, prepId, TODAY, exam.examTaskId), ...studyTimeLine(runwayScheduleSummary(state.scheduleBlocks, prepId, TODAY, exam.examTaskId), { hasPlan, past: false }) };
  };

  it("nothing changes until the offer is accepted; then the sessions are on the calendar and the link is a replan", () => {
    const { state, prepId } = startPrep(start());
    expect(line(state, prepId)).toMatchObject({ text: "No study time planned yet", link: "Plan study time" });

    const first = offer(state, prepId);
    expect(first.replanning).toBe(false);
    expect(first.note).toMatchObject({ tone: "blue", title: "", confirm: "Add to my plan", dismiss: "Cancel" });
    expect(first.note.body).toMatch(/^Trajectory will place \d+ study sessions \(.+\) for 3 topics around your classes, commitments and sleep window/);
    // The dry run dispatched nothing.
    expect(state.tasks.map((task) => task.id)).toEqual(["t-mid"]);
    expect(state.scheduleBlocks).toEqual([]);

    const planned = accept(state, first);
    expect(planDoneNote(first.replanning).title).toBe("Exam plan added");
    const after = line(planned, prepId);
    expect(after.summary.sessions).toBeGreaterThan(0);
    expect(after.text).toMatch(new RegExp(`^${after.summary.sessions} sessions? planned · \\d`));
    expect(after.link).toBe("Replan them");
    // Every session is a study session before the exam's day and time.
    const mine = planned.scheduleBlocks.filter((block) => block.taskId === runwayTaskId(prepId));
    expect(mine.length).toBe(after.summary.sessions);
    expect(mine.every((block) => block.type === "study" && block.date <= "2030-01-18" && block.date >= TODAY)).toBe(true);

    // Asking again is a replan, and says so before it does anything.
    const second = offer(planned, prepId);
    expect(second.replanning).toBe(true);
    expect(second.note).toMatchObject({ title: "Replan this exam's study time?", confirm: "Replan", dismiss: "Cancel" });
    expect(planDoneNote(second.replanning).title).toBe("Plan updated");
  });

  it("a prep with every topic mastered has nothing to schedule, and says why", () => {
    let { state, prepId } = startPrep(start());
    for (const topic of state.examPreps[0]!.topics) state = mark(state, prepId, topic.id, "mastered");
    expect(offer(state, prepId).note).toEqual({ tone: "blue", title: "Nothing to schedule", body: "Every topic is marked mastered, so there is nothing left to schedule.", confirm: null, dismiss: "Close" });
  });

  it("deleting the prep takes its plan with it, keeps finished sessions, and the exam is offered again", () => {
    const { state, prepId } = startPrep(start());
    let planned = accept(state, offer(state, prepId));
    const mine = planned.scheduleBlocks.filter((block) => block.taskId === runwayTaskId(prepId));
    expect(mine.length).toBeGreaterThan(1);
    planned = reducer(planned, { type: "COMPLETE_BLOCK", payload: mine[0]!.id });

    // What "Delete" dispatches, in the screen's order.
    const runwayId = runwayTaskId(prepId);
    let gone = planned;
    if (gone.tasks.some((task) => task.id === runwayId)) gone = reducer(gone, { type: "DELETE_TASK", payload: runwayId });
    gone = reducer(gone, { type: "SET_SCHEDULE_BLOCKS", payload: blocksAfterPrepDelete(gone.scheduleBlocks, prepId) });
    gone = reducer(gone, { type: "DELETE_EXAM_PREP", payload: prepId });

    expect(gone.examPreps).toEqual([]);
    expect(gone.tasks.some((task) => task.id === runwayId)).toBe(false);
    const left = gone.scheduleBlocks.filter((block) => block.taskId === runwayId);
    expect(left.map((block) => block.id)).toEqual([mine[0]!.id]);
    expect(left[0]!.completionStatus).toBe("done");
    // The exam itself stays, and is back under "Exams without one yet".
    const list = buildExamPrepList(gone, TODAY);
    expect(list.preps).toEqual([]);
    expect(list.exams.map((row) => row.taskId)).toEqual(["t-mid"]);
  });
});
