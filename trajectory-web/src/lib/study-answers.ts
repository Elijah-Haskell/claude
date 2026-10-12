/**
 * What the study tools' AI procedures answer (server/study-ai.ts), narrowed from the `unknown` src/lib/api.ts gives
 * them: each answer is read again through the engine's own parsers (src/engine/study-parsers.ts), the same ones the
 * server validated with, so nothing half-empty or off-shape is ever saved as AI content. Pure: the network calls that
 * use these are in src/lib/study-api.ts, and tests/web/study-answers.test.ts covers this file.
 */
import {
  parseExamContentResponse,
  parsePracticeExamResponse,
  parseStudyGuideResponse,
  parseTestReviewResponse,
  type ExamContentOutput,
  type ParseResult,
  type PracticeExamOutput,
  type StudyGuideOutput,
  type TestReviewOutput,
} from "../engine/study-parsers";
import { EXAM_MATERIAL_CHAR_LIMIT, prepareStudyText } from "../engine/study-text";

/** ai.analyzeSyllabus (server/study-ai.ts generateStudyGuide). */
export type StudyGuideAnswer = StudyGuideOutput;
/** ai.generatePracticeExam (generatePracticeExam). */
export type PracticeExamAnswer = PracticeExamOutput;
/** ai.generateExamContent (generateExamStudyContent): the content plus how much of the pasted material was read. */
export interface ExamContentAnswer extends ExamContentOutput {
  /** The pasted material was longer than the model limit and only its beginning was used. */
  inputTruncated: boolean;
  inputChars: number;
  usedChars: number;
}
/** ai.reviewTest (reviewGradedTest). */
export type TestReviewAnswer = TestReviewOutput;

/** The sentences the server says when a reply is unusable (server/study-ai.ts), said here too when the answer fails validation. */
export const STUDY_ANSWER_FAILURE = {
  studyGuide: "We couldn't build a study guide from this text. Check that it is the syllabus or course outline, then try again.",
  practiceExam: "We couldn't generate a usable practice exam. Please try again.",
  examContent: "We couldn't build study materials for this exam. Please try again in a moment.",
  testReview: "We couldn't read that test. Try again with clearer, well-lit photos of each page.",
} as const;

/** An answer the parsers refused. Its message is the plain sentence the student sees (lib/study-errors.ts keeps it). */
export class StudyAnswerError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "StudyAnswerError";
    this.reason = reason;
  }
}

/** The answer as the text the parsers read: tRPC hands an object; an older server (or a test) may hand text. */
export function answerText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function settle<T>(parsed: ParseResult<T>, failure: string): T {
  if (parsed.ok) return parsed.value;
  throw new StudyAnswerError(failure, parsed.reason);
}

export function parseStudyGuideAnswer(output: unknown, input: { syllabusText: string; courseName?: string }): StudyGuideAnswer {
  return settle(parseStudyGuideResponse(answerText(output), { fallbackTitle: input.courseName, sourceText: input.syllabusText }), STUDY_ANSWER_FAILURE.studyGuide);
}

export function parsePracticeExamAnswer(output: unknown, input: { syllabusText: string; courseName?: string; questionCount: number; focusTopics?: string[] }): PracticeExamAnswer {
  return settle(
    parsePracticeExamResponse(answerText(output), {
      requestedCount: input.questionCount,
      fallbackTitle: input.courseName,
      sourceText: `${input.syllabusText}\n${(input.focusTopics ?? []).join("\n")}`,
    }),
    STUDY_ANSWER_FAILURE.practiceExam,
  );
}

export function parseExamContentAnswer(output: unknown, input: { topics: string[]; rawInput?: string }): ExamContentAnswer {
  // The same source text the server allows URLs from: the topics and the material as far as the model read it.
  const material = prepareStudyText(input.rawInput ?? "", EXAM_MATERIAL_CHAR_LIMIT);
  const topics = input.topics.filter((topic) => topic.trim());
  const content = settle(parseExamContentResponse(answerText(output), { sourceText: `${topics.join("\n")}\n${material.text}` }), STUDY_ANSWER_FAILURE.examContent);
  const extra = output && typeof output === "object" ? (output as { inputTruncated?: unknown; inputChars?: unknown; usedChars?: unknown }) : {};
  const count = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback);
  return {
    ...content,
    inputTruncated: typeof extra.inputTruncated === "boolean" ? extra.inputTruncated : material.truncated,
    inputChars: count(extra.inputChars, material.originalChars),
    usedChars: count(extra.usedChars, material.usedChars),
  };
}

export function parseTestReviewAnswer(output: unknown, input: { courseName?: string; userQuestion?: string }): TestReviewAnswer {
  return settle(
    parseTestReviewResponse(answerText(output), { fallbackTitle: input.courseName, userText: `${input.courseName ?? ""}\n${input.userQuestion ?? ""}` }),
    STUDY_ANSWER_FAILURE.testReview,
  );
}
