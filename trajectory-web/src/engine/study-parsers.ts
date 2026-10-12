/**
 * Validation of every LLM output the study features use (pure; shared by the server and the tests).
 *
 * Nothing the model returns is trusted: each parser returns `{ ok: false }` (never throws) for
 * unparsable / empty / structurally wrong output, and otherwise a cleaned value with clamped lengths,
 * dropped invalid items and URLs the student never supplied removed. The server retries once on
 * `ok: false` and then reports a friendly error; nothing half-empty is ever saved as "AI generated".
 */
import type { PracticeQuestion, SyllabusTopic } from "./types";
import { parseBoolean, resolveAnswer, stripOptionPrefix, normalizeText } from "./practice-exam-scoring";
import { asArray, asRecord, clampInt, parseJsonObject, sanitizeModelText, validDateKey } from "./study-text";

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function textList(value: unknown, maxItems: number, maxLen: number, allowed: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of asArray(value)) {
    const text = sanitizeModelText(item, maxLen, allowed);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ── Study guide (syllabus text -> topics) ─────────────────────────────────

export const STUDY_GUIDE_LIMITS = { topics: 40, keyTerms: 10, tips: 8 } as const;

export interface StudyGuideOutput {
  courseTitle: string;
  examDate: string;
  overview: string;
  topics: SyllabusTopic[];
  studyTips: string[];
}

export const STUDY_GUIDE_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "trajectory_study_guide",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        courseTitle: { type: "string" },
        examDate: { type: "string" },
        overview: { type: "string" },
        topics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              week: { type: "string" },
              description: { type: "string" },
              keyTerms: { type: "array", items: { type: "string" } },
              importance: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["title", "week", "description", "keyTerms", "importance"],
          },
        },
        studyTips: { type: "array", items: { type: "string" } },
      },
      required: ["courseTitle", "examDate", "overview", "topics", "studyTips"],
    },
  },
};

export function parseStudyGuideResponse(
  content: unknown,
  opts: { fallbackTitle?: string; sourceText?: string } = {},
): ParseResult<StudyGuideOutput> {
  const source = opts.sourceText ?? "";
  const root = parseJsonObject(content);
  if (!root) return fail("The reply was not a JSON object.");

  const seen = new Set<string>();
  const topics: SyllabusTopic[] = [];
  for (const candidate of asArray(root.topics)) {
    const t = asRecord(candidate);
    if (!t) continue;
    const title = sanitizeModelText(t.title, 120, source);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const importance = typeof t.importance === "string" ? t.importance.trim().toLowerCase() : "";
    topics.push({
      title,
      week: sanitizeModelText(t.week, 40, source) || undefined,
      description: sanitizeModelText(t.description, 700, source),
      keyTerms: textList(t.keyTerms, STUDY_GUIDE_LIMITS.keyTerms, 60, source),
      importance: importance === "high" || importance === "low" ? importance : "medium",
    });
    if (topics.length >= STUDY_GUIDE_LIMITS.topics) break;
  }
  if (topics.length === 0) return fail("The study guide had no topics.");

  return {
    ok: true,
    warnings: [],
    value: {
      courseTitle: sanitizeModelText(root.courseTitle, 120, source) || sanitizeModelText(opts.fallbackTitle, 120) || "Study Guide",
      examDate: validDateKey(root.examDate),
      overview: sanitizeModelText(root.overview, 900, source),
      topics,
      studyTips: textList(root.studyTips, STUDY_GUIDE_LIMITS.tips, 300, source),
    },
  };
}

// ── Practice exam ──────────────────────────────────────────────────────

export const PRACTICE_EXAM_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "trajectory_practice_exam",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        courseTitle: { type: "string" },
        estimatedMinutes: { type: "integer", minimum: 5, maximum: 180 },
        questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["multiple_choice", "short_answer", "true_false"] },
              question: { type: "string" },
              // Multiple choice: exactly 4 plain option texts. Other types: an empty array.
              options: { type: "array", items: { type: "string" } },
              // Multiple choice: 0-3 (index of the correct option). Other types: -1.
              answerIndex: { type: "integer", minimum: -1, maximum: 3 },
              // Multiple choice: the correct option's text. True/false: "True" or "False". Short answer: a model answer.
              answer: { type: "string" },
              explanation: { type: "string" },
              topic: { type: "string" },
              difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            },
            required: ["type", "question", "options", "answerIndex", "answer", "explanation", "topic", "difficulty"],
          },
        },
      },
      required: ["courseTitle", "estimatedMinutes", "questions"],
    },
  },
};

export interface PracticeExamOutput {
  courseTitle: string;
  estimatedMinutes: number;
  questions: PracticeQuestion[];
  /** Questions in the reply that were unusable and left out. */
  dropped: number;
}

