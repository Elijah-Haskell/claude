import { describe, expect, it } from "vitest";
import {
  parseExamContentResponse,
  parsePracticeExamResponse,
  parseStudyGuideResponse,
  parseTestReviewResponse,
  PRACTICE_EXAM_RESPONSE_FORMAT,
  UNGRADED_TEST_MESSAGE,
} from "../../src/engine/study-parsers";
import { gradeResponse } from "../../src/engine/practice-exam-scoring";

const json = (value: unknown) => JSON.stringify(value);

/** Content shapes a provider can return, none of which may crash a parser. */
const GARBAGE: unknown[] = [
  undefined,
  null,
  "",
  "   ",
  "not json at all",
  "{",
  '{"topics": [',
  "[]",
  "[1,2,3]",
  "null",
  "42",
  '"a string"',
  [],
  [{ type: "image_url" }],
  { not: "content" },
  12,
  "```json\n```",
  "```json\n{oops}\n```",
];

describe("every parser survives garbage (no throw, ok:false)", () => {
  it.each(GARBAGE.map((g, i) => [i, g]))("garbage #%i", (_i, garbage) => {
    expect(parseStudyGuideResponse(garbage).ok).toBe(false);
    expect(parsePracticeExamResponse(garbage, { requestedCount: 5 }).ok).toBe(false);
    expect(parseExamContentResponse(garbage).ok).toBe(false);
    expect(parseTestReviewResponse(garbage).ok).toBe(false);
  });

  it("well-formed JSON with the wrong shape is not ok either", () => {
    for (const shape of [{}, { topics: "many" }, { questions: {} }, { flashcards: 3 }, { mistakes: null }]) {
      expect(parseStudyGuideResponse(json(shape)).ok).toBe(false);
      expect(parsePracticeExamResponse(json(shape), { requestedCount: 5 }).ok).toBe(false);
      expect(parseExamContentResponse(json(shape)).ok).toBe(false);
      expect(parseTestReviewResponse(json(shape)).ok).toBe(false);
    }
  });
});

