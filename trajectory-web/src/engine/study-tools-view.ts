/**
 * What the study tools say, as pure functions: the list of study guides and the sheet that builds a new one
 * (app/study-guides.tsx), the practice list (app/practice.tsx), one study guide (app/study-guide.tsx), a practice
 * exam and its result (app/practice-exam.tsx), and a test review (app/test-review.tsx).
 *
 * The rules themselves live where they always did (lib/study-guides.ts, lib/study-source.ts, lib/study-hub.ts,
 * lib/practice-exam-scoring.ts, lib/study-images.ts); this file turns their results into the words on the screen.
 */
import { optionDisplayText, optionLabel, resolveAnswer, type ExamScore, type QuestionLike, type QuestionResponse, type QuestionStatus } from "./practice-exam-scoring";
import { sortGuidesNewestFirst, STUDY_SOURCE_KIND_LABEL } from "./study-guides";
import type { PracticeEntry } from "./study-hub";
import { MAX_REVIEW_IMAGES, MAX_UPLOAD_BYTES } from "./study-images";
import { describeGuideSource, type StudySource } from "./study-source";
import { formatCount } from "./study-text";
import type { PracticeQuestion, SyllabusImport, SyllabusPracticeExam, SyllabusStudyGuide, SyllabusTopic } from "./types";
import { parseLocalDate } from "./utils";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** "Sep 28" for a saved time or a date key; "" when it cannot be read. */
export function shortDay(value: string | null | undefined): string {
  if (!value) return "";
  const date = DATE_KEY.test(value) ? parseLocalDate(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The class a name belongs to: the same name, whatever its capitals or the spaces around it. */
export function classByName<T extends { name: string }>(name: string | null | undefined, classes: readonly T[]): T | undefined {
  const wanted = (name ?? "").trim().toLowerCase();
  return wanted ? classes.find((cls) => cls.name.trim().toLowerCase() === wanted) : undefined;
}

// ── Study guides: the list ───────────────────────────────────────────────────

export const STUDY_GUIDES_HEAD = {
  eyebrow: "Study tools",
  title: "Study guide",
  sub: "Topics and key terms, made from a syllabus or from notes you paste.",
} as const;

export const STUDY_GUIDES_EMPTY = {
  title: "No study guides yet",
  body: "Make one from a syllabus you have added, or from text you paste.",
} as const;

export interface GuideRow {
  id: string;
  title: string;
  /** "12 topics · practice exam · Sep 28 · partial syllabus" */
  line: string;
  hasPracticeExam: boolean;
}

/** A guide's line in the list: how many topics, whether it has a practice exam, when it was made, and whether only part of a long syllabus was used. */
export function guideRowLine(guide: Pick<SyllabusStudyGuide, "topics" | "createdAt" | "sourceTruncated">, hasPracticeExam: boolean): string {
  const topics = Array.isArray(guide.topics) ? guide.topics.length : 0;
  return [count(topics, "topic"), hasPracticeExam ? "practice exam" : "", shortDay(guide.createdAt), guide.sourceTruncated ? "partial syllabus" : ""].filter(Boolean).join(" · ");
}

/** Every saved study guide, newest first, as the rows of the list. */
export function guideRows(guides: readonly SyllabusStudyGuide[] | undefined | null, practiceExams: readonly Pick<SyllabusPracticeExam, "studyGuideId">[] | undefined | null): GuideRow[] {
  const withPractice = new Set((Array.isArray(practiceExams) ? practiceExams : []).map((exam) => exam.studyGuideId));
  return sortGuidesNewestFirst(guides).map((guide) => {
    const hasPracticeExam = withPractice.has(guide.id);
    return { id: guide.id, title: guide.courseTitle, line: guideRowLine(guide, hasPracticeExam), hasPracticeExam };
  });
}

// ── Study guides: the sheet that builds a new one ────────────────────────────

export type GuideMode = "imported" | "paste";

export interface SourceRow {
  id: string;
  title: string;
  /** "Added Aug 23", "Added Aug 23 · deadline list only", "You already have a study guide for it" */
  line: string;
  /** False for an import that holds nothing to build from. */
  selectable: boolean;
  /** The guide already made from this syllabus (the newest), when there is one. */
  existingGuideId: string | null;
}

/** The radio rows under "Which syllabus?". `guides` newest first, so the guide offered is the newest one. */
export function sourceRows(sources: readonly StudySource[], guides: readonly Pick<SyllabusStudyGuide, "id" | "sourceImportId">[]): SourceRow[] {
  return sources.map((source) => {
    const added = shortDay(source.importedAt);
    const existingGuideId = guides.find((guide) => guide.sourceImportId === source.id)?.id ?? null;
    const selectable = source.kind !== "none";
    // "Added Aug 23 · deadline list only", or just "Deadline list only" for an import with no readable date.
    const dated = (tail: string) => (added ? `Added ${added} · ${tail}` : `${tail.charAt(0).toUpperCase()}${tail.slice(1)}`);
    const line = !selectable
      ? dated("nothing to build from")
      : existingGuideId
        ? "You already have a study guide for it"
        : source.kind === "deadlines_only"
          ? dated("deadline list only")
          : added
            ? `Added ${added}`
            : STUDY_SOURCE_KIND_LABEL.syllabus_text;
    return { id: source.id, title: source.title, line, selectable, existingGuideId };
  });
}

/**
 * The syllabus that is chosen before the student has chosen: the only one there is to choose. With two or more,
 * none is, and the button says "Choose a syllabus" until one is tapped.
 */
export function soleSourceId(rows: readonly SourceRow[]): string | null {
  const selectable = rows.filter((row) => row.selectable);
  return selectable.length === 1 ? selectable[0]!.id : null;
}

/** The syllabus in effect: the student's choice while it can still be chosen, else the only one there is. */
export function chosenSourceId(rows: readonly SourceRow[], picked: string | null): string | null {
  return picked && rows.some((row) => row.id === picked && row.selectable) ? picked : soleSourceId(rows);
}

/** What still stands between the student and "Build study guide", in the words shown over the button; null when nothing does. */
export function guideBuildBlocker(input: { mode: GuideMode; sourceChosen: boolean; pastedChars: number; pastedUsable: boolean }): string | null {
  if (input.mode === "imported") return input.sourceChosen ? null : "Choose a syllabus";
  if (input.pastedChars <= 0) return "Paste the text first";
  return input.pastedUsable ? null : "Paste a little more text so there is something to build from.";
}

/** Under the paste box. */
export function pastedCountLine(chars: number): string {
  return `${formatCount(chars)} ${chars === 1 ? "character" : "characters"}`;
}

/** Shown in the sheet when no imported syllabus can be built from: none yet, or none whose text was kept. */
export function noSyllabusCopy(importedCount: number): { title: string; body: string } {
  return importedCount === 0
    ? { title: "No syllabus imported yet", body: "Upload your syllabus once and Trajectory plans your semester. It can also build study materials from it." }
    : { title: "Your imported syllabus has no text to study from", body: "Import it again to keep its text, or paste the text below." };
}

export const GUIDE_SHEET_COPY = {
  title: "New study guide",
  fromSyllabus: "From a syllabus",
  paste: "Paste text",
  which: "Which syllabus?",
  pasteLabel: "Syllabus or course outline",
  courseName: "Course name · optional",
  build: "Build study guide",
  building: "Reading your syllabus",
  wait: "This usually takes 15-30 seconds.",
  existing: "You already have a study guide from this syllabus. Open it, or generate a fresh one below.",
  upload: "Upload your syllabus",
  uploadSub: "PDF, Word, photos or pasted text",
} as const;

// ── Practice: the list ───────────────────────────────────────────────────────

export const PRACTICE_HEAD = {
  eyebrow: "Study tools",
  title: "Practice exam",
  sub: "Built from a study guide, to test yourself first.",
} as const;

export const PRACTICE_EMPTY = {
  title: "No practice yet",
  body: "Build a study guide from your syllabus to generate a practice exam. Each exam's AI study guide also comes with a practice quiz.",
  action: "Build a study guide",
} as const;

/** "Practice exam · 15 questions · ~20 min" or "Exam quiz · 12 questions · exam Oct 3". */
export function practiceRowLine(entry: PracticeEntry): string {
  if (entry.kind === "practice_exam") {
    return ["Practice exam", count(entry.questionCount, "question"), entry.estimatedMinutes > 0 ? `~${entry.estimatedMinutes} min` : ""].filter(Boolean).join(" · ");
  }
  return ["Exam quiz", count(entry.questionCount, "question"), `exam ${shortDay(entry.examDate) || entry.examDate}`].join(" · ");
}

// ── One study guide ──────────────────────────────────────────────────────────

export type ImportanceFilter = "all" | SyllabusTopic["importance"];

const IMPORTANCE_LABEL: Record<ImportanceFilter, string> = { all: "All", high: "High", medium: "Medium", low: "Low" };

export function importanceCounts(topics: readonly Pick<SyllabusTopic, "importance">[]): Record<ImportanceFilter, number> {
  const of = (importance: SyllabusTopic["importance"]) => topics.filter((topic) => topic.importance === importance).length;
  return { all: topics.length, high: of("high"), medium: of("medium"), low: of("low") };
}

/** The switch over the topics: "All 9", "High 3", "Medium 4", "Low 2". */
export function importanceOptions(topics: readonly Pick<SyllabusTopic, "importance">[]): { value: ImportanceFilter; label: string; accessibilityLabel: string }[] {
  const counts = importanceCounts(topics);
  return (["all", "high", "medium", "low"] as const).map((value) => ({
    value,
    label: `${IMPORTANCE_LABEL[value]} ${counts[value]}`,
    accessibilityLabel: value === "all" ? `All ${count(counts.all, "topic")}` : `${IMPORTANCE_LABEL[value]} importance, ${count(counts[value], "topic")}`,
  }));
}

/** The topics a filter shows, each with its place in the whole guide (what is open is remembered by that). */
export function topicsFor<T extends Pick<SyllabusTopic, "importance">>(topics: readonly T[], filter: ImportanceFilter): { topic: T; index: number }[] {
  return topics.map((topic, index) => ({ topic, index })).filter(({ topic }) => filter === "all" || topic.importance === filter);
}

/** A topic's tag. High is the one that stands out. */
export function importanceTag(importance: SyllabusTopic["importance"]): { label: string; strong: boolean } {
  return { label: IMPORTANCE_LABEL[importance] ?? "Low", strong: importance === "high" };
}

/** The quiet line under a guide's title: what it was built from, and the exam date found in it. */
export function guideMetaLine(guide: Pick<SyllabusStudyGuide, "sourceKind" | "sourceTruncated" | "syllabusFileName" | "examDate">): string {
  const source = describeGuideSource(guide);
  const day = guide.examDate ? shortDay(guide.examDate) || guide.examDate : "";
  const exam = day ? (source ? `Exam in it on ${day}.` : `Exam in the syllabus on ${day}.`) : "";
  return [source, exam].filter(Boolean).join(" ");
}

/**
 * The class a guide is for, when that is known: the class its syllabus was imported into, else the class with the
 * guide's own course name.
 */
export function guideClass<T extends { id: string; name: string }>(
  guide: Pick<SyllabusStudyGuide, "sourceImportId" | "courseName" | "courseTitle">,
  classes: readonly T[],
  imports: readonly Pick<SyllabusImport, "id" | "linkedClassId">[] | undefined | null,
): T | undefined {
  const linked = guide.sourceImportId ? (Array.isArray(imports) ? imports : []).find((imp) => imp.id === guide.sourceImportId)?.linkedClassId : undefined;
  return (linked ? classes.find((cls) => cls.id === linked) : undefined) ?? classByName(guide.courseName, classes) ?? classByName(guide.courseTitle, classes);
}

/** How many questions a new practice exam is asked for. */
export const PRACTICE_EXAM_QUESTIONS = 15;

/** The topics a new practice exam leans on: the guide's high-importance ones (at most 20 names are sent). */
export function practiceFocusTopics(topics: readonly Pick<SyllabusTopic, "title" | "importance">[]): string[] {
  return topics.filter((topic) => topic.importance === "high").map((topic) => topic.title).slice(0, 20);
}

/** The button at the bottom of a study guide, and the one line shown while a practice exam is being written. */
export function guidePracticeAction(hasPracticeExam: boolean, making: boolean): { label: string; wait: string | null } {
  if (hasPracticeExam) return { label: "Take the practice exam", wait: null };
  return { label: "Make a practice exam", wait: making ? "Writing a practice exam from this guide's topics." : null };
}

export const GUIDE_DELETE_COPY = {
  row: "Delete this study guide",
  question: "Delete this study guide? This will also delete any practice exams for this guide.",
} as const;

// ── A practice exam: one question ────────────────────────────────────────────

export const DIFFICULTY_LABEL: Record<PracticeQuestion["difficulty"], string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
export const QUESTION_TYPE_LABEL: Record<PracticeQuestion["type"], string> = { multiple_choice: "Multiple choice", true_false: "True or false", short_answer: "Short answer" };

/** "Question 3 of 15" */
export function questionCounter(index: number, total: number): string {
  return `Question ${index + 1} of ${total}`;
}

/** "Multiple choice · Integration by parts" */
export function questionMetaLine(question: Pick<PracticeQuestion, "type" | "topic">): string {
  return [QUESTION_TYPE_LABEL[question.type] ?? "Question", (question.topic ?? "").trim()].filter(Boolean).join(" · ");
}

export interface QuestionStep {
  /** What the main button does. */
  action: "submit" | "next";
  label: "Submit" | "Next question" | "See results";
  enabled: boolean;
  /** Why the button is off, in the words shown over it. */
  reason: string | null;
}

/**
 * The main button under a question. A choice is submitted before moving on; a short answer is marked by the
 * student before moving on; a question with no usable answer key is passed over (it is not scored).
 */
export function questionStep(input: { type: PracticeQuestion["type"]; gradable: boolean; submitted: boolean; hasChoice: boolean; isLast: boolean }): QuestionStep {
  const next = input.isLast ? "See results" : "Next question";
  if (input.type === "short_answer") return { action: "next", label: next, enabled: input.submitted, reason: input.submitted ? null : "Mark yourself to continue" };
  if (input.gradable && !input.submitted) return { action: "submit", label: "Submit", enabled: input.hasChoice, reason: input.hasChoice ? null : "Choose an answer" };
  return { action: "next", label: next, enabled: true, reason: null };
}

/** The letter an option is shown under ("B"), given the order the options are drawn in; "" when it is not among them. */
export function shownLetter(order: readonly number[], originalIndex: number): string {
  const position = order.indexOf(originalIndex);
  return position >= 0 ? optionLabel(position) : "";
}

/** What the right answer is called on the screen: its letter as drawn, or "True" / "False"; "" when there is no key. */
export function rightAnswerName(question: QuestionLike, order: readonly number[]): string {
  const key = resolveAnswer(question);
  if (key.kind === "boolean") return key.value ? "True" : "False";
  if (key.kind === "choice") return shownLetter(order, key.index);
  return "";
}

/** The first line of the note after Submit: "Correct", or "Incorrect · the answer is B". */
export function feedbackHeadline(question: QuestionLike, correct: boolean, order: readonly number[]): string {
  if (correct) return "Correct";
  const name = rightAnswerName(question, order);
  return name ? `Incorrect · the answer is ${name}` : "Incorrect";
}

export const NOT_SCORED_COPY = {
  title: "Not scored",
  body: "This question has no usable answer key, so it won't count toward your score.",
} as const;

export const SHORT_ANSWER_COPY = {
  hint: "Think about your answer, then show the model answer and mark yourself honestly.",
  show: "Show the model answer",
  gotIt: "I got it",
  missed: "I missed it",
} as const;

/** "You marked this: got it" */
export function selfMarkLine(rating: QuestionResponse["selfRating"]): string {
  return rating === "got_it" ? "You marked this: got it" : rating === "missed" ? "You marked this: missed it" : "";
}

/** One question as plain text (question, options, key, explanation) for the AI content report. */
export function practiceQuestionExcerpt(question: PracticeQuestion): string {
  const options = question.type === "multiple_choice" && Array.isArray(question.options) ? question.options.map((option, i) => `${optionLabel(i)}) ${optionDisplayText(option)}`) : [];
  const key = resolveAnswer(question);
  const answer = key.kind === "choice" ? optionDisplayText((question.options as string[])[key.index]!) : key.kind === "boolean" ? (key.value ? "True" : "False") : question.answer;
  return [question.question, ...options, `Answer: ${answer}`, question.explanation ?? ""].filter(Boolean).join("\n");
}

// ── A practice exam: the result ──────────────────────────────────────────────

export interface ExamResultView {
  /** "11 of 15 correct" */
  headline: string;
  /** "73% of the scored questions · C" */
  sub: string;
  /** 0..1 of the bar; null when nothing could be scored (no bar then). */
  fraction: number | null;
  rows: { title: string; value: string }[];
  /** The questions left out of the score, said in a sentence; null when every question counted. */
  notScored: string | null;
}

export function examResultView(score: ExamScore): ExamResultView {
  const scored = score.percent !== null && score.gradedTotal > 0;
  const rows: ExamResultView["rows"] = [];
  if (score.autoTotal > 0) rows.push({ title: "Multiple choice and true or false", value: `${score.autoCorrect} of ${score.autoTotal}` });
  if (score.selfTotal > 0) rows.push({ title: "Short answer, marked by you", value: `${score.selfCorrect} of ${score.selfTotal}` });
  if (scored) rows.push({ title: "Not answered", value: String(score.unanswered) });
  return {
    headline: scored ? `${score.correct} of ${score.gradedTotal} correct` : "Exam complete",
    sub: scored ? `${score.percent}% of the scored questions · ${score.letter}` : "None of these questions could be scored.",
    fraction: scored ? Math.max(0, Math.min(1, score.percent! / 100)) : null,
    rows,
    notScored: score.ungradable > 0 ? `${count(score.ungradable, "question")} had no usable answer key and ${score.ungradable === 1 ? "was" : "were"} not scored.` : null,
  };
}

export type TagTone = "neutral" | "blue" | "green" | "red" | "gold";

/** A question's outcome as its tag in "Question review". */
export function statusTag(status: QuestionStatus): { label: string; tone: TagTone } {
  if (status === "correct") return { label: "Correct", tone: "green" };
  if (status === "incorrect") return { label: "Incorrect", tone: "red" };
  return { label: status === "unanswered" ? "Not answered" : "Not scored", tone: "neutral" };
}

const REVIEW_TITLE_MAX = 60;

/** A row's title in "Question review": the question's topic, else the start of the question itself. */
export function reviewTitle(question: Pick<PracticeQuestion, "topic" | "question">): string {
  const topic = (question.topic ?? "").trim();
  if (topic) return topic;
  const text = (question.question ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= REVIEW_TITLE_MAX) return text;
  const cut = text.slice(0, REVIEW_TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export interface ReviewDetail {
  /** What the student picked, shown only when it was wrong. */
  yourAnswer: string | null;
  /** The right choice or True / False. */
  correct: string | null;
  /** A short answer's model answer. */
  modelAnswer: string | null;
  explanation: string | null;
}

/** "B) u = x" for a choice as drawn, "True" / "False"; "" when nothing was picked. */
export function pickedAnswerText(question: Pick<PracticeQuestion, "type" | "options">, response: QuestionResponse | undefined, order: readonly number[]): string {
  if (!response) return "";
  if (question.type === "true_false") return typeof response.selectedBoolean === "boolean" ? (response.selectedBoolean ? "True" : "False") : "";
  if (question.type === "multiple_choice" && typeof response.selectedIndex === "number" && Array.isArray(question.options)) {
    const text = question.options[response.selectedIndex];
    if (!text) return "";
    const letter = shownLetter(order, response.selectedIndex);
    return `${letter ? `${letter}) ` : ""}${optionDisplayText(text)}`;
  }
  return "";
}

/** The right answer in words: "B) u = x" for a choice as drawn, "True" / "False"; "" for a short answer or a missing key. */
export function rightAnswerText(question: QuestionLike, order: readonly number[]): string {
  const key = resolveAnswer(question);
  if (key.kind === "boolean") return key.value ? "True" : "False";
  if (key.kind !== "choice") return "";
  const letter = shownLetter(order, key.index);
  return `${letter ? `${letter}) ` : ""}${optionDisplayText((question.options as string[])[key.index]!)}`;
}

/** What an opened row of "Question review" shows. */
export function reviewDetail(question: PracticeQuestion, response: QuestionResponse | undefined, order: readonly number[], status: QuestionStatus): ReviewDetail {
  const short = question.type === "short_answer";
  const picked = short ? "" : pickedAnswerText(question, response, order);
  return {
    yourAnswer: status === "incorrect" && picked ? picked : null,
    correct: short ? null : rightAnswerText(question, order) || null,
    modelAnswer: short && question.answer ? question.answer : null,
    explanation: question.explanation ? question.explanation : null,
  };
}

// ── Test review ──────────────────────────────────────────────────────────────

export const TEST_REVIEW_HEAD = {
  eyebrow: "Study tools",
  title: "Test review",
  sub: "Add photos of a test your teacher has graded. Each marked mistake is explained, with problems to practise.",
} as const;

export const GRADED_ONLY_NOTE = "Graded pages only: a test with no marks isn't reviewed.";

/** "2 of 6" at the end of the "Pages" label. */
export function pagesCountLabel(pages: number): string {
  return `${pages} of ${MAX_REVIEW_IMAGES}`;
}

/** The lines under "Take a photo" and "Choose photos": how many more pages fit, and what a photo may be. */
export function pageOptionLines(slotsLeft: number): { camera: string; photos: string } {
  if (slotsLeft <= 0) return { camera: "Page limit reached", photos: "Page limit reached" };
  const megabytes = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
  return { camera: "Use the camera", photos: `Up to ${slotsLeft} more ${slotsLeft === 1 ? "page" : "pages"} · JPEG or PNG, under ${megabytes} MB each` };
}

/** Said when more photos were picked than pages are left. */
export const EXTRA_PAGES_NOTICE = `Only ${MAX_REVIEW_IMAGES} pages fit in one review, so the extra photos were skipped.`;

export interface ReviewStep {
  label: string;
  enabled: boolean;
  /** A spinner in the button: the review is being written. */
  busy: boolean;
  /** The line over the button: what is missing (gold), or something to know (quiet). */
  reason: string | null;
  reasonTone: "gold" | "quiet";
}

/** "Review my test": off until there is a page that uploaded, with the reason over it. */
export function reviewStep(input: { pages: number; ready: number; uploading: boolean; failed: boolean; reviewing: boolean }): ReviewStep {
  if (input.reviewing) return { label: "Review my test", enabled: false, busy: true, reason: "Reading your pages and writing the review.", reasonTone: "quiet" };
  if (input.uploading) return { label: "Uploading...", enabled: false, busy: false, reason: null, reasonTone: "quiet" };
  if (input.pages <= 0) return { label: "Review my test", enabled: false, busy: false, reason: "Add at least one page", reasonTone: "gold" };
  if (input.ready <= 0) return { label: "Review my test", enabled: false, busy: false, reason: "Fix the failed upload first", reasonTone: "gold" };
  if (input.failed) return { label: "Review my test", enabled: true, busy: false, reason: "Pages that failed to upload won't be included. Retry them or remove them.", reasonTone: "quiet" };
  return { label: "Review my test", enabled: true, busy: false, reason: null, reasonTone: "quiet" };
}

/** The value at the end of the "Class" row. */
export function reviewClassValue(courseName: string): string {
  return courseName.trim() || "None";
}

export const REVIEW_QUESTION_MAX = 500;
export const REVIEW_QUESTION_EXAMPLE = "Why did I lose points on question 4?";

/** The line under "Ask about your test": the question as typed, or an example that is plainly an example. */
export function reviewQuestionDetail(question: string): string {
  return question.trim() || `Optional. For example: "${REVIEW_QUESTION_EXAMPLE}"`;
}

/** "120 of 500" under the question box. */
export function questionCountLine(chars: number): string {
  return `${chars} of ${REVIEW_QUESTION_MAX}`;
}

/** The result's headline: "4 mistakes to learn from", or "No marked mistakes found". */
export function reviewHeadline(mistakes: number): string {
  return mistakes > 0 ? `${count(mistakes, "mistake")} to learn from` : "No marked mistakes found";
}

export const NO_MISTAKES_BODY = "If you expected some, retake the photos with better light and the whole page in frame.";

/** "Score on the test: 78 of 100", only when the test shows one. */
export function reviewScoreLine(score: string | null | undefined): string | null {
  const text = (score ?? "").trim();
  return text ? `Score on the test: ${text}` : null;
}

/** The two things a review can say instead of reviewing. */
export function notReviewedTitle(status: "ungraded" | "unreadable"): string {
  return status === "ungraded" ? "This test isn't graded yet" : "We couldn't read those pages";
}

/**
 * A mistake's title from whatever the review calls the question: "4", "Q4", "#4" and "Question 4b" are all
 * "Question 4..."; a name of its own ("Problem 3", "Part B") is kept as it is.
 */
export function mistakeTitle(questionNumber: string): string {
  const cleaned = (questionNumber ?? "").trim().replace(/^(?:question\b|q(?=[\s.#:\d]))\s*[.#:]?\s*/i, "").replace(/^#\s*/, "").trim();
  if (!cleaned) return "A marked mistake";
  return /^\d/.test(cleaned) || cleaned.length <= 4 ? `Question ${cleaned}` : cleaned;
}

/** The course a review names, unless it is only the stand-in the server uses when it found none. */
export function reviewCourseLabel(courseTitle: string | null | undefined): string {
  const text = (courseTitle ?? "").trim();
  return text.toLowerCase() === "test review" ? "" : text;
}

export const REVIEW_RESET_COPY = {
  action: "Review another test",
  question: "Start a new review? This one is not saved, and its photos leave this screen.",
  confirm: "Start new",
  cancel: "Keep this one",
} as const;

/** What ai.reviewTest gives back (lib/study-parsers.ts). */
export interface TestReviewResult {
  gradedStatus: "graded" | "ungraded" | "unreadable";
  courseTitle: string;
  score: string;
  mistakes: { questionNumber: string; studentAnswer: string; correctAnswer: string; explanation: string; concept: string }[];
  conceptsToReview: string[];
  practiceProblems: { question: string; answer: string; concept: string }[];
  encouragement: string;
}

/** The review as plain text for the AI content report. */
export function reviewExcerpt(result: TestReviewResult): string {
  return [
    result.courseTitle,
    result.score ? `Score: ${result.score}` : "",
    result.encouragement,
    ...result.mistakes.slice(0, 5).map((m) => `Q${m.questionNumber} (${m.concept}): correct ${m.correctAnswer}. ${m.explanation}`),
    ...result.practiceProblems.slice(0, 3).map((p) => `Practice: ${p.question} Answer: ${p.answer}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Said on the screen when the camera was refused just now (the iPhone will ask again next time). */
export const CAMERA_REFUSED_NOTICE = "Allow camera access to add a photo of your test.";
