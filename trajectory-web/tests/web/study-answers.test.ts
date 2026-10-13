import { describe, expect, it } from "vitest";

import { answerText, parseExamContentAnswer, parsePracticeExamAnswer, parseStudyGuideAnswer, parseTestReviewAnswer, STUDY_ANSWER_FAILURE, StudyAnswerError } from "../../src/lib/study-answers";
import { describeStudyError } from "../../src/lib/study-errors";

// The shapes the server answers with (server/study-ai.ts), as tests/mock-server.mjs answers them.
const GUIDE = {
  courseTitle: "Biology 101",
  examDate: "2026-12-10",
  overview: "Intro biology.",
  topics: [
    { title: "Cells", week: "Week 1", description: "Cell structure.", keyTerms: ["nucleus"], importance: "high" },
    { title: "Genetics", week: "Week 2", description: "Heredity.", keyTerms: ["allele"], importance: "medium" },
  ],
  studyTips: ["Sleep well"],
};

const mcq = (i: number) => ({ type: "multiple_choice", question: `Which is right? #${i}`, options: ["one", "two", "three", "four"], answerIndex: 2, answer: "three", explanation: "Because.", topic: "T", difficulty: "easy" });
const tf = (i: number) => ({ type: "true_false", question: `TF ${i}`, options: [], answerIndex: -1, answer: "True", explanation: "Yes", topic: "T", difficulty: "medium" });
const EXAM = { courseTitle: "Biology 101", estimatedMinutes: 20, questions: [mcq(1), mcq(2), tf(3), tf(4), tf(5)], dropped: 0 };

const CONTENT = {
  topicExpansions: [{ title: "GAAP", explanation: "Rules.", keyPoints: ["a"], commonMistakes: "b" }],
  keyConcepts: ["Accrual"],
  bigPictureSummary: "Summary",
  importantDefinitions: [{ term: "Accrual", definition: "Record when earned." }],
  flashcards: [{ front: "q1", back: "a1" }, { front: "q2", back: "a2" }, { front: "q3", back: "a3" }],
  practiceQuestions: [{ question: "Explain", answer: "Because" }],
  inputTruncated: true,
  inputChars: 70_000,
  usedChars: 60_000,
};

const GRADED = {
  gradedStatus: "graded",
  courseTitle: "Chem",
  score: "14/20",
  mistakes: [{ questionNumber: "3", studentAnswer: "12", correctAnswer: "14", explanation: "Carry the one.", concept: "Addition" }],
  conceptsToReview: ["Carrying"],
  practiceProblems: [{ question: "7+8?", answer: "15", concept: "Addition" }],
  encouragement: "Good.",
};

describe("answerText", () => {
  it("hands the parsers the answer as text, whether it arrived as an object or as text", () => {
    expect(answerText({ a: 1 })).toBe('{"a":1}');
    expect(answerText('{"a":1}')).toBe('{"a":1}');
    expect(answerText(null)).toBe("");
    expect(answerText(undefined)).toBe("");
  });
});

describe("the study guide answer", () => {
  it("is read through the engine's parser and keeps what it keeps", () => {
    const guide = parseStudyGuideAnswer(GUIDE, { syllabusText: "Week 1: cells.", courseName: "BIO" });
    expect(guide.courseTitle).toBe("Biology 101");
    expect(guide.examDate).toBe("2026-12-10");
    expect(guide.topics.map((topic) => topic.title)).toEqual(["Cells", "Genetics"]);
    expect(guide.studyTips).toEqual(["Sleep well"]);
  });

  it("falls back to the course the student named, and refuses a guide with no topics in the server's own words", () => {
    expect(parseStudyGuideAnswer({ ...GUIDE, courseTitle: "" }, { syllabusText: "x", courseName: "BIO" }).courseTitle).toBe("BIO");
    expect(() => parseStudyGuideAnswer({ ...GUIDE, topics: [] }, { syllabusText: "x" })).toThrow(StudyAnswerError);
    expect(() => parseStudyGuideAnswer("not json", { syllabusText: "x" })).toThrow(STUDY_ANSWER_FAILURE.studyGuide);
  });

  it("drops a URL the student never supplied", () => {
    const guide = parseStudyGuideAnswer({ ...GUIDE, overview: "See https://evil.example for more." }, { syllabusText: "Week 1: cells." });
    expect(guide.overview).not.toContain("evil.example");
  });
});

