/**
 * Practice-exam answer contract and scoring (pure).
 *
 * THE CONTRACT for a multiple-choice question is `options` (exactly 4 plain texts) + `answerIndex`
 * (0-3). The server prompt asks for it, the server validates it (lib/study-parsers.ts), and this module
 * scores by INDEX only. Exams saved before the contract existed (`answer` = "B", "B)", "B) text" or the
 * option text itself, options carrying "A) " prefixes) are mapped onto an index by `resolveAnswer`, so
 * old saves score correctly instead of always being marked wrong.
 *
 * A question whose answer key cannot be resolved is "ungradable": it is left out of the score and the
 * UI says so; it is never silently marked wrong.
 *
 * Options can be shown in a shuffled order; the student's pick is always recorded as the ORIGINAL
 * option index, so shuffling can never change what is correct.
 */
import type { PracticeQuestion } from "./types";

export type QuestionLike = Pick<PracticeQuestion, "type" | "answer"> & {
  options?: unknown;
  answerIndex?: unknown;
};

export type ResolvedAnswer =
  | {
      kind: "choice";
      /** The answer key's option. */
      index: number;
      /** Every option that counts as correct (same text as the key: duplicate options can't cost points). */
      indexes: number[];
      source: "answerIndex" | "text" | "letter";
    }
  | { kind: "boolean"; value: boolean }
  | { kind: "self" }
  | { kind: "unknown"; reason: string };

const LETTER_PREFIX = /^\(?([A-Za-z])[).:]\s+/;

/** "A) Foo" / "b. Foo" / "(C) Foo" -> "Foo". Text without a letter prefix is returned trimmed. */
export function stripOptionPrefix(option: string): string {
  return option.replace(LETTER_PREFIX, "").trim();
}

/** Lower-cases, collapses whitespace and drops trailing punctuation so "Foo." and "foo" compare equal. */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/g, "").trim();
}

export function optionLabel(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : "?";
}

function optionList(question: QuestionLike): string[] | null {
  if (!Array.isArray(question.options)) return null;
  const options = question.options as unknown[];
  if (options.length < 2 || options.length > 8) return null;
  if (!options.every((o) => typeof o === "string" && o.trim().length > 0)) return null;
  return options as string[];
}

/** Every index whose text equals the text at `index` (raw or prefix-stripped, ignoring case/spacing). */
function sameTextIndexes(options: string[], index: number): number[] {
  const raw = normalizeText(options[index]!);
  const stripped = normalizeText(stripOptionPrefix(options[index]!));
  return options
    .map((option, i) => ({ i, raw: normalizeText(option), stripped: normalizeText(stripOptionPrefix(option)) }))
    .filter((o) => o.raw === raw || o.stripped === stripped)
    .map((o) => o.i);
}

function findByText(options: string[], text: string): number[] {
  const wantRaw = normalizeText(text);
  const wantStripped = normalizeText(stripOptionPrefix(text));
  if (!wantRaw) return [];
  const exact = options.map((o, i) => (normalizeText(o) === wantRaw ? i : -1)).filter((i) => i >= 0);
  if (exact.length > 0) return exact;
  return options
    .map((o, i) => (normalizeText(stripOptionPrefix(o)) === wantStripped ? i : -1))
    .filter((i) => i >= 0);
}

export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (v === "true" || v === "t") return true;
  if (v === "false" || v === "f") return false;
  return null;
}

/** Maps a question's answer key to something scorable. Never throws. */
export function resolveAnswer(question: QuestionLike): ResolvedAnswer {
  if (question.type === "short_answer") return { kind: "self" };

  if (question.type === "true_false") {
    const value = parseBoolean(question.answer);
    return value === null ? { kind: "unknown", reason: "The answer key isn't True or False." } : { kind: "boolean", value };
  }

  if (question.type !== "multiple_choice") return { kind: "unknown", reason: "Unknown question type." };

  const options = optionList(question);
  if (!options) return { kind: "unknown", reason: "This question doesn't have usable answer choices." };

  // 1. The contract: answerIndex.
  const declared = question.answerIndex;
  if (typeof declared === "number" && Number.isInteger(declared) && declared >= 0 && declared < options.length) {
    return { kind: "choice", index: declared, indexes: sameTextIndexes(options, declared), source: "answerIndex" };
  }

  // 2. Legacy: `answer` is the option text, or a letter, or "B) text".
  const answer = typeof question.answer === "string" ? question.answer.trim() : "";
  if (!answer) return { kind: "unknown", reason: "This question has no answer key." };

  const byText = findByText(options, answer);
  if (byText.length > 0) return { kind: "choice", index: byText[0]!, indexes: sameTextIndexes(options, byText[0]!), source: "text" };

  const bareLetter = /^\(?([A-Za-z])\)?[).:]?$/.exec(answer);
  if (bareLetter) {
    const index = bareLetter[1]!.toUpperCase().charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) {
      return { kind: "choice", index, indexes: sameTextIndexes(options, index), source: "letter" };
    }
    return { kind: "unknown", reason: "The answer key points at a choice that doesn't exist." };
  }

  const letterAndText = /^\(?([A-Za-z])[).:]\s+(.+)$/.exec(answer);
  if (letterAndText) {
    const textMatches = findByText(options, letterAndText[2]!);
    if (textMatches.length > 0) {
      return { kind: "choice", index: textMatches[0]!, indexes: sameTextIndexes(options, textMatches[0]!), source: "text" };
    }
    const index = letterAndText[1]!.toUpperCase().charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) {
      return { kind: "choice", index, indexes: sameTextIndexes(options, index), source: "letter" };
    }
  }

  return { kind: "unknown", reason: "The answer key doesn't match any of the choices." };
}