function normalizeQuestionType(value: unknown): PracticeQuestion["type"] | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s/-]+/g, "_");
  if (v === "multiple_choice" || v === "mcq" || v === "multiplechoice" || v === "mc") return "multiple_choice";
  if (v === "true_false" || v === "truefalse" || v === "tf" || v === "true_or_false") return "true_false";
  if (v === "short_answer" || v === "shortanswer" || v === "open_ended" || v === "sa") return "short_answer";
  return null;
}

/** Removes "A) ", "B. " ... only when EVERY option carries the next letter in sequence (so "A. Smith" survives). */
function stripSequentialPrefixes(options: string[]): string[] {
  const sequential = options.every((option, i) => {
    const m = /^\(?([A-Za-z])[).:]\s+/.exec(option);
    return m !== null && m[1]!.toUpperCase().charCodeAt(0) === 65 + i;
  });
  return sequential ? options.map((option) => stripOptionPrefix(option)) : options;
}

function parseQuestion(candidate: unknown, source: string): PracticeQuestion | null {
  const q = asRecord(candidate);
  if (!q) return null;
  const type = normalizeQuestionType(q.type);
  const question = sanitizeModelText(q.question, 600, source);
  if (!type || !question) return null;
  const explanation = sanitizeModelText(q.explanation, 800, source);
  const topic = sanitizeModelText(q.topic, 120, source) || "General";
  const difficultyRaw = typeof q.difficulty === "string" ? q.difficulty.trim().toLowerCase() : "";
  const difficulty: PracticeQuestion["difficulty"] = difficultyRaw === "easy" || difficultyRaw === "hard" ? difficultyRaw : "medium";
  const base = { type, question, explanation, topic, difficulty };

  if (type === "true_false") {
    const value = parseBoolean(q.answer);
    if (value === null) return null;
    return { ...base, answer: value ? "True" : "False" };
  }

  if (type === "short_answer") {
    const answer = sanitizeModelText(q.answer, 1200, source);
    return answer ? { ...base, answer } : null;
  }

  // Multiple choice: exactly 4 distinct, non-empty options and one resolvable correct answer.
  const rawOptions = asArray(q.options).map((o) => sanitizeModelText(o, 300, source));
  if (rawOptions.length !== 4 || rawOptions.some((o) => !o)) return null;
  const options = stripSequentialPrefixes(rawOptions);
  if (new Set(options.map((o) => normalizeText(o))).size !== options.length) return null;

  const resolved = resolveAnswer({
    type: "multiple_choice",
    options,
    answerIndex: typeof q.answerIndex === "string" && q.answerIndex.trim() !== "" ? Number(q.answerIndex) : q.answerIndex,
    answer: typeof q.answer === "string" ? q.answer : "",
  });
  if (resolved.kind !== "choice") return null;
  return { ...base, options, answerIndex: resolved.index, answer: options[resolved.index]! };
}

export function parsePracticeExamResponse(
  content: unknown,
  opts: { requestedCount: number; fallbackTitle?: string; sourceText?: string },
): ParseResult<PracticeExamOutput> {
  const source = opts.sourceText ?? "";
  const root = parseJsonObject(content);
  if (!root) return fail("The reply was not a JSON object.");
  const rawQuestions = asArray(root.questions);
  if (rawQuestions.length === 0) return fail("The exam had no questions.");

  const seen = new Set<string>();
  const questions: PracticeQuestion[] = [];
  for (const candidate of rawQuestions) {
    const parsed = parseQuestion(candidate, source);
    if (!parsed) continue;
    const key = normalizeText(parsed.question);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(parsed);
  }
  const requested = Math.max(1, Math.floor(opts.requestedCount));
  // Accept a partly-usable reply, but not a mostly-broken one.
  const minimum = Math.min(requested, Math.max(3, Math.ceil(requested * 0.6)));
  if (questions.length < minimum) return fail(`Only ${questions.length} of ${rawQuestions.length} questions were usable.`);

  const kept = questions.slice(0, requested);
  return {
    ok: true,
    warnings: [],
    value: {
      courseTitle: sanitizeModelText(root.courseTitle, 120, source) || sanitizeModelText(opts.fallbackTitle, 120) || "Practice Exam",
      estimatedMinutes: clampInt(root.estimatedMinutes, 5, 180, Math.max(10, Math.ceil(kept.length * 1.5))),
      questions: kept,
      dropped: Math.max(0, rawQuestions.length - kept.length),
    },
  };
}

// ── Exam prep content (topics + notes -> guide, flashcards, quiz) ─────────────────

export const EXAM_CONTENT_LIMITS = { expansions: 60, keyPoints: 8, concepts: 40, definitions: 60, flashcards: 60, questions: 40 } as const;

