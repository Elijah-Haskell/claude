// The mobile app's tests/study-tools-view.test.ts, for the web: the pure words of the study tools (src/engine/study-tools-view.ts,
// the same file as the iPhone's lib/study-tools-view.ts) and the rules the web screens keep (the last two blocks).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scoreExam, type QuestionResponse } from "../../src/engine/practice-exam-scoring";
import { buildPracticeList } from "../../src/engine/study-hub";
import { MAX_REVIEW_IMAGES } from "../../src/engine/study-images";
import { listStudySources, type StudySource } from "../../src/engine/study-source";
import {
  chosenSourceId,
  classByName,
  DIFFICULTY_LABEL,
  examResultView,
  EXTRA_PAGES_NOTICE,
  feedbackHeadline,
  GRADED_ONLY_NOTE,
  GUIDE_DELETE_COPY,
  GUIDE_SHEET_COPY,
  guideBuildBlocker,
  guideClass,
  guideMetaLine,
  guidePracticeAction,
  guideRowLine,
  guideRows,
  importanceCounts,
  importanceOptions,
  importanceTag,
  mistakeTitle,
  NO_MISTAKES_BODY,
  noSyllabusCopy,
  NOT_SCORED_COPY,
  notReviewedTitle,
  pageOptionLines,
  pagesCountLabel,
  pastedCountLine,
  pickedAnswerText,
  PRACTICE_EMPTY,
  PRACTICE_EXAM_QUESTIONS,
  PRACTICE_HEAD,
  practiceFocusTopics,
  practiceQuestionExcerpt,
  practiceRowLine,
  questionCounter,
  questionCountLine,
  questionMetaLine,
  questionStep,
  REVIEW_QUESTION_EXAMPLE,
  REVIEW_QUESTION_MAX,
  REVIEW_RESET_COPY,
  reviewClassValue,
  reviewCourseLabel,
  reviewDetail,
  reviewExcerpt,
  reviewHeadline,
  reviewQuestionDetail,
  reviewScoreLine,
  reviewStep,
  reviewTitle,
  rightAnswerName,
  rightAnswerText,
  selfMarkLine,
  SHORT_ANSWER_COPY,
  shortDay,
  shownLetter,
  soleSourceId,
  sourceRows,
  statusTag,
  STUDY_GUIDES_EMPTY,
  STUDY_GUIDES_HEAD,
  TEST_REVIEW_HEAD,
  topicsFor,
  type TestReviewResult,
} from "../../src/engine/study-tools-view";
import type { ExamPrep, PracticeQuestion, SyllabusPracticeExam, SyllabusStudyGuide, SyllabusTopic } from "../../src/engine/types";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");

/** A saved time as the screens show it, in whatever time zone the tests run in. */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const topic = (title: string, importance: SyllabusTopic["importance"], week?: string): SyllabusTopic => ({ title, importance, week, description: `About ${title}.`, keyTerms: ["one", "two"] });

const guide = (over: Partial<SyllabusStudyGuide> & Pick<SyllabusStudyGuide, "id">): SyllabusStudyGuide => ({
  courseTitle: "Calculus II",
  overview: "Integration techniques and series.",
  topics: [topic("Integration by parts", "high", "Week 5"), topic("Partial fractions", "medium", "Week 7")],
  studyTips: ["Work the problems before reading the answers."],
  createdAt: "2026-09-28T12:00:00.000Z",
  ...over,
});

const mc = (over: Partial<PracticeQuestion> = {}): PracticeQuestion => ({
  type: "multiple_choice",
  question: "Which choice of u makes the integral simplest?",
  options: ["u = e^x", "u = x", "u = x e^x", "u = 1"],
  answerIndex: 1,
  answer: "u = x",
  explanation: "With u = x, du is just dx.",
  topic: "Integration by parts",
  difficulty: "medium",
  ...over,
});
const tf = (answer: string, over: Partial<PracticeQuestion> = {}): PracticeQuestion => ({ type: "true_false", question: "The integral of 1/x is ln|x| + C.", answer, explanation: "By definition.", topic: "Logarithms", difficulty: "easy", ...over });
const short = (over: Partial<PracticeQuestion> = {}): PracticeQuestion => ({ type: "short_answer", question: "State the formula for integration by parts.", answer: "The integral of u dv is uv minus the integral of v du.", explanation: "It reverses the product rule.", topic: "Integration by parts", difficulty: "hard", ...over });

describe("dates and names", () => {
  it("says a day as 'Sep 28', from a saved time or a date key, and nothing for what cannot be read", () => {
    expect(shortDay("2026-10-13")).toBe("Oct 13");
    expect(shortDay("2026-09-28T12:00:00.000Z")).toBe(day("2026-09-28T12:00:00.000Z"));
    expect(shortDay("soon")).toBe("");
    expect(shortDay("")).toBe("");
    expect(shortDay(undefined)).toBe("");
  });

  it("finds a class by its name, whatever the capitals or the spaces around it", () => {
    const classes = [{ id: "c1", name: "Calculus II" }, { id: "c2", name: "Organic Chemistry" }];
    expect(classByName(" calculus ii ", classes)?.id).toBe("c1");
    expect(classByName("Calculus", classes)).toBeUndefined();
    expect(classByName("", classes)).toBeUndefined();
    expect(classByName(undefined, classes)).toBeUndefined();
  });
});