export function isGradable(question: QuestionLike): boolean {
  return resolveAnswer(question).kind !== "unknown";
}

/** The student's answer to one question. `selectedIndex` is an ORIGINAL option index, never a display position. */
export interface QuestionResponse {
  selectedIndex?: number;
  selectedBoolean?: boolean;
  /** Short answer: the student's own verdict after seeing the model answer. */
  selfRating?: "got_it" | "missed";
}

/** True / false for a submitted MC or true/false answer; null when it cannot be graded. */
export function gradeResponse(question: QuestionLike, response: QuestionResponse | undefined): boolean | null {
  const key = resolveAnswer(question);
  if (key.kind === "unknown" || key.kind === "self" || !response) return null;
  if (key.kind === "boolean") {
    return typeof response.selectedBoolean === "boolean" ? response.selectedBoolean === key.value : null;
  }
  if (typeof response.selectedIndex !== "number") return null;
  return key.indexes.includes(response.selectedIndex);
}

/** "B) Photosynthesis", "True", or the model answer, for showing the correct answer. */
export function correctAnswerText(question: QuestionLike): string {
  const key = resolveAnswer(question);
  if (key.kind === "choice") {
    const options = question.options as string[];
    return `${optionLabel(key.index)}) ${stripOptionPrefix(options[key.index]!)}`;
  }
  if (key.kind === "boolean") return key.value ? "True" : "False";
  const raw = typeof question.answer === "string" ? question.answer.trim() : "";
  return raw || "Not available";
}

/** Just the text of the correct option (no letter), for screens that show options in a shuffled order. */
export function correctChoiceText(question: QuestionLike): string | null {
  const key = resolveAnswer(question);
  if (key.kind !== "choice") return null;
  return stripOptionPrefix((question.options as string[])[key.index]!);
}

/** Plain text of one option for display (prefix removed; the letter badge is drawn separately). */
export function optionDisplayText(option: string): string {
  return stripOptionPrefix(option);
}

// ── Shuffling ───────────────────────────────────────────────────────────

export function identityOrder(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i);
}

/** Fisher-Yates permutation of 0..count-1; `random` is injectable for tests. */
export function shuffledOrder(count: number, random: () => number = Math.random): number[] {
  const order = identityOrder(count);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

// ── Whole-exam score ─────────────────────────────────────────────────

export type QuestionStatus = "correct" | "incorrect" | "unanswered" | "ungradable";

export interface ExamScore {
  perQuestion: Array<{ status: QuestionStatus; graded: "auto" | "self" | "none" }>;
  /** Multiple choice + true/false, graded by the app. */
  autoCorrect: number;
  autoTotal: number;
  /** Short answer, graded by the student. */
  selfCorrect: number;
  selfTotal: number;
  unanswered: number;
  ungradable: number;
  correct: number;
  /** Questions that count toward the percentage (everything except ungradable ones). */
  gradedTotal: number;
  /** null when nothing is gradable. */
  percent: number | null;
  letter: string | null;
}

export function letterGrade(percent: number): string {
  return percent >= 90 ? "A" : percent >= 80 ? "B" : percent >= 70 ? "C" : percent >= 60 ? "D" : "F";
}

export function scoreExam(
  questions: readonly QuestionLike[],
  responses: ReadonlyArray<QuestionResponse | undefined> | Record<number, QuestionResponse | undefined>,
): ExamScore {
  const at = (i: number): QuestionResponse | undefined => (Array.isArray(responses) ? responses[i] : (responses as Record<number, QuestionResponse | undefined>)[i]);
  const perQuestion: ExamScore["perQuestion"] = [];
  let autoCorrect = 0;
  let autoTotal = 0;
  let selfCorrect = 0;
  let selfTotal = 0;
  let unanswered = 0;
  let ungradable = 0;

  questions.forEach((question, i) => {
    const key = resolveAnswer(question);
    const response = at(i);
    if (key.kind === "unknown") {
      ungradable++;
      perQuestion.push({ status: "ungradable", graded: "none" });
      return;
    }
    if (key.kind === "self") {
      selfTotal++;
      if (response?.selfRating === "got_it") {
        selfCorrect++;
        perQuestion.push({ status: "correct", graded: "self" });
      } else if (response?.selfRating === "missed") {
        perQuestion.push({ status: "incorrect", graded: "self" });
      } else {
        unanswered++;
        perQuestion.push({ status: "unanswered", graded: "self" });
      }
      return;
    }
    autoTotal++;
    const result = gradeResponse(question, response);
    if (result === null) {
      unanswered++;
      perQuestion.push({ status: "unanswered", graded: "auto" });
    } else if (result) {
      autoCorrect++;
      perQuestion.push({ status: "correct", graded: "auto" });
    } else {
      perQuestion.push({ status: "incorrect", graded: "auto" });
    }
  });

  const gradedTotal = autoTotal + selfTotal;
  const correct = autoCorrect + selfCorrect;
  const percent = gradedTotal > 0 ? Math.round((correct / gradedTotal) * 100) : null;
  return {
    perQuestion,
    autoCorrect,
    autoTotal,
    selfCorrect,
    selfTotal,
    unanswered,
    ungradable,
    correct,
    gradedTotal,
    percent,
    letter: percent === null ? null : letterGrade(percent),
  };
}