export interface ExamContentOutput {
  topicExpansions: Array<{ title: string; explanation: string; keyPoints: string[]; commonMistakes: string }>;
  keyConcepts: string[];
  bigPictureSummary: string;
  importantDefinitions: Array<{ term: string; definition: string }>;
  flashcards: Array<{ front: string; back: string }>;
  practiceQuestions: Array<{ question: string; answer: string }>;
}

export const EXAM_CONTENT_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "trajectory_exam_content",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topicExpansions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              explanation: { type: "string" },
              keyPoints: { type: "array", items: { type: "string" } },
              commonMistakes: { type: "string" },
            },
            required: ["title", "explanation", "keyPoints", "commonMistakes"],
          },
        },
        keyConcepts: { type: "array", items: { type: "string" } },
        bigPictureSummary: { type: "string" },
        importantDefinitions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { term: { type: "string" }, definition: { type: "string" } },
            required: ["term", "definition"],
          },
        },
        flashcards: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { front: { type: "string" }, back: { type: "string" } },
            required: ["front", "back"],
          },
        },
        practiceQuestions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { question: { type: "string" }, answer: { type: "string" } },
            required: ["question", "answer"],
          },
        },
      },
      required: ["topicExpansions", "keyConcepts", "bigPictureSummary", "importantDefinitions", "flashcards", "practiceQuestions"],
    },
  },
};

function pairs<A extends string, B extends string>(value: unknown, a: A, b: B, max: number, maxA: number, maxB: number, allowed: string) {
  const out: Array<Record<A | B, string>> = [];
  const seen = new Set<string>();
  for (const candidate of asArray(value)) {
    const r = asRecord(candidate);
    if (!r) continue;
    const first = sanitizeModelText(r[a], maxA, allowed);
    const second = sanitizeModelText(r[b], maxB, allowed);
    const key = first.toLowerCase();
    if (!first || !second || seen.has(key)) continue;
    seen.add(key);
    out.push({ [a]: first, [b]: second } as Record<A | B, string>);
    if (out.length >= max) break;
  }
  return out;
}

export function parseExamContentResponse(content: unknown, opts: { sourceText?: string } = {}): ParseResult<ExamContentOutput> {
  const source = opts.sourceText ?? "";
  const root = parseJsonObject(content);
  if (!root) return fail("The reply was not a JSON object.");

  const topicExpansions: ExamContentOutput["topicExpansions"] = [];
  const seenTitles = new Set<string>();
  for (const candidate of asArray(root.topicExpansions)) {
    const e = asRecord(candidate);
    if (!e) continue;
    const title = sanitizeModelText(e.title, 200, source);
    const explanation = sanitizeModelText(e.explanation, 900, source);
    if (!title || !explanation || seenTitles.has(title.toLowerCase())) continue;
    seenTitles.add(title.toLowerCase());
    topicExpansions.push({
      title,
      explanation,
      keyPoints: textList(e.keyPoints, EXAM_CONTENT_LIMITS.keyPoints, 300, source),
      commonMistakes: sanitizeModelText(e.commonMistakes, 500, source),
    });
    if (topicExpansions.length >= EXAM_CONTENT_LIMITS.expansions) break;
  }

  const value: ExamContentOutput = {
    topicExpansions,
    keyConcepts: textList(root.keyConcepts, EXAM_CONTENT_LIMITS.concepts, 120, source),
    bigPictureSummary: sanitizeModelText(root.bigPictureSummary, 2000, source),
    importantDefinitions: pairs(root.importantDefinitions, "term", "definition", EXAM_CONTENT_LIMITS.definitions, 160, 600, source),
    flashcards: pairs(root.flashcards, "front", "back", EXAM_CONTENT_LIMITS.flashcards, 400, 800, source),
    practiceQuestions: pairs(root.practiceQuestions, "question", "answer", EXAM_CONTENT_LIMITS.questions, 500, 1000, source),
  };

  const hasStudyable = value.flashcards.length > 0 || value.practiceQuestions.length > 0;
  const items = value.topicExpansions.length + value.importantDefinitions.length + value.flashcards.length + value.practiceQuestions.length;
  if (!hasStudyable || items < 3) return fail("The study guide had too little content.");
  return { ok: true, warnings: [], value };
}

// ── Test review (photo of a graded test) ─────────────────────────────────

export const TEST_REVIEW_LIMITS = { mistakes: 25, concepts: 15, problems: 12 } as const;

export type GradedStatus = "graded" | "ungraded" | "unreadable";

export interface TestReviewOutput {
  gradedStatus: GradedStatus;
  courseTitle: string;
  score: string;
  mistakes: Array<{ questionNumber: string; studentAnswer: string; correctAnswer: string; explanation: string; concept: string }>;
  conceptsToReview: string[];
  practiceProblems: Array<{ question: string; answer: string; concept: string }>;
  encouragement: string;
}