describe("the list of study guides", () => {
  it("says what the page is, in the approved words", () => {
    expect(STUDY_GUIDES_HEAD).toEqual({ eyebrow: "Study tools", title: "Study guide", sub: "Topics and key terms, made from a syllabus or from notes you paste." });
    expect(STUDY_GUIDES_EMPTY.title).toBe("No study guides yet");
  });

  it("a guide's line: its topics, its practice exam, when it was made, and whether the syllabus was cut short", () => {
    const made = day("2026-09-28T12:00:00.000Z");
    const twelve = guide({ id: "g", topics: Array.from({ length: 12 }, (_, i) => topic(`T${i}`, "low")) });
    expect(guideRowLine(twelve, true)).toBe(`12 topics · practice exam · ${made}`);
    expect(guideRowLine(twelve, false)).toBe(`12 topics · ${made}`);
    expect(guideRowLine(guide({ id: "g", topics: [topic("Only", "high")], sourceTruncated: true }), false)).toBe(`1 topic · ${made} · partial syllabus`);
    // A guide saved with a time that cannot be read still has a line, without a date.
    expect(guideRowLine(guide({ id: "g", createdAt: "" }), false)).toBe("2 topics");
    expect(guideRowLine({ topics: undefined as never, createdAt: "", sourceTruncated: false }, false)).toBe("0 topics");
  });

  it("lists every saved guide newest first, each knowing whether it has a practice exam", () => {
    const guides = [guide({ id: "old", createdAt: "2026-09-01T12:00:00.000Z" }), guide({ id: "new", courseTitle: "Organic Chemistry", createdAt: "2026-09-30T12:00:00.000Z" }), null as never];
    const rows = guideRows(guides, [{ studyGuideId: "old" }]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({ title: "Organic Chemistry", hasPracticeExam: false, line: `2 topics · ${day("2026-09-30T12:00:00.000Z")}` });
    expect(rows[1]).toMatchObject({ hasPracticeExam: true, line: `2 topics · practice exam · ${day("2026-09-01T12:00:00.000Z")}` });
    expect(guideRows(undefined, undefined)).toEqual([]);
  });
});

describe("the sheet that builds a study guide", () => {
  const TEXT = "Week 1: limits. Week 2: derivatives. Week 3: integrals and what they are used for.";
  const imports = [
    { id: "calc", importedAt: "2026-08-23T12:00:00.000Z", linkedClassName: "Calculus II", rawText: TEXT },
    { id: "writ", importedAt: "2026-08-25T12:00:00.000Z", linkedClassName: "Academic Writing", extractedItems: [{ name: "Essay 1", type: "assignment", dueDate: "2026-09-20" }] },
    { id: "finc", importedAt: "2026-08-22T12:00:00.000Z", linkedClassName: "Principles of Finance", rawText: TEXT },
    { id: "art", importedAt: "2026-08-21T12:00:00.000Z", linkedClassName: "Art History" },
  ];
  const sources = listStudySources(imports);
  // Newest first: the guide offered for a syllabus is the newest one made from it.
  const guides = [{ id: "g-new", sourceImportId: "finc" }, { id: "g-old", sourceImportId: "finc" }];
  const rows = sourceRows(sources, guides);

  it("offers each imported syllabus with one true line under its name", () => {
    expect(rows.map((row) => row.id)).toEqual(["writ", "calc", "finc", "art"]);
    expect(rows.map((row) => row.title)).toEqual(["Academic Writing", "Calculus II", "Principles of Finance", "Art History"]);
    expect(rows.map((row) => row.line)).toEqual([
      `Added ${day("2026-08-25T12:00:00.000Z")} · deadline list only`,
      `Added ${day("2026-08-23T12:00:00.000Z")}`,
      "You already have a study guide for it",
      `Added ${day("2026-08-21T12:00:00.000Z")} · nothing to build from`,
    ]);
    expect(rows.map((row) => row.selectable)).toEqual([true, true, true, false]);
    expect(rows.map((row) => row.existingGuideId)).toEqual([null, null, "g-new", null]);
  });

  it("still says something true about an import whose date cannot be read", () => {
    const undated = (kind: StudySource["kind"]): StudySource => ({ id: kind, title: "Old import", importedAt: "", kind, chars: 0, itemCount: 0 });
    expect(sourceRows([undated("syllabus_text"), undated("deadlines_only"), undated("none")], []).map((row) => row.line)).toEqual(["Full syllabus text", "Deadline list only", "Nothing to build from"]);
  });

  it("chooses nothing for the student unless there is only one syllabus to choose", () => {
    expect(soleSourceId(rows)).toBeNull();
    const one = rows.filter((row) => row.id === "finc" || row.id === "art");
    expect(soleSourceId(one)).toBe("finc");
    expect(soleSourceId(rows.filter((row) => row.id === "art"))).toBeNull();
    expect(soleSourceId([])).toBeNull();

    expect(chosenSourceId(rows, null)).toBeNull();
    expect(chosenSourceId(rows, "calc")).toBe("calc");
    // A syllabus that cannot be built from, or one that is gone, is not a choice.
    expect(chosenSourceId(rows, "art")).toBeNull();
    expect(chosenSourceId(rows, "gone")).toBeNull();
    expect(chosenSourceId(one, null)).toBe("finc");
    expect(chosenSourceId(one, "gone")).toBe("finc");
  });

  it("says over the button what is still missing, and nothing once it can build", () => {
    expect(guideBuildBlocker({ mode: "imported", sourceChosen: false, pastedChars: 5000, pastedUsable: true })).toBe("Choose a syllabus");
    expect(guideBuildBlocker({ mode: "imported", sourceChosen: true, pastedChars: 0, pastedUsable: false })).toBeNull();
    expect(guideBuildBlocker({ mode: "paste", sourceChosen: true, pastedChars: 0, pastedUsable: false })).toBe("Paste the text first");
    expect(guideBuildBlocker({ mode: "paste", sourceChosen: false, pastedChars: 12, pastedUsable: false })).toBe("Paste a little more text so there is something to build from.");
    expect(guideBuildBlocker({ mode: "paste", sourceChosen: false, pastedChars: 400, pastedUsable: true })).toBeNull();
  });

  it("counts what was pasted, and explains an empty list of syllabi as the app always has", () => {
    expect(pastedCountLine(0)).toBe("0 characters");
    expect(pastedCountLine(1)).toBe("1 character");
    expect(pastedCountLine(12345)).toBe("12,345 characters");
    expect(noSyllabusCopy(0)).toEqual({ title: "No syllabus imported yet", body: "Upload your syllabus once and Trajectory plans your semester. It can also build study materials from it." });
    expect(noSyllabusCopy(2)).toEqual({ title: "Your imported syllabus has no text to study from", body: "Import it again to keep its text, or paste the text below." });
  });

  it("keeps the words of the wait and of the sheet", () => {
    expect(GUIDE_SHEET_COPY).toMatchObject({
      title: "New study guide",
      fromSyllabus: "From a syllabus",
      paste: "Paste text",
      which: "Which syllabus?",
      courseName: "Course name · optional",
      build: "Build study guide",
      building: "Reading your syllabus",
      wait: "This usually takes 15-30 seconds.",
      upload: "Upload your syllabus",
    });
    expect(GUIDE_SHEET_COPY.existing).toMatch(/^You already have a study guide from this syllabus\./);
  });
});

describe("the practice list", () => {
  it("says what the page is and what to do when it is empty", () => {
    expect(PRACTICE_HEAD).toEqual({ eyebrow: "Study tools", title: "Practice exam", sub: "Built from a study guide, to test yourself first." });
    expect(PRACTICE_EMPTY).toMatchObject({ title: "No practice yet", action: "Build a study guide" });
  });

  it("a row says what it is, how long it is and, for an exam's quiz, when the exam is", () => {
    const practiceExams: SyllabusPracticeExam[] = [
      { id: "pe1", studyGuideId: "g1", courseTitle: "Calculus II", totalQuestions: 15, estimatedMinutes: 20, questions: Array.from({ length: 15 }, () => mc()), createdAt: "2026-09-29T12:00:00.000Z" },
      { id: "pe2", studyGuideId: "g2", courseTitle: "Organic Chemistry", totalQuestions: 1, estimatedMinutes: 0, questions: [mc()], createdAt: "2026-09-20T12:00:00.000Z" },
    ];
    const examPreps = [
      {
        id: "p1",
        classId: "finc",
        className: "Principles of Finance",
        subject: "Exam 1",
        examDate: "2026-10-03",
        topics: [],
        rawInput: "",
        studyBlockIds: [],
        finalReviewGenerated: false,
        createdAt: "2026-09-01T12:00:00.000Z",
        studyGuide: { keyConcepts: [], importantDefinitions: [], flashcards: [], practiceQuestions: Array.from({ length: 12 }, (_, i) => ({ question: `Q${i}`, answer: "A" })) },
      },
    ] satisfies ExamPrep[];
    const entries = buildPracticeList({ practiceExams, examPreps });
    expect(entries.map((entry) => entry.title)).toEqual(["Calculus II", "Organic Chemistry", "Principles of Finance · Exam 1"]);
    expect(entries.map(practiceRowLine)).toEqual(["Practice exam · 15 questions · ~20 min", "Practice exam · 1 question", "Exam quiz · 12 questions · exam Oct 3"]);
    // A date that cannot be read is shown as stored, never as "Invalid Date".
    expect(practiceRowLine({ kind: "exam_quiz", key: "k", examId: "p", title: "T", questionCount: 2, examDate: "soon" })).toBe("Exam quiz · 2 questions · exam soon");
  });
});

describe("one study guide", () => {
  const topics = [topic("Integration by parts", "high", "Week 5"), topic("Trig substitution", "high", "Week 6"), topic("Partial fractions", "medium", "Week 7"), topic("Improper integrals", "low", "Week 8")];

  it("counts the topics by how much they matter, as the switch over them", () => {
    expect(importanceCounts(topics)).toEqual({ all: 4, high: 2, medium: 1, low: 1 });
    expect(importanceOptions(topics).map((option) => option.label)).toEqual(["All 4", "High 2", "Medium 1", "Low 1"]);
    expect(importanceOptions(topics).map((option) => option.value)).toEqual(["all", "high", "medium", "low"]);
    expect(importanceOptions(topics)[1]!.accessibilityLabel).toBe("High importance, 2 topics");
    expect(importanceOptions([]).map((option) => option.label)).toEqual(["All 0", "High 0", "Medium 0", "Low 0"]);
  });

  it("shows the topics of the chosen importance, each keeping its place in the whole guide", () => {
    expect(topicsFor(topics, "all").map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(topicsFor(topics, "medium")).toEqual([{ topic: topics[2], index: 2 }]);
    expect(topicsFor(topics, "low").map((entry) => entry.index)).toEqual([3]);
    expect(topicsFor([], "high")).toEqual([]);
  });

  it("makes High the one tag that stands out", () => {
    expect(importanceTag("high")).toEqual({ label: "High", strong: true });
    expect(importanceTag("medium")).toEqual({ label: "Medium", strong: false });
    expect(importanceTag("low")).toEqual({ label: "Low", strong: false });
  });

  it("says in one quiet line what the guide was built from and the exam date found in it", () => {
    expect(guideMetaLine({ sourceKind: "syllabus_text", examDate: "2026-10-13" })).toBe("Built from your imported syllabus. Exam in it on Oct 13.");
    expect(guideMetaLine({ sourceKind: "pasted_text" })).toBe("Built from text you pasted.");
    expect(guideMetaLine({ sourceKind: "deadlines_only" })).toBe("Built from your syllabus deadline list only (the full text wasn't available).");
    // A guide saved by an older version knows only its exam date, or nothing.
    expect(guideMetaLine({ examDate: "2026-10-13" })).toBe("Exam in the syllabus on Oct 13.");
    expect(guideMetaLine({ examDate: "mid October" })).toBe("Exam in the syllabus on mid October.");
    expect(guideMetaLine({})).toBe("");
  });

  it("knows the guide's class through its syllabus, else by its name, else not at all", () => {
    const classes = [{ id: "c-calc", name: "Calculus II" }, { id: "c-chem", name: "Organic Chemistry" }];
    const imports = [{ id: "i1", linkedClassId: "c-chem" }];
    // The class the syllabus was imported into wins over whatever the guide is titled.
    expect(guideClass({ sourceImportId: "i1", courseTitle: "CHEM 241 Fall" }, classes, imports)?.id).toBe("c-chem");
    expect(guideClass({ courseName: "calculus ii", courseTitle: "MATH 201" }, classes, imports)?.id).toBe("c-calc");
    expect(guideClass({ courseTitle: "Organic Chemistry" }, classes, undefined)?.id).toBe("c-chem");
    expect(guideClass({ sourceImportId: "gone", courseTitle: "Art History" }, classes, imports)).toBeUndefined();
  });

  it("asks a new practice exam for 15 questions on the high-importance topics", () => {
    expect(PRACTICE_EXAM_QUESTIONS).toBe(15);
    expect(practiceFocusTopics(topics)).toEqual(["Integration by parts", "Trig substitution"]);
    expect(practiceFocusTopics(Array.from({ length: 30 }, (_, i) => topic(`T${i}`, "high")))).toHaveLength(20);
    expect(practiceFocusTopics([topic("Only low", "low")])).toEqual([]);
  });

  it("the button takes the practice exam, or makes one and says so while it is written", () => {
    expect(guidePracticeAction(true, false)).toEqual({ label: "Take the practice exam", wait: null });
    expect(guidePracticeAction(false, false)).toEqual({ label: "Make a practice exam", wait: null });
    expect(guidePracticeAction(false, true)).toEqual({ label: "Make a practice exam", wait: "Writing a practice exam from this guide's topics." });
  });

  it("deleting says what goes with the guide", () => {
    expect(GUIDE_DELETE_COPY.row).toBe("Delete this study guide");
    expect(GUIDE_DELETE_COPY.question).toBe("Delete this study guide? This will also delete any practice exams for this guide.");
  });
});

describe("a practice exam question", () => {
  it("says where the student is and what kind of question this is", () => {
    expect(questionCounter(2, 15)).toBe("Question 3 of 15");
    expect(questionMetaLine(mc())).toBe("Multiple choice · Integration by parts");
    expect(questionMetaLine(tf("True", { topic: "  " }))).toBe("True or false");
    expect(questionMetaLine(short())).toBe("Short answer · Integration by parts");
    expect(DIFFICULTY_LABEL).toEqual({ easy: "Easy", medium: "Medium", hard: "Hard" });
  });

  it("the main button: Submit a choice, then move on, and say why when it cannot be pressed", () => {
    const base = { type: "multiple_choice", gradable: true, submitted: false, hasChoice: false, isLast: false } as const;
    expect(questionStep(base)).toEqual({ action: "submit", label: "Submit", enabled: false, reason: "Choose an answer" });
    expect(questionStep({ ...base, hasChoice: true })).toEqual({ action: "submit", label: "Submit", enabled: true, reason: null });
    expect(questionStep({ ...base, hasChoice: true, submitted: true })).toEqual({ action: "next", label: "Next question", enabled: true, reason: null });
    expect(questionStep({ ...base, hasChoice: true, submitted: true, isLast: true })).toEqual({ action: "next", label: "See results", enabled: true, reason: null });
    expect(questionStep({ ...base, type: "true_false" })).toMatchObject({ action: "submit", enabled: false, reason: "Choose an answer" });
  });

  it("a short answer is marked by the student before moving on", () => {
    const base = { type: "short_answer", gradable: true, submitted: false, hasChoice: false, isLast: false } as const;
    expect(questionStep(base)).toEqual({ action: "next", label: "Next question", enabled: false, reason: "Mark yourself to continue" });
    expect(questionStep({ ...base, isLast: true })).toEqual({ action: "next", label: "See results", enabled: false, reason: "Mark yourself to continue" });
    expect(questionStep({ ...base, submitted: true })).toEqual({ action: "next", label: "Next question", enabled: true, reason: null });
    expect(SHORT_ANSWER_COPY).toMatchObject({ show: "Show the model answer", gotIt: "I got it", missed: "I missed it" });
    expect(selfMarkLine("got_it")).toBe("You marked this: got it");
    expect(selfMarkLine("missed")).toBe("You marked this: missed it");
    expect(selfMarkLine(undefined)).toBe("");
  });

  it("a question with no usable answer key is passed over, never blocked", () => {
    expect(questionStep({ type: "multiple_choice", gradable: false, submitted: false, hasChoice: false, isLast: false })).toEqual({ action: "next", label: "Next question", enabled: true, reason: null });
    expect(questionStep({ type: "true_false", gradable: false, submitted: false, hasChoice: true, isLast: true })).toEqual({ action: "next", label: "See results", enabled: true, reason: null });
    expect(NOT_SCORED_COPY).toEqual({ title: "Not scored", body: "This question has no usable answer key, so it won't count toward your score." });
  });

  it("names the right answer by the letter the student saw, also after the options were reshuffled", () => {
    const question = mc();
    expect(shownLetter([0, 1, 2, 3], 1)).toBe("B");
    expect(shownLetter([1, 3, 0, 2], 1)).toBe("A");
    expect(shownLetter([1, 3, 0, 2], 2)).toBe("D");
    expect(shownLetter([0, 1], 3)).toBe("");
    expect(feedbackHeadline(question, true, [0, 1, 2, 3])).toBe("Correct");
    expect(feedbackHeadline(question, false, [0, 1, 2, 3])).toBe("Incorrect · the answer is B");
    expect(feedbackHeadline(question, false, [1, 3, 0, 2])).toBe("Incorrect · the answer is A");
    // An exam saved before answerIndex existed carries a letter: it still points at the right row.
    expect(feedbackHeadline(mc({ answerIndex: undefined, answer: "C" }), false, [0, 1, 2, 3])).toBe("Incorrect · the answer is C");
    expect(feedbackHeadline(tf("False"), false, [])).toBe("Incorrect · the answer is False");
    expect(rightAnswerName(tf("true"), [])).toBe("True");
    // No key, no claim about what the answer is.
    expect(rightAnswerName(mc({ answerIndex: undefined, answer: "" }), [0, 1, 2, 3])).toBe("");
    expect(feedbackHeadline(mc({ answerIndex: undefined, answer: "" }), false, [0, 1, 2, 3])).toBe("Incorrect");
  });

  it("writes a question out in full for an AI content report", () => {
    expect(practiceQuestionExcerpt(mc())).toBe(["Which choice of u makes the integral simplest?", "A) u = e^x", "B) u = x", "C) u = x e^x", "D) u = 1", "Answer: u = x", "With u = x, du is just dx."].join("\n"));
    expect(practiceQuestionExcerpt(tf("true"))).toContain("Answer: True");
    expect(practiceQuestionExcerpt(short())).toContain("Answer: The integral of u dv is uv minus the integral of v du.");
  });
});

describe("a practice exam's result", () => {
  // Eleven the app grades (nine right, two wrong) and four short answers (two "got it", two "missed").
  const questions: PracticeQuestion[] = [...Array.from({ length: 10 }, () => mc()), tf("True"), ...Array.from({ length: 4 }, () => short())];
  const responses: Record<number, QuestionResponse> = {};
  for (let i = 0; i < 10; i++) responses[i] = { selectedIndex: i < 8 ? 1 : 0 };
  responses[10] = { selectedBoolean: true };
  for (let i = 11; i < 15; i++) responses[i] = { selfRating: i < 13 ? "got_it" : "missed" };

  it("leads with the count, then the percentage and letter, then where the points went", () => {
    const view = examResultView(scoreExam(questions, responses));
    expect(view.headline).toBe("11 of 15 correct");
    expect(view.sub).toBe("73% of the scored questions · C");
    expect(view.fraction).toBeCloseTo(0.73);
    expect(view.rows).toEqual([
      { title: "Multiple choice and true or false", value: "9 of 11" },
      { title: "Short answer, marked by you", value: "2 of 4" },
      { title: "Not answered", value: "0" },
    ]);
    expect(view.notScored).toBeNull();
  });

  it("keeps today's letter thresholds", () => {
    const letterFor = (right: number) => examResultView(scoreExam(Array.from({ length: 10 }, () => mc()), Array.from({ length: 10 }, (_, i) => ({ selectedIndex: i < right ? 1 : 0 })))).sub;
    expect([10, 9, 8, 7, 6, 5].map(letterFor)).toEqual([
      "100% of the scored questions · A",
      "90% of the scored questions · A",
      "80% of the scored questions · B",
      "70% of the scored questions · C",
      "60% of the scored questions · D",
      "50% of the scored questions · F",
    ]);
  });

  it("leaves out a kind of question the exam does not have, and counts what was not answered", () => {
    const view = examResultView(scoreExam([mc(), mc(), mc()], { 0: { selectedIndex: 1 } }));
    expect(view.headline).toBe("1 of 3 correct");
    expect(view.rows).toEqual([
      { title: "Multiple choice and true or false", value: "1 of 3" },
      { title: "Not answered", value: "2" },
    ]);
  });

  it("says which questions were left out of the score, and never scores an exam with no usable key", () => {
    const noKey = mc({ answerIndex: undefined, answer: "" });
    expect(examResultView(scoreExam([mc(), noKey], { 0: { selectedIndex: 1 } }))).toMatchObject({ headline: "1 of 1 correct", notScored: "1 question had no usable answer key and was not scored." });
    expect(examResultView(scoreExam([mc(), noKey, noKey], { 0: { selectedIndex: 1 } })).notScored).toBe("2 questions had no usable answer key and were not scored.");
    expect(examResultView(scoreExam([noKey, noKey], {}))).toEqual({
      headline: "Exam complete",
      sub: "None of these questions could be scored.",
      fraction: null,
      rows: [],
      notScored: "2 questions had no usable answer key and were not scored.",
    });
  });

  it("tags each question in the review by how it went", () => {
    expect(statusTag("correct")).toEqual({ label: "Correct", tone: "green" });
    expect(statusTag("incorrect")).toEqual({ label: "Incorrect", tone: "red" });
    expect(statusTag("unanswered")).toEqual({ label: "Not answered", tone: "neutral" });
    expect(statusTag("ungradable")).toEqual({ label: "Not scored", tone: "neutral" });
  });

  it("titles a review row by its topic, else by the start of the question", () => {
    expect(reviewTitle(mc())).toBe("Integration by parts");
    expect(reviewTitle(mc({ topic: " ", question: "What is  u?" }))).toBe("What is u?");
    const long = reviewTitle(mc({ topic: "", question: "Which choice of u makes the integral of x times e to the x simplest to integrate by parts?" }));
    expect(long).toBe("Which choice of u makes the integral of x times e to the x…");
    expect(long.length).toBeLessThanOrEqual(61);
  });

  it("an opened row shows what was picked when it was wrong, what is right, and why", () => {
    const order = [1, 3, 0, 2];
    expect(pickedAnswerText(mc(), { selectedIndex: 2 }, order)).toBe("D) u = x e^x");
    expect(pickedAnswerText(mc({ options: ["A) alpha", "B) beta", "C) gamma", "D) delta"] }), { selectedIndex: 0 }, [0, 1, 2, 3])).toBe("A) alpha");
    expect(pickedAnswerText(tf("True"), { selectedBoolean: false }, [])).toBe("False");
    expect(pickedAnswerText(mc(), undefined, order)).toBe("");
    expect(pickedAnswerText(mc(), {}, order)).toBe("");
    expect(rightAnswerText(mc(), order)).toBe("A) u = x");
    expect(rightAnswerText(tf("false"), [])).toBe("False");
    expect(rightAnswerText(short(), [])).toBe("");

    expect(reviewDetail(mc(), { selectedIndex: 2 }, order, "incorrect")).toEqual({ yourAnswer: "D) u = x e^x", correct: "A) u = x", modelAnswer: null, explanation: "With u = x, du is just dx." });
    // A right answer is not repeated as "Your answer".
    expect(reviewDetail(mc(), { selectedIndex: 1 }, order, "correct")).toMatchObject({ yourAnswer: null, correct: "A) u = x" });
    expect(reviewDetail(mc(), undefined, order, "unanswered")).toMatchObject({ yourAnswer: null, correct: "A) u = x" });
    expect(reviewDetail(short(), { selfRating: "missed" }, [], "incorrect")).toEqual({ yourAnswer: null, correct: null, modelAnswer: "The integral of u dv is uv minus the integral of v du.", explanation: "It reverses the product rule." });
    // No key: nothing is claimed to be correct.
    expect(reviewDetail(mc({ answerIndex: undefined, answer: "", explanation: "" }), { selectedIndex: 0 }, [0, 1, 2, 3], "ungradable")).toEqual({ yourAnswer: null, correct: null, modelAnswer: null, explanation: null });
  });
});

describe("test review: adding the pages", () => {
  it("says what the page is, word for word, and that only graded pages are reviewed", () => {
    expect(TEST_REVIEW_HEAD).toEqual({ eyebrow: "Study tools", title: "Test review", sub: "Add photos of a test your teacher has graded. Each marked mistake is explained, with problems to practise." });
    expect(GRADED_ONLY_NOTE).toBe("Graded pages only: a test with no marks isn't reviewed.");
  });

  it("counts the pages against the most a review takes, and says how many more fit", () => {
    expect(MAX_REVIEW_IMAGES).toBe(6);
    expect(pagesCountLabel(0)).toBe("0 of 6");
    expect(pagesCountLabel(4)).toBe("4 of 6");
    expect(pageOptionLines(6)).toEqual({ camera: "Use the camera", photos: "Up to 6 more pages · JPEG or PNG, under 10 MB each" });
    expect(pageOptionLines(1).photos).toBe("Up to 1 more page · JPEG or PNG, under 10 MB each");
    expect(pageOptionLines(0)).toEqual({ camera: "Page limit reached", photos: "Page limit reached" });
    expect(EXTRA_PAGES_NOTICE).toBe("Only 6 pages fit in one review, so the extra photos were skipped.");
  });

  it("'Review my test' is off, with the reason over it, until a page has uploaded", () => {
    const base = { pages: 0, ready: 0, uploading: false, failed: false, reviewing: false };
    expect(reviewStep(base)).toEqual({ label: "Review my test", enabled: false, busy: false, reason: "Add at least one page", reasonTone: "gold" });
    expect(reviewStep({ ...base, pages: 2, uploading: true })).toEqual({ label: "Uploading...", enabled: false, busy: false, reason: null, reasonTone: "quiet" });
    expect(reviewStep({ ...base, pages: 1, failed: true })).toEqual({ label: "Review my test", enabled: false, busy: false, reason: "Fix the failed upload first", reasonTone: "gold" });
    expect(reviewStep({ ...base, pages: 2, ready: 2 })).toEqual({ label: "Review my test", enabled: true, busy: false, reason: null, reasonTone: "quiet" });
  });

  it("goes ahead with the pages that did upload, saying the failed ones are left out", () => {
    expect(reviewStep({ pages: 3, ready: 2, uploading: false, failed: true, reviewing: false })).toEqual({
      label: "Review my test",
      enabled: true,
      busy: false,
      reason: "Pages that failed to upload won't be included. Retry them or remove them.",
      reasonTone: "quiet",
    });
  });

  it("while the review is written it says only that, with no steps and no time", () => {
    const waiting = reviewStep({ pages: 2, ready: 2, uploading: false, failed: false, reviewing: true });
    expect(waiting).toEqual({ label: "Review my test", enabled: false, busy: true, reason: "Reading your pages and writing the review.", reasonTone: "quiet" });
    expect(waiting.reason).not.toMatch(/\d|step|second|minute/i);
  });

  it("the optional rows show what was typed, and never an example dressed up as a value", () => {
    expect(reviewClassValue("")).toBe("None");
    expect(reviewClassValue("  Organic Chemistry ")).toBe("Organic Chemistry");
    expect(reviewQuestionDetail(" Why did I lose points on question 2? ")).toBe("Why did I lose points on question 2?");
    expect(reviewQuestionDetail("")).toBe(`Optional. For example: "${REVIEW_QUESTION_EXAMPLE}"`);
    expect(REVIEW_QUESTION_MAX).toBe(500);
    expect(questionCountLine(120)).toBe("120 of 500");
  });
});

describe("test review: what comes back", () => {
  const result: TestReviewResult = {
    gradedStatus: "graded",
    courseTitle: "Principles of Finance",
    score: "78 of 100",
    mistakes: [{ questionNumber: "4", studentAnswer: "ROE = net income / total assets", correctAnswer: "ROE = net income / equity", explanation: "Dividing by total assets gives return on assets.", concept: "DuPont identity" }],
    conceptsToReview: ["DuPont identity"],
    practiceProblems: [{ question: "A firm has net income of 40 and equity of 250. What is its ROE?", answer: "16%", concept: "DuPont identity" }],
    encouragement: "Most of this paper is right.",
  };

  it("leads with how many mistakes there are to learn from", () => {
    expect(reviewHeadline(4)).toBe("4 mistakes to learn from");
    expect(reviewHeadline(1)).toBe("1 mistake to learn from");
    expect(reviewHeadline(0)).toBe("No marked mistakes found");
    expect(NO_MISTAKES_BODY).toBe("If you expected some, retake the photos with better light and the whole page in frame.");
  });

  it("shows the score only when the test shows one", () => {
    expect(reviewScoreLine("78 of 100")).toBe("Score on the test: 78 of 100");
    expect(reviewScoreLine(" B+ ")).toBe("Score on the test: B+");
    expect(reviewScoreLine("")).toBeNull();
    expect(reviewScoreLine(undefined)).toBeNull();
  });

  it("says, instead of a review, that the test is not graded or the pages could not be read", () => {
    expect(notReviewedTitle("ungraded")).toBe("This test isn't graded yet");
    expect(notReviewedTitle("unreadable")).toBe("We couldn't read those pages");
  });

  it("titles a mistake by its question, whatever the review calls it", () => {
    expect(["4", "Q4", "q. 4", "#9", "Question 7b", "question: 12", "B", "IV"].map(mistakeTitle)).toEqual(["Question 4", "Question 4", "Question 4", "Question 9", "Question 7b", "Question 12", "Question B", "Question IV"]);
    // A name of its own is kept, not turned into "Question Problem 3".
    expect(mistakeTitle("Problem 3")).toBe("Problem 3");
    expect(mistakeTitle("Part B")).toBe("Part B");
    expect(mistakeTitle("  ")).toBe("A marked mistake");
  });

  it("names the course the review found, but not the server's stand-in for 'none found'", () => {
    expect(reviewCourseLabel("Principles of Finance")).toBe("Principles of Finance");
    expect(reviewCourseLabel("Test Review")).toBe("");
    expect(reviewCourseLabel(undefined)).toBe("");
  });

  it("writes the review out for an AI content report", () => {
    expect(reviewExcerpt(result)).toBe(
      ["Principles of Finance", "Score: 78 of 100", "Most of this paper is right.", "Q4 (DuPont identity): correct ROE = net income / equity. Dividing by total assets gives return on assets.", "Practice: A firm has net income of 40 and equity of 250. What is its ROE? Answer: 16%"].join("\n"),
    );
  });

  it("asks before 'Review another test' erases a review, because a review is not saved", () => {
    expect(REVIEW_RESET_COPY.action).toBe("Review another test");
    expect(REVIEW_RESET_COPY.question).toContain("not saved");
  });
});

describe("the words themselves", () => {
  const copy: string[] = [
    ...Object.values(STUDY_GUIDES_HEAD),
    ...Object.values(STUDY_GUIDES_EMPTY),
    ...Object.values(GUIDE_SHEET_COPY),
    ...Object.values(PRACTICE_HEAD),
    ...Object.values(PRACTICE_EMPTY),
    ...Object.values(GUIDE_DELETE_COPY),
    ...Object.values(NOT_SCORED_COPY),
    ...Object.values(SHORT_ANSWER_COPY),
    ...Object.values(TEST_REVIEW_HEAD),
    ...Object.values(REVIEW_RESET_COPY),
    ...Object.values(noSyllabusCopy(0)),
    ...Object.values(noSyllabusCopy(1)),
    GRADED_ONLY_NOTE,
    EXTRA_PAGES_NOTICE,
    NO_MISTAKES_BODY,
    REVIEW_QUESTION_EXAMPLE,
    guidePracticeAction(false, true).wait ?? "",
    reviewStep({ pages: 1, ready: 1, uploading: false, failed: false, reviewing: true }).reason ?? "",
  ];

  it("are plain: no em dash, no exclamation mark, no emoji, nothing about a cut feature", () => {
    for (const text of copy) {
      expect(text, text).not.toMatch(/[—!]/);
      expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, text).not.toMatch(/\b(meal|workout|health|journal|insight|score card|streak|goal|timer)s?\b/i);
    }
  });
});

describe("the study tools' screens, as built for the web", () => {
  const SCREENS = ["src/screens/study-guides.tsx", "src/screens/practice.tsx", "src/screens/test-review.tsx"];
  const FILES = [
    ...SCREENS,
    "src/screens/study.tsx",
    "src/components/study-parts.tsx",
    "src/components/study-guide-new-sheet.tsx",
    "src/components/study-guide-more-sheet.tsx",
    "src/components/practice-result.tsx",
    "src/components/test-review-pages.tsx",
    "src/components/test-review-result.tsx",
    "src/components/test-review-text-sheet.tsx",
  ];

  it("the tools that call the AI open Trajectory Pro for a student without it; taking a saved exam does not", () => {
    expect(read("src/screens/study-guides.tsx").match(/useRedirectToPaywallIfNotPro\(\);/g)).toHaveLength(2);
    expect(read("src/screens/test-review.tsx")).toContain("useRedirectToPaywallIfNotPro();");
    const practice = read("src/screens/practice.tsx");
    const [list, exam] = practice.split("export function PracticeExamScreen");
    expect(list).toContain("useRedirectToPaywallIfNotPro();");
    expect(exam).not.toContain("useRedirectToPaywallIfNotPro");
  });

  it("a pushed screen goes back to where it came from; none replaces itself with the tabs", () => {
    for (const file of SCREENS) {
      const text = read(file);
      expect(text, file).toContain("goBack(");
      expect(text, file).not.toMatch(/navigate\([^)]*\{ replace: true \}\)/);
    }
  });

  it("an exam prep's quiz opens in that exam prep, on the quiz; a practice exam by its guide", () => {
    const practice = read("src/screens/practice.tsx");
    expect(practice).toContain("navigate(`exam-prep/${encodeURIComponent(entry.examId)}?tab=quiz`)");
    expect(practice).toContain("navigate(`practice-exam/${encodeURIComponent(entry.guideId)}`)");
    expect(read("src/screens/exam-prep.tsx")).toContain('route.query.tab === "quiz"');
  });

  it("a study guide is deleted only through the question in its sheet", () => {
    const screen = read("src/screens/study-guides.tsx");
    expect(screen.match(/DELETE_STUDY_GUIDE/g)).toHaveLength(1);
    expect(screen).toContain("onDelete={deleteGuide}");
    const sheet = read("src/components/study-guide-more-sheet.tsx");
    expect(sheet).toContain("question={GUIDE_DELETE_COPY.question}");
    // The row only opens the question; the question's own button is what deletes.
    expect(sheet.match(/onDelete\(\)/g)).toHaveLength(1);
    expect(sheet).toMatch(/onClick=\{\(\) => setConfirming\(true\)\} aria-label=\{GUIDE_DELETE_COPY\.row\}/);
  });

  it("a free student over the syllabus limit is sent to Trajectory Pro from 'Upload your syllabus', as everywhere", () => {
    const screen = read("src/screens/study-guides.tsx");
    expect(screen).toContain("decideSyllabusUpload({ isPro, isLoading: isProLoading, syllabusCount: state.syllabusImports?.length ?? 0 })");
    expect(screen).toContain('decision === "allow" ? "syllabus" : "paywall"');
  });

  it("the Study tab offers the four tools behind the Pro gate, labelled once", () => {
    const study = read("src/screens/study.tsx");
    expect(study).toContain("STUDY_TOOLS.map(");
    expect(study).toContain("if (!requirePro()) return;");
    expect(study).toContain('aria-label="Part of Trajectory Pro"');
  });

  it("every AI answer on these screens carries the AI label, and the screens never alert", () => {
    for (const file of ["src/screens/study-guides.tsx", "src/screens/practice.tsx", "src/components/practice-result.tsx", "src/components/test-review-result.tsx"]) {
      expect(read(file), file).toContain("<AiContentLabel");
    }
    for (const file of FILES) {
      const text = read(file);
      expect(text, file).not.toMatch(/window\.(alert|confirm|prompt)\(/);
      // Nothing under 12px.
      const sizes = [...text.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
      expect(sizes.filter((size) => size < 12), file).toEqual([]);
    }
  });

  it("the server's answers are read through the engine's parsers before anything is saved", () => {
    const api = read("src/lib/study-api.ts");
    for (const procedure of ["ai.analyzeSyllabus", "ai.generatePracticeExam", "ai.generateExamContent", "ai.reviewTest"]) expect(api).toContain(`mutate("${procedure}"`);
    const answers = read("src/lib/study-answers.ts");
    for (const parser of ["parseStudyGuideResponse", "parsePracticeExamResponse", "parseExamContentResponse", "parseTestReviewResponse"]) expect(answers).toContain(parser);
    // The tools never reach the server by any other door, and the Gemini key is gone from exam prep.
    const prep = read("src/screens/exam-prep.tsx");
    expect(prep).not.toMatch(/lib\/gemini|lib\/ai-types/);
    expect(prep).toContain("generateExamContent(");
  });
});