describe("the practice exam answer", () => {
  it("keeps the questions that survive validation, with answerIndex as the key", () => {
    const exam = parsePracticeExamAnswer(EXAM, { syllabusText: "s", courseName: "Biology 101", questionCount: 5 });
    expect(exam.questions).toHaveLength(5);
    expect(exam.questions[0]).toMatchObject({ type: "multiple_choice", answerIndex: 2, answer: "three" });
    expect(exam.questions[2]).toMatchObject({ type: "true_false", answer: "True" });
    expect(exam.estimatedMinutes).toBe(20);
  });

  it("refuses a mostly broken exam", () => {
    const broken = { ...EXAM, questions: [mcq(1), { type: "multiple_choice", question: "no options" }, { type: "weird" }, {}, {}] };
    expect(() => parsePracticeExamAnswer(broken, { syllabusText: "s", questionCount: 5 })).toThrow(STUDY_ANSWER_FAILURE.practiceExam);
  });
});

describe("the exam content answer", () => {
  it("keeps the content and how much of the notes the server read", () => {
    const content = parseExamContentAnswer(CONTENT, { topics: ["GAAP"], rawInput: "notes" });
    expect(content.flashcards).toHaveLength(3);
    expect(content.topicExpansions[0]).toMatchObject({ title: "GAAP", keyPoints: ["a"] });
    expect(content).toMatchObject({ inputTruncated: true, inputChars: 70_000, usedChars: 60_000 });
  });

  it("works out the truncation itself when the server does not say", () => {
    const { inputTruncated: _t, inputChars: _c, usedChars: _u, ...bare } = CONTENT;
    const content = parseExamContentAnswer(bare, { topics: ["GAAP"], rawInput: "short notes" });
    expect(content).toMatchObject({ inputTruncated: false, inputChars: "short notes".length, usedChars: "short notes".length });
  });

  it("refuses content with nothing to study from", () => {
    const empty = { topicExpansions: [], keyConcepts: [], bigPictureSummary: "", importantDefinitions: [], flashcards: [], practiceQuestions: [] };
    expect(() => parseExamContentAnswer(empty, { topics: ["GAAP"] })).toThrow(STUDY_ANSWER_FAILURE.examContent);
  });
});

describe("the test review answer", () => {
  it("keeps a graded review", () => {
    const review = parseTestReviewAnswer(GRADED, { courseName: "Chem" });
    expect(review.gradedStatus).toBe("graded");
    expect(review.mistakes[0]).toMatchObject({ questionNumber: "3", concept: "Addition" });
    expect(review.practiceProblems).toHaveLength(1);
    expect(review.score).toBe("14/20");
  });

  it("an ungraded test gets the standing sentence and no answers", () => {
    const review = parseTestReviewAnswer({ ...GRADED, gradedStatus: "ungraded" }, {});
    expect(review.gradedStatus).toBe("ungraded");
    expect(review.mistakes).toEqual([]);
    expect(review.encouragement).toMatch(/doesn't look graded yet/);
  });

  it("refuses a reply that saw nothing on the pages", () => {
    expect(() => parseTestReviewAnswer({ gradedStatus: "graded", courseTitle: "", score: "", mistakes: [], conceptsToReview: [], practiceProblems: [], encouragement: "" }, {})).toThrow(STUDY_ANSWER_FAILURE.testReview);
  });
});

describe("a refused answer, as the student reads it", () => {
  it("keeps the server's own sentence and can be tried again", () => {
    let caught: unknown;
    try {
      parseStudyGuideAnswer({}, { syllabusText: "x" });
    } catch (error) {
      caught = error;
    }
    const info = describeStudyError(caught, "build the study guide");
    expect(info.message).toBe(STUDY_ANSWER_FAILURE.studyGuide);
    expect(info.retryable).toBe(true);
    expect((caught as StudyAnswerError).reason).toMatch(/no topics/);
    expect(() => parseStudyGuideAnswer("not json at all", { syllabusText: "x" })).toThrow(expect.objectContaining({ reason: expect.stringMatching(/JSON object/) }));
  });
});