describe("parseStudyGuideResponse", () => {
  const good = {
    courseTitle: "BIO 101",
    examDate: "2026-12-10",
    overview: "Intro biology.",
    topics: [
      { title: "Cells", week: "Week 1", description: "Cell structure.", keyTerms: ["nucleus", "membrane"], importance: "high" },
      { title: "Genetics", week: "", description: "DNA and heredity.", keyTerms: [], importance: "medium" },
    ],
    studyTips: ["Sleep", "Practice"],
  };

  it("accepts a good reply", () => {
    const r = parseStudyGuideResponse(json(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.courseTitle).toBe("BIO 101");
    expect(r.value.examDate).toBe("2026-12-10");
    expect(r.value.topics).toHaveLength(2);
    expect(r.value.topics[1]!.week).toBeUndefined();
  });

  it("tolerates markdown fences and leading prose", () => {
    expect(parseStudyGuideResponse("```json\n" + json(good) + "\n```").ok).toBe(true);
    expect(parseStudyGuideResponse("Sure! Here you go:\n" + json(good) + "\nHope that helps.").ok).toBe(true);
    expect(parseStudyGuideResponse([{ type: "text", text: json(good) }]).ok).toBe(true);
  });

  it("truncated JSON is not ok (the caller retries) instead of an empty 'AI generated' guide", () => {
    const cut = json(good).slice(0, 120);
    expect(parseStudyGuideResponse(cut).ok).toBe(false);
  });

  it("an empty topic list is a failure, never a saved empty guide", () => {
    expect(parseStudyGuideResponse(json({ ...good, topics: [] })).ok).toBe(false);
    expect(parseStudyGuideResponse(json({ ...good, topics: [{ title: "", description: "x" }, null, 5] })).ok).toBe(false);
  });

  it("clamps and cleans: bad importance -> medium, invalid exam dates dropped, lengths capped, duplicates removed", () => {
    const r = parseStudyGuideResponse(
      json({
        courseTitle: "",
        examDate: "2026-13-45",
        overview: "o".repeat(5000),
        topics: [
          { title: "A", description: "d", keyTerms: Array(50).fill("term").map((t, i) => t + i), importance: "URGENT" },
          { title: "a", description: "duplicate title", keyTerms: [], importance: "low" },
          { title: "B".repeat(500), description: "d".repeat(5000), keyTerms: [], importance: "LOW" },
        ],
        studyTips: Array.from({ length: 30 }, (_, i) => `tip ${i}`),
      }),
      { fallbackTitle: "My course" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.courseTitle).toBe("My course");
    expect(r.value.examDate).toBe("");
    expect(r.value.overview.length).toBeLessThanOrEqual(900);
    expect(r.value.topics).toHaveLength(2);
    expect(r.value.topics[0]!.importance).toBe("medium");
    expect(r.value.topics[0]!.keyTerms.length).toBeLessThanOrEqual(10);
    expect(r.value.topics[1]!.title.length).toBeLessThanOrEqual(120);
    expect(r.value.topics[1]!.description.length).toBeLessThanOrEqual(700);
    expect(r.value.topics[1]!.importance).toBe("low");
    expect(r.value.studyTips).toHaveLength(8);
  });

  it("caps the topic count", () => {
    const topics = Array.from({ length: 200 }, (_, i) => ({ title: `Topic ${i}`, week: "", description: "d", keyTerms: [], importance: "low" }));
    const r = parseStudyGuideResponse(json({ ...good, topics }));
    expect(r.ok && r.value.topics.length).toBe(40);
  });

  it("removes URLs the student never provided, keeps ones that appear in their material", () => {
    const r = parseStudyGuideResponse(
      json({
        ...good,
        overview: "See https://evil.example/phish and [read this](http://tracker.example/x) or https://school.edu/bio for more.",
        studyTips: ["Visit www.spam.example now", "Use https://school.edu/bio"],
      }),
      { sourceText: "Course page: https://school.edu/bio" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.overview).not.toContain("evil.example");
    expect(r.value.overview).not.toContain("tracker.example");
    expect(r.value.overview).toContain("read this");
    expect(r.value.overview).toContain("https://school.edu/bio");
    expect(r.value.studyTips[0]).not.toMatch(/spam/);
    expect(r.value.studyTips[1]).toContain("https://school.edu/bio");
  });
});

describe("parsePracticeExamResponse: the answerIndex contract", () => {
  const mcq = (over: Record<string, unknown> = {}) => ({
    type: "multiple_choice",
    question: "Which organelle makes ATP?",
    options: ["Mitochondria", "Ribosome", "Nucleus", "Golgi body"],
    answerIndex: 0,
    answer: "Mitochondria",
    explanation: "Cellular respiration.",
    topic: "Cells",
    difficulty: "easy",
    ...over,
  });
  const tf = (over: Record<string, unknown> = {}) => ({ type: "true_false", question: "DNA is double stranded.", options: [], answerIndex: -1, answer: "True", explanation: "Yes.", topic: "Genetics", difficulty: "medium", ...over });
  const sa = (over: Record<string, unknown> = {}) => ({ type: "short_answer", question: "Explain osmosis.", options: [], answerIndex: -1, answer: "Water moves across a membrane.", explanation: "Passive transport.", topic: "Cells", difficulty: "hard", ...over });
  const exam = (questions: unknown[], extra: Record<string, unknown> = {}) => json({ courseTitle: "BIO", estimatedMinutes: 20, questions, ...extra });

  it("accepts the three question types and normalises MC answer to the option text + index", () => {
    const r = parsePracticeExamResponse(exam([mcq(), tf(), sa()]), { requestedCount: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.questions).toHaveLength(3);
    const q = r.value.questions[0]!;
    expect(q.options).toEqual(["Mitochondria", "Ribosome", "Nucleus", "Golgi body"]);
    expect(q.answerIndex).toBe(0);
    expect(q.answer).toBe("Mitochondria");
    expect(r.value.questions[1]!.answer).toBe("True");
    expect(r.value.questions[1]!.options).toBeUndefined();
    expect(r.value.questions[2]!.answerIndex).toBeUndefined();
  });

  it("the parsed MC question is scored correctly by the client scoring module (end to end contract)", () => {
    const r = parsePracticeExamResponse(exam([mcq({ answerIndex: 2, answer: "Nucleus" }), tf(), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(gradeResponse(r.value.questions[0]!, { selectedIndex: 2 })).toBe(true);
    expect(gradeResponse(r.value.questions[0]!, { selectedIndex: 0 })).toBe(false);
  });

  it("salvages a model that still answers with a LETTER (the old prompt): 'B' -> index 1 and the option text", () => {
    const q = mcq({ options: ["A) Mitochondria", "B) Ribosome", "C) Nucleus", "D) Golgi body"], answerIndex: -1, answer: "B" });
    const r = parsePracticeExamResponse(exam([q, tf(), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions[0]!.options).toEqual(["Mitochondria", "Ribosome", "Nucleus", "Golgi body"]);
    expect(r.value.questions[0]!.answerIndex).toBe(1);
    expect(r.value.questions[0]!.answer).toBe("Ribosome");
  });

  it("accepts a numeric-string answerIndex and an answer that is only the option text", () => {
    const r = parsePracticeExamResponse(exam([mcq({ answerIndex: "3", answer: "" }), mcq({ question: "Q2", answerIndex: null, answer: "nucleus" }), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions[0]!.answerIndex).toBe(3);
    expect(r.value.questions[1]!.answerIndex).toBe(2);
  });

  it("drops MC questions that can't be trusted: not exactly 4 options, blank or duplicate options, no resolvable answer, out-of-range index", () => {
    const bad = [
      mcq({ question: "three", options: ["a", "b", "c"], answerIndex: 0 }),
      mcq({ question: "five", options: ["a", "b", "c", "d", "e"], answerIndex: 0 }),
      mcq({ question: "blank", options: ["a", "", "c", "d"], answerIndex: 0 }),
      mcq({ question: "dup", options: ["same", "Same", "c", "d"], answerIndex: 0 }),
      mcq({ question: "nokey", answerIndex: -1, answer: "" }),
      mcq({ question: "nomatch", answerIndex: 9, answer: "Chloroplast" }),
      mcq({ question: "notarray", options: "A, B, C, D" }),
    ];
    const r = parsePracticeExamResponse(exam([...bad, mcq(), tf(), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions).toHaveLength(3);
    expect(r.value.dropped).toBe(bad.length);
  });

  it("keeps options that merely start with 'A. ' when they are not a full A-B-C-D sequence", () => {
    const q = mcq({ options: ["A. Smith", "Karl Marx", "J. M. Keynes", "D. Ricardo"], answerIndex: 0, answer: "A. Smith" });
    const r = parsePracticeExamResponse(exam([q, tf(), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions[0]!.options![0]).toBe("A. Smith");
  });

  it("true/false: booleans and odd spellings normalise; garbage is dropped", () => {
    const r = parsePracticeExamResponse(
      exam([tf({ answer: true, question: "q1" }), tf({ answer: "false.", question: "q2" }), tf({ answer: "maybe", question: "q3" }), mcq(), sa()]),
      { requestedCount: 4 },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions.filter((q) => q.type === "true_false").map((q) => q.answer)).toEqual(["True", "False"]);
  });

  it("short answers need a model answer", () => {
    const r = parsePracticeExamResponse(exam([sa({ answer: "" }), mcq(), tf(), sa({ question: "Second" })]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions.map((q) => q.type)).toEqual(["multiple_choice", "true_false", "short_answer"]);
  });

  it("removes duplicate questions and normalises question types / difficulty", () => {
    const r = parsePracticeExamResponse(
      exam([mcq({ type: "MCQ", difficulty: "HARD" }), mcq({ type: "multiple choice" }), tf({ type: "true/false", difficulty: "brutal" }), sa({ type: "Short Answer" })]),
      { requestedCount: 4 },
    );
    // the two identical MC questions collapse to one -> 3 questions < 60% rounding minimum? min = min(4, max(3, 3)) = 3 -> ok
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions).toHaveLength(3);
    expect(r.value.questions[0]!.difficulty).toBe("hard");
    expect(r.value.questions[1]!.type).toBe("true_false");
    expect(r.value.questions[1]!.difficulty).toBe("medium");
  });

  it("fails (so the caller retries) when most of the reply is unusable, succeeds on a mostly-good one", () => {
    const junk = Array.from({ length: 8 }, (_, i) => mcq({ question: `junk ${i}`, options: ["x"] }));
    expect(parsePracticeExamResponse(exam([...junk, mcq()]), { requestedCount: 10 }).ok).toBe(false);
    const many = Array.from({ length: 10 }, (_, i) => tf({ question: `question ${i}` }));
    const partial = parsePracticeExamResponse(exam([...many.slice(0, 7), mcq({ options: ["x"] }), mcq({ options: ["y"] }), mcq({ options: ["z"] })]), { requestedCount: 10 });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.value.questions).toHaveLength(7);
  });

  it("never returns more than requested and clamps estimatedMinutes", () => {
    const qs = Array.from({ length: 20 }, (_, i) => tf({ question: `question ${i}` }));
    const r = parsePracticeExamResponse(exam(qs, { estimatedMinutes: 100000 }), { requestedCount: 5 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.questions).toHaveLength(5);
    expect(r.value.estimatedMinutes).toBe(180);
    const r2 = parsePracticeExamResponse(exam(qs, { estimatedMinutes: "soon" }), { requestedCount: 5 });
    expect(r2.ok && r2.value.estimatedMinutes).toBe(10);
  });

  it("the strict JSON schema requires the contract fields on every question", () => {
    const item = (PRACTICE_EXAM_RESPONSE_FORMAT.json_schema.schema.properties.questions as { items: { required: string[]; properties: Record<string, { minimum?: number; maximum?: number }> } }).items;
    expect(item.required).toEqual(expect.arrayContaining(["type", "question", "options", "answerIndex", "answer", "explanation", "topic", "difficulty"]));
    expect(item.properties.answerIndex).toMatchObject({ minimum: -1, maximum: 3 });
    expect(PRACTICE_EXAM_RESPONSE_FORMAT.json_schema.strict).toBe(true);
  });

  it("strips URLs from questions and options", () => {
    const q = mcq({ question: "See https://evil.example/x for Q", options: ["Go to http://a.example", "b", "c", "d"], answerIndex: 1, answer: "b" });
    const r = parsePracticeExamResponse(exam([q, tf(), sa()]), { requestedCount: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(JSON.stringify(r.value)).not.toMatch(/https?:\/\//);
  });
});

describe("parseExamContentResponse", () => {
  const good = {
    topicExpansions: [{ title: "GAAP", explanation: "Accounting rules.", keyPoints: ["a", "b"], commonMistakes: "Mixing with IFRS." }],
    keyConcepts: ["Accrual", "Matching"],
    bigPictureSummary: "Summary.",
    importantDefinitions: [{ term: "Accrual", definition: "Record when earned." }],
    flashcards: [
      { front: "What is GAAP?", back: "Rules." },
      { front: "What is accrual?", back: "Earned basis." },
    ],
    practiceQuestions: [{ question: "Explain matching.", answer: "Expenses match revenue." }],
  };

  it("accepts a good reply", () => {
    const r = parseExamContentResponse(json(good));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flashcards).toHaveLength(2);
  });

  it("an all-empty reply (what the old code turned into permanently empty 'AI generated' content) is a failure", () => {
    expect(parseExamContentResponse(json({ topicExpansions: [], keyConcepts: [], bigPictureSummary: "", importantDefinitions: [], flashcards: [], practiceQuestions: [] })).ok).toBe(false);
    expect(parseExamContentResponse(json({ bigPictureSummary: "only a summary" })).ok).toBe(false);
  });

  it("drops malformed items and keeps the rest", () => {
    const r = parseExamContentResponse(
      json({
        ...good,
        flashcards: [{ front: "ok", back: "ok" }, { front: "no back" }, null, "str", { front: "", back: "x" }, { front: "ok", back: "duplicate front" }, { front: "Another", back: "fine" }],
        practiceQuestions: [{ question: "q", answer: "a" }, { answer: "orphan" }],
        topicExpansions: [{ title: "T", explanation: "e", keyPoints: "not an array", commonMistakes: 5 }, { title: "no explanation" }],
      }),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.flashcards.map((f) => f.front)).toEqual(["ok", "Another"]);
    expect(r.value.practiceQuestions).toHaveLength(1);
    expect(r.value.topicExpansions).toEqual([{ title: "T", explanation: "e", keyPoints: [], commonMistakes: "5" }]);
  });

  it("caps counts and lengths", () => {
    const r = parseExamContentResponse(
      json({
        ...good,
        flashcards: Array.from({ length: 500 }, (_, i) => ({ front: `f${i}`, back: "b".repeat(5000) })),
        keyConcepts: Array.from({ length: 500 }, (_, i) => `c${i}`),
        bigPictureSummary: "s".repeat(50000),
      }),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.flashcards).toHaveLength(60);
    expect(r.value.flashcards[0]!.back.length).toBeLessThanOrEqual(800);
    expect(r.value.keyConcepts).toHaveLength(40);
    expect(r.value.bigPictureSummary.length).toBeLessThanOrEqual(2000);
  });

  it("removes URLs that are not in the student's material", () => {
    const r = parseExamContentResponse(json({ ...good, bigPictureSummary: "Read https://x.example/a and https://mine.example/notes" }), { sourceText: "my notes at https://mine.example/notes" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.bigPictureSummary).not.toContain("x.example");
    expect(r.value.bigPictureSummary).toContain("https://mine.example/notes");
  });
});

describe("parseTestReviewResponse", () => {
  const graded = {
    gradedStatus: "graded",
    courseTitle: "Chem",
    score: "14/20",
    mistakes: [{ questionNumber: "3b", studentAnswer: "12", correctAnswer: "14", explanation: "Carry the one.", concept: "Addition" }],
    conceptsToReview: ["Carrying"],
    practiceProblems: [{ question: "7+8?", answer: "15", concept: "Addition" }],
    encouragement: "Nice work on the rest.",
  };

  it("accepts a graded review, including the legacy `practiceProblem` key", () => {
    const r = parseTestReviewResponse(json(graded));
    expect(r.ok && r.value.mistakes).toHaveLength(1);
    const { practiceProblems, ...rest } = graded;
    const legacy = parseTestReviewResponse(json({ ...rest, practiceProblem: practiceProblems }));
    expect(legacy.ok && legacy.value.practiceProblems).toHaveLength(1);
  });

  it("an ungraded test gets NO answers even if the model produced some (not a live-exam answer key)", () => {
    const r = parseTestReviewResponse(json({ ...graded, gradedStatus: "ungraded" }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.gradedStatus).toBe("ungraded");
    expect(r.value.mistakes).toEqual([]);
    expect(r.value.practiceProblems).toEqual([]);
    expect(r.value.conceptsToReview).toEqual([]);
    expect(r.value.encouragement).toBe(UNGRADED_TEST_MESSAGE);
    expect(JSON.stringify(r.value)).not.toContain("Carry the one");
  });

  it("unreadable pages say so", () => {
    const r = parseTestReviewResponse(json({ gradedStatus: "unreadable" }));
    expect(r.ok && r.value.gradedStatus).toBe("unreadable");
  });

  it("a missing gradedStatus is treated as graded (older/looser replies)", () => {
    const { gradedStatus, ...rest } = graded;
    const r = parseTestReviewResponse(json(rest));
    expect(r.ok && r.value.gradedStatus).toBe("graded");
  });

  it("a perfect paper (a score, nothing wrong) is a valid review; a reply with nothing at all is not", () => {
    const perfect = parseTestReviewResponse(json({ ...graded, score: "20/20", mistakes: [], conceptsToReview: [], practiceProblems: [] }));
    expect(perfect.ok).toBe(true);
    expect(parseTestReviewResponse(json({ ...graded, score: "", mistakes: [], conceptsToReview: [], practiceProblems: [] })).ok).toBe(false);
  });

  it("drops empty mistakes, numbers unnumbered ones, caps everything", () => {
    const r = parseTestReviewResponse(
      json({
        ...graded,
        mistakes: [
          { questionNumber: "", studentAnswer: "x", correctAnswer: "y", explanation: "why", concept: "" },
          { explanation: "", correctAnswer: "" },
          ...Array.from({ length: 100 }, (_, i) => ({ questionNumber: String(i), correctAnswer: `c${i}`, explanation: `e${i}`, concept: "c" })),
        ],
        score: "s".repeat(100),
      }),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.mistakes).toHaveLength(25);
    expect(r.value.mistakes[0]!.questionNumber).toBe("1");
    expect(r.value.mistakes[0]!.concept).toBe("General");
    expect(r.value.score.length).toBeLessThanOrEqual(30);
  });
});