export const TEST_REVIEW_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "trajectory_test_review",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        gradedStatus: { type: "string", enum: ["graded", "ungraded", "unreadable"] },
        courseTitle: { type: "string" },
        score: { type: "string" },
        mistakes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              questionNumber: { type: "string" },
              studentAnswer: { type: "string" },
              correctAnswer: { type: "string" },
              explanation: { type: "string" },
              concept: { type: "string" },
            },
            required: ["questionNumber", "studentAnswer", "correctAnswer", "explanation", "concept"],
          },
        },
        conceptsToReview: { type: "array", items: { type: "string" } },
        practiceProblems: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { question: { type: "string" }, answer: { type: "string" }, concept: { type: "string" } },
            required: ["question", "answer", "concept"],
          },
        },
        encouragement: { type: "string" },
      },
      required: ["gradedStatus", "courseTitle", "score", "mistakes", "conceptsToReview", "practiceProblems", "encouragement"],
    },
  },
};

export const UNGRADED_TEST_MESSAGE =
  "This test doesn't look graded yet, so there are no marked mistakes to review. Trajectory explains work your teacher has already graded; it won't answer questions on a test you haven't been graded on.";
export const UNREADABLE_TEST_MESSAGE =
  "The photo wasn't clear enough to read the marks. Try again with better light, the whole page in frame, and no glare.";

export function parseTestReviewResponse(
  content: unknown,
  opts: { fallbackTitle?: string; userText?: string } = {},
): ParseResult<TestReviewOutput> {
  const source = opts.userText ?? "";
  const root = parseJsonObject(content);
  if (!root) return fail("The reply was not a JSON object.");

  const statusRaw = typeof root.gradedStatus === "string" ? root.gradedStatus.trim().toLowerCase() : "graded";
  const gradedStatus: GradedStatus = statusRaw === "ungraded" || statusRaw === "unreadable" ? statusRaw : "graded";
  const courseTitle = sanitizeModelText(root.courseTitle, 120, source) || sanitizeModelText(opts.fallbackTitle, 120) || "Test Review";

  // A test that is not graded (or cannot be read) gets NO answers: the tool reviews graded work, it is not an answer solver.
  if (gradedStatus !== "graded") {
    return {
      ok: true,
      warnings: [],
      value: {
        gradedStatus,
        courseTitle,
        score: "",
        mistakes: [],
        conceptsToReview: [],
        practiceProblems: [],
        encouragement: gradedStatus === "ungraded" ? UNGRADED_TEST_MESSAGE : UNREADABLE_TEST_MESSAGE,
      },
    };
  }

  const mistakes: TestReviewOutput["mistakes"] = [];
  for (const candidate of asArray(root.mistakes)) {
    const m = asRecord(candidate);
    if (!m) continue;
    const explanation = sanitizeModelText(m.explanation, 1200, source);
    const correctAnswer = sanitizeModelText(m.correctAnswer, 600, source);
    if (!explanation && !correctAnswer) continue;
    mistakes.push({
      questionNumber: sanitizeModelText(m.questionNumber, 20, source) || String(mistakes.length + 1),
      studentAnswer: sanitizeModelText(m.studentAnswer, 600, source),
      correctAnswer,
      explanation,
      concept: sanitizeModelText(m.concept, 160, source) || "General",
    });
    if (mistakes.length >= TEST_REVIEW_LIMITS.mistakes) break;
  }

  const practiceProblems: TestReviewOutput["practiceProblems"] = [];
  const seenProblems = new Set<string>();
  for (const candidate of asArray(root.practiceProblems ?? root.practiceProblem)) {
    const p = asRecord(candidate);
    if (!p) continue;
    const question = sanitizeModelText(p.question, 600, source);
    const answer = sanitizeModelText(p.answer, 1200, source);
    if (!question || !answer || seenProblems.has(question.toLowerCase())) continue;
    seenProblems.add(question.toLowerCase());
    practiceProblems.push({ question, answer, concept: sanitizeModelText(p.concept, 160, source) || "General" });
    if (practiceProblems.length >= TEST_REVIEW_LIMITS.problems) break;
  }

  const conceptsToReview = textList(root.conceptsToReview, TEST_REVIEW_LIMITS.concepts, 160, source);
  const score = sanitizeModelText(root.score, 30, source);
  // Nothing at all (not even a visible score) is a failed reply: the model probably did not look at the pages.
  // A perfect paper legitimately has no mistakes, but it does show a score.
  if (mistakes.length === 0 && conceptsToReview.length === 0 && practiceProblems.length === 0 && !score) {
    return fail("The review had no mistakes, concepts, problems or score.");
  }

  return {
    ok: true,
    warnings: [],
    value: {
      gradedStatus,
      courseTitle,
      score,
      mistakes,
      conceptsToReview,
      practiceProblems,
      encouragement: sanitizeModelText(root.encouragement, 400, source) || "Keep going - every mistake is a chance to learn something.",
    },
  };
}
