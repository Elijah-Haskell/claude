import { describe, expect, it } from "vitest";
import {
  describeStudySourceRow,
  examStudyGuideExcerpt,
  guideCourseName,
  questionsExcerpt,
  sortGuidesNewestFirst,
  studyGuideExcerpt,
  studyGuideFromAnalysis,
} from "../../src/engine/study-guides";
import { buildPastedSource } from "../../src/engine/study-source";
import { buildPracticeList } from "../../src/engine/study-hub";
import type { ExamPrep, SyllabusPracticeExam, SyllabusStudyGuide } from "../../src/engine/types";

const TEXT = "Week 1: cells and membranes. Week 2: DNA replication and transcription. Week 3: proteins.";

const guide = (over: Partial<SyllabusStudyGuide> = {}): SyllabusStudyGuide => ({
  id: "g1",
  courseTitle: "Biology 101",
  overview: "Intro biology.",
  topics: [{ title: "Cells", description: "Cell structure.", keyTerms: ["nucleus"], importance: "high" }],
  studyTips: ["Draw the cell."],
  createdAt: "2030-03-01T00:00:00Z",
  ...over,
});

const practice = (over: Partial<SyllabusPracticeExam> = {}): SyllabusPracticeExam => ({
  id: "p1",
  studyGuideId: "g1",
  courseTitle: "Biology 101",
  totalQuestions: 1,
  estimatedMinutes: 20,
  questions: [{ type: "true_false", question: "Cells have a nucleus?", answer: "True", difficulty: "easy", topic: "Cells" } as never],
  createdAt: "2030-03-02T00:00:00Z",
  ...over,
});

const exam = (over: Partial<ExamPrep> = {}): ExamPrep => ({
  id: "e1",
  classId: "bio",
  className: "Biology",
  examDate: "2030-03-20",
  topics: [],
  rawInput: "",
  studyBlockIds: [],
  finalReviewGenerated: false,
  createdAt: "2030-03-01T00:00:00Z",
  ...over,
});

describe("study guide helpers (Exam Prep's Study guides tab)", () => {
  it("describes a source row without inventing parts that are missing", () => {
    expect(describeStudySourceRow({ id: "a", title: "BIO", importedAt: "", kind: "deadlines_only", chars: 0, itemCount: 1 })).toBe("Deadline list only · 1 deadline");
    const full = describeStudySourceRow({ id: "b", title: "CHEM", importedAt: "2030-01-01T12:00:00Z", kind: "syllabus_text", chars: 12000, itemCount: 3 });
    expect(full).toMatch(/^Full syllabus text · 12,000 characters · 3 deadlines · imported /);
    expect(describeStudySourceRow({ id: "c", title: "X", importedAt: "not a date", kind: "none", chars: 0, itemCount: 0 })).toBe("Nothing to build from");
  });

  it("course name: typed name wins, an import falls back to its title, pasted text has none", () => {
    const source = { title: "Biology 101" };
    expect(guideCourseName("  CHEM 101 ", source, "imp")).toBe("CHEM 101");
    expect(guideCourseName("", source, "imp")).toBe("Biology 101");
    expect(guideCourseName("   ", source, undefined)).toBeUndefined();
  });

  it("builds the saved guide with its provenance (same shape the Study Materials screen saved)", () => {
    const source = buildPastedSource(TEXT)!;
    const saved = studyGuideFromAnalysis(
      { courseTitle: "Bio", examDate: null, overview: "o", topics: [], studyTips: ["t"] },
      { id: "x", now: new Date("2030-03-05T10:00:00Z"), typedCourseName: "", source },
    );
    expect(saved).toMatchObject({ id: "x", courseTitle: "Bio", overview: "o", studyTips: ["t"], createdAt: "2030-03-05T10:00:00.000Z", sourceKind: "pasted_text" });
    expect(saved.examDate).toBeUndefined();
    expect(saved.courseName).toBeUndefined();
    expect(saved.sourceImportId).toBeUndefined();
  });

  it("sorts guides newest first and skips junk", () => {
    const sorted = sortGuidesNewestFirst([guide(), guide({ id: "g2", createdAt: "2030-04-01T00:00:00Z" }), null as never]);
    expect(sorted.map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(sortGuidesNewestFirst(undefined)).toEqual([]);
  });

  it("report excerpts carry the AI text", () => {
    expect(studyGuideExcerpt(guide())).toContain("Cells: Cell structure.");
    expect(examStudyGuideExcerpt({ bigPictureSummary: "Big", keyConcepts: ["a", "b"], importantDefinitions: [{ term: "T", definition: "D" }] })).toBe("Big\nKey concepts: a, b\nT: D");
    expect(questionsExcerpt([{ question: "Q?", answer: "A" }])).toBe("Q1: Q?\nA: A");
  });
});

describe("buildPracticeList (Exam Prep's Practice tab)", () => {
  it("lists saved practice exams (newest first, one per guide) then exam quizzes by exam date", () => {
    const list = buildPracticeList({
      practiceExams: [practice(), practice({ id: "p2", studyGuideId: "g2", createdAt: "2030-03-09T00:00:00Z" }), practice({ id: "dup", createdAt: "2030-03-10T00:00:00Z" })],
      examPreps: [
        exam({ id: "late", examDate: "2030-04-01", studyGuide: { keyConcepts: [], importantDefinitions: [], flashcards: [], practiceQuestions: [{ question: "q", answer: "a" }] } }),
        exam({ id: "none" }),
        exam({ id: "soon", subject: "Midterm", examDate: "2030-03-10", studyGuide: { keyConcepts: [], importantDefinitions: [], flashcards: [], practiceQuestions: [{ question: "q", answer: "a" }, { question: "r", answer: "b" }] } }),
      ],
    });
    expect(list.map((e) => e.key)).toEqual(["pe-p2", "pe-p1", "eq-soon", "eq-late"]);
    const quiz = list.find((e) => e.key === "eq-soon")!;
    expect(quiz).toMatchObject({ kind: "exam_quiz", examId: "soon", title: "Biology · Midterm", questionCount: 2 });
  });

  it("skips practice exams with no questions and tolerates missing arrays", () => {
    expect(buildPracticeList({ practiceExams: [practice({ questions: [] })], examPreps: undefined as never })).toEqual([]);
  });
});
